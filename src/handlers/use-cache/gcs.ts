import type { Bucket } from '@google-cloud/storage';
import type {
  SerializedUseCacheEntry,
  UseCacheEntry,
  UseCacheHandler,
  UseCacheStats,
  UseCacheEntryInfo,
} from './types.js';
import { serializeUseCacheEntry, deserializeUseCacheEntry } from '../../utils/stream-serialization.js';
import { getBuildStore } from './build-store.js';
import { getTagRevalidation } from '../../utils/tags-manifest.js';
import { toObjectName } from '../../utils/object-names.js';
import { resolveTagsRefreshIntervalMs } from '../../utils/shared-revalidations.js';
import { createLogger } from '../../utils/logger.js';
import { getEnvironmentPrefix } from '../../utils/environment-prefix.js';
import { getCacheGenerationId, isBuildPhase } from '../../utils/build-detection.js';
import { EdgeCacheClear, createEdgeCacheClearer } from '../../edge/edge-cache-clear.js';
import {
  getSharedStorage,
  readJsonObject,
  writeJsonObject,
  isPreconditionFailure,
  isNotFound,
  getErrorStatusCode,
} from '../../utils/gcs-json-object.js';

type TagTimestamps = Record<string, number>;
type StoredUseCacheEntry = SerializedUseCacheEntry & { __buildId?: string };

const DEFAULT_MEMORY_MB = 32;

/** In-process memory for use-cache entries, from CACHE_USE_CACHE_MEMORY_MB (default 32, 0 disables). */
export function resolveUseCacheMemoryBytes(raw: string | undefined = process.env.CACHE_USE_CACHE_MEMORY_MB): number {
  const parsed = raw === undefined || raw.trim() === '' ? NaN : Number(raw);
  const mb = Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_MEMORY_MB;
  return Math.floor(mb * 1024 * 1024);
}

/** Least-recently-used entries, bounded by the size of their stored JSON. */
class MemoryEntries {
  private readonly entries = new Map<string, { stored: StoredUseCacheEntry; bytes: number }>();
  private bytes = 0;

  constructor(private readonly maxBytes: number) {}

  get(key: string): StoredUseCacheEntry | undefined {
    const hit = this.entries.get(key);
    if (hit) {
      this.entries.delete(key);
      this.entries.set(key, hit);
    }
    return hit?.stored;
  }

  set(key: string, stored: StoredUseCacheEntry, bytes: number): void {
    this.delete(key);
    if (bytes > this.maxBytes) {
      return;
    }
    this.entries.set(key, { stored, bytes });
    this.bytes += bytes;
    for (const [oldest, { bytes: size }] of this.entries) {
      if (this.bytes <= this.maxBytes) {
        break;
      }
      this.entries.delete(oldest);
      this.bytes -= size;
    }
  }

  delete(key: string): void {
    const hit = this.entries.get(key);
    if (hit) {
      this.entries.delete(key);
      this.bytes -= hit.bytes;
    }
  }
}

const MAX_PRECONDITION_RETRIES = 3;
const PERSIST_BASE_BACKOFF_MS = 1000;
const PERSIST_MAX_BACKOFF_MS = 60_000;

interface BuildMeta {
  buildId: string;
  timestamp: number;
}

const log = createLogger('UseCacheGcsHandler');

/**
 * Google Cloud Storage cache handler for Next.js 16 'use cache' directive.
 * Implements the cacheHandlers (plural) interface.
 *
 * Suitable for:
 * - Production/Pantheon environments
 * - Multi-instance deployments requiring shared cache
 */
export class UseCacheGcsHandler implements UseCacheHandler {
  private readonly bucket: Bucket;
  private readonly tagsBucket: Bucket;
  private readonly cachePrefix: string;
  private readonly tagsKey: string;
  // Resolved once per instance, not per call: getCacheGenerationId()'s last-resort
  // fallback (no .next/BUILD_ID or build-manifest.json present) is
  // `fallback-${Date.now()}`, which is NOT stable across separate calls --
  // comparing a fresh get()-time value against a fresh set()-time value would
  // spuriously mismatch even within the same build.
  // Holds the generation ID; the `buildId`/`__buildId` field names are kept.
  private readonly buildId: string = getCacheGenerationId();
  private readonly buildMetaKey: string;
  private readonly edgeCacheClearer: EdgeCacheClear | null;
  private tagTimestamps: Map<string, number> = new Map();
  // Per process. A memory hit resolves in a microtask; a GCS read would outlast the
  // one task Next's cached-navigations render waits before its dynamic stage, so the
  // result would miss the static stage the client reuses.
  private readonly memory: MemoryEntries;
  // Background reloads of tagTimestamps (see refreshTags).
  private readonly tagsRefreshIntervalMs = resolveTagsRefreshIntervalMs();
  private tagsReload: Promise<void> | null = null;
  private nextTagsReloadAt = 0;
  private initialized: boolean = false;
  private initPromise: Promise<void> | null = null;

  // Serialized, generation-checked persistence of tagTimestamps (see persistTagTimestamps).
  private persistPromise: Promise<boolean> | null = null;
  private persistDirty = false;
  private persistBlockedUntil = 0;
  private persistFailures = 0;
  private persistRetryTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(config: { memoryMb?: number } = {}) {
    const bucketName = process.env.CACHE_BUCKET;
    if (!bucketName) {
      throw new Error('CACHE_BUCKET environment variable is required for GCS cache handler');
    }
    this.memory = new MemoryEntries(
      resolveUseCacheMemoryBytes(config.memoryMb === undefined ? undefined : String(config.memoryMb))
    );

    // Two clients on purpose: unconditional entry writes disable retries on
    // their client's shared state, which must not leak into tag writes.
    this.bucket = getSharedStorage(bucketName, 'entries').bucket(bucketName);
    this.tagsBucket = getSharedStorage(bucketName, 'tags').bucket(bucketName);

    const envPrefix = getEnvironmentPrefix();
    this.cachePrefix = `${envPrefix}use-cache/`;
    this.tagsKey = `${this.cachePrefix}_tags.json`;
    this.buildMetaKey = `${this.cachePrefix}_build-meta.json`;

    this.edgeCacheClearer = createEdgeCacheClearer();

    // Initialize asynchronously but track the promise
    this.initPromise = this.initialize().catch(() => {});

    log.info('Created GCS use-cache handler');
  }

  private async initialize(): Promise<void> {
    if (this.initialized) return;
    await this.loadTagTimestamps();
    // Unlike the per-entry __buildId check in get() (which only rejects a
    // stale read once something happens to touch that specific entry), this
    // proactively purges the EDGE cache the moment a new build is detected --
    // without it, a page rendered via 'use cache' can keep being served stale
    // from the CDN edge indefinitely after a redeploy, since nothing else in
    // this handler ever tells Fastly to drop its copy.
    // Not during `next build`: the new generation is recorded, and the CDN
    // purged, by the runtime that serves it (as in the route handler).
    if (!isBuildPhase()) {
      await this.checkBuildInvalidation();
    }
    this.initialized = true;
  }

  private async checkBuildInvalidation(): Promise<void> {
    const file = this.bucket.file(this.buildMetaKey);

    // undefined: none stored. Not valid JSON: an unknown previous generation.
    let previousBuildId: string | undefined;
    try {
      const [data] = await file.download();
      try {
        previousBuildId = (JSON.parse(data.toString()) as BuildMeta).buildId;
      } catch {
        log.warn('Stored build metadata is not valid JSON; treating it as a different build');
        previousBuildId = '';
      }
    } catch (error) {
      if (!isNotFound(error)) {
        // Not a first run: leave the check, and _build-meta.json, to the retry.
        log.warn('Could not read build metadata; the build check is retried on the next cache read or write:', error);
        throw error;
      }
    }

    if (previousBuildId !== undefined && previousBuildId !== this.buildId) {
      log.info(`New build detected (${previousBuildId || '(unreadable)'} -> ${this.buildId}), clearing edge cache`);

      // Awaited, not the usual fire-and-forget nukeCacheInBackground used
      // for ordinary tag revalidation elsewhere: get()/set() block on
      // initPromise (via ensureInitialized()) before touching the store,
      // so this guarantees the purge request has been issued before this
      // process starts serving real traffic. Bounded by nukeCache()'s own
      // internal timeout.
      if (this.edgeCacheClearer) {
        const result = await this.edgeCacheClearer.nukeCache();
        if (!result.success) {
          log.warn(`Edge cache purge on build invalidation failed: ${result.error}`);
        }
      }
    }

    try {
      await file.save(JSON.stringify({ buildId: this.buildId, timestamp: Date.now() }), {
        resumable: false,
        metadata: { contentType: 'application/json' },
      });
    } catch (error) {
      log.warn('Error writing build meta:', error);
    }
  }

  private async ensureInitialized(): Promise<void> {
    // A failed initialize() (the build metadata couldn't be read) is retried.
    if (!this.initialized && !this.initPromise) {
      this.initPromise = this.initialize().catch(() => {});
    }
    if (this.initPromise) {
      await this.initPromise;
      this.initPromise = null;
    }
  }

  private async loadTagTimestamps(): Promise<void> {
    try {
      const file = this.bucket.file(this.tagsKey);
      const [exists] = await file.exists();

      if (!exists) {
        // Only reset if not already populated by local operations
        if (this.tagTimestamps.size === 0) {
          this.tagTimestamps = new Map();
        }
        return;
      }

      const [data] = await file.download();
      this.mergeTagTimestamps(JSON.parse(data.toString()));
    } catch (error) {
      log.warn('Error loading tag timestamps:', error);
      // Don't reset - keep existing in-memory state
    }
  }

  /** Merge stored timestamps into memory, keeping the newer value per tag. */
  private mergeTagTimestamps(stored: TagTimestamps): void {
    for (const [tag, timestamp] of Object.entries(stored)) {
      const existing = this.tagTimestamps.get(tag);
      if (!existing || timestamp > existing) {
        this.tagTimestamps.set(tag, timestamp);
      }
    }
  }

  /**
   * Persist tagTimestamps. Stays synchronous with updateTags() (other instances
   * read it via refreshTags()), but serialized so bursts coalesce into one write,
   * and generation-checked so instances merge. Failures retry in the background.
   */
  private async persistTagTimestamps(): Promise<void> {
    this.persistDirty = true;

    for (;;) {
      if (this.persistPromise) {
        await this.persistPromise;
        if (!this.persistDirty) {
          return;
        }
        continue;
      }

      if (!this.persistDirty || Date.now() < this.persistBlockedUntil) {
        return;
      }

      this.persistPromise = this.doPersistTagTimestamps().finally(() => {
        this.persistPromise = null;
      });
      const ok = await this.persistPromise;
      if (!ok) {
        return;
      }
    }
  }

  private async doPersistTagTimestamps(): Promise<boolean> {
    this.persistDirty = false;

    try {
      for (let attempt = 0; ; attempt++) {
        const { value: stored, generation } = await readJsonObject<TagTimestamps>(this.tagsBucket, this.tagsKey);
        if (stored) {
          this.mergeTagTimestamps(stored);
        }

        const merged = Object.fromEntries(this.tagTimestamps);
        if (stored && sameTimestamps(stored, merged)) {
          break;
        }

        try {
          await writeJsonObject(this.tagsBucket, this.tagsKey, merged, generation);
          break;
        } catch (error) {
          if (isPreconditionFailure(error) && attempt < MAX_PRECONDITION_RETRIES) {
            log.debug(`Tag timestamps changed underneath us (generation ${generation}), re-reading`);
            continue;
          }
          throw error;
        }
      }

      if (this.persistFailures > 0) {
        log.warn(`Tag timestamps write recovered after ${this.persistFailures} failed attempt(s)`);
        this.persistFailures = 0;
      }
      return true;
    } catch (error) {
      this.persistDirty = true;
      this.persistFailures++;

      const base = Math.min(PERSIST_BASE_BACKOFF_MS * 2 ** this.persistFailures, PERSIST_MAX_BACKOFF_MS);
      const delay = Math.round(base * (0.75 + Math.random() * 0.25));
      this.persistBlockedUntil = Date.now() + delay;

      const code = getErrorStatusCode(error);
      const reason = code === 429 ? 'rate limited (429)' : code ? `HTTP ${code}` : 'error';
      if (this.persistFailures === 1) {
        log.warn(`Tag timestamps write failed (${reason}); retrying in ${delay}ms`, error);
      } else {
        log.debug(
          `Tag timestamps write failed again (${reason}, attempt ${this.persistFailures}), retrying in ${delay}ms`
        );
      }

      if (!this.persistRetryTimer) {
        this.persistRetryTimer = setTimeout(() => {
          this.persistRetryTimer = null;
          this.persistTagTimestamps().catch((e) => log.error('Tag timestamps retry failed:', e));
        }, delay);
        this.persistRetryTimer.unref?.();
      }
      return false;
    }
  }

  private getCacheKey(cacheKey: string): string {
    // Sanitize cache key for GCS object naming
    return `${this.cachePrefix}${toObjectName(cacheKey)}.json`;
  }

  /**
   * When `tag` was last invalidated, as far as this process knows (0 if never):
   * the later of the timestamps this handler loaded and the revalidations in
   * Next's tagsManifest. The route cache handler mirrors every revalidation it
   * reads from other instances into that manifest, so a render it triggers
   * cannot reuse a 'use cache' value older than a revalidation it knows of,
   * whatever the background reload of tagTimestamps has reached. Memory only,
   * so reads stay within the static stage.
   */
  private invalidatedAt(tag: string): number {
    const known = this.tagTimestamps.get(tag) ?? 0;
    const revalidation = getTagRevalidation(tag);
    if (!revalidation) {
      return known;
    }
    // A soft revalidation's `expired` is in the future; the moment it happened is `stale`.
    const now = Date.now();
    return [known, revalidation.stale, revalidation.expired].reduce<number>(
      (latest, at) => (at !== undefined && at <= now && at > latest ? at : latest),
      0
    );
  }

  /**
   * Check if an entry is expired based on revalidate time.
   */
  private isExpired(entry: UseCacheEntry): boolean {
    const now = Date.now();
    const age = now - entry.timestamp;
    const revalidateMs = entry.revalidate * 1000;

    // Entry is expired if it's older than revalidate time
    if (age > revalidateMs) {
      return true;
    }

    // Also check if any of the entry's tags have been invalidated
    for (const tag of entry.tags) {
      const tagTimestamp = this.invalidatedAt(tag);
      if (tagTimestamp && tagTimestamp > entry.timestamp) {
        return true;
      }
    }

    return false;
  }

  /**
   * Retrieve a cache entry.
   */
  async get(cacheKey: string, softTags: string[]): Promise<UseCacheEntry | undefined> {
    log.debug(`GET: ${cacheKey}`);

    // A build uses Next's per-process store (see getBuildStore), never the
    // shared one, so it cannot read or delete entries the live revision serves.
    if (isBuildPhase()) {
      return getBuildStore().get(cacheKey, softTags);
    }

    // Tag timestamps are loaded asynchronously in the constructor; without this,
    // a request racing the very first GET on a cold instance could read an
    // empty tagTimestamps map and treat a tag-invalidated entry as still fresh.
    await this.ensureInitialized();

    // Same expiry checks as a GCS hit: tag timestamps are refreshed per request
    // (refreshTags), and an entry another instance rewrites is only rewritten
    // once it has expired, which this check also sees.
    const remembered = this.memory.get(cacheKey);
    if (remembered) {
      const entry = deserializeUseCacheEntry(remembered);
      if (!this.isExpired(entry)) {
        log.debug(`HIT (memory): ${cacheKey}`);
        return entry;
      }
      this.memory.delete(cacheKey);
    }

    try {
      const gcsKey = this.getCacheKey(cacheKey);
      const file = this.bucket.file(gcsKey);

      const [exists] = await file.exists();
      if (!exists) {
        log.debug(`MISS: ${cacheKey} (not found)`);
        return undefined;
      }

      const [data] = await file.download();
      const stored: StoredUseCacheEntry = JSON.parse(data.toString());

      // An entry written by a different build must never be served as current:
      // this store is keyed by cache key + environment only (no build scoping),
      // and Pantheon Multidev environments are reused/redeployed in place, so a
      // stale build's entry would otherwise be indistinguishable from a fresh
      // one whenever revalidate/tags never touch it. Entries written before this
      // check existed have no `__buildId` and are treated as valid (no forced
      // mass-invalidation on rollout).
      if (stored.__buildId && stored.__buildId !== this.buildId) {
        log.debug(`MISS: ${cacheKey} (stale build: ${stored.__buildId} != ${this.buildId})`);
        try {
          await file.delete();
        } catch {
          // Ignore deletion errors
        }
        return undefined;
      }

      const entry = deserializeUseCacheEntry(stored);

      // Check expiration
      if (this.isExpired(entry)) {
        log.debug(`MISS: ${cacheKey} (expired)`);
        // Optionally delete expired entry
        try {
          await file.delete();
        } catch {
          // Ignore deletion errors
        }
        return undefined;
      }

      log.debug(`HIT: ${cacheKey}`);
      this.memory.set(cacheKey, stored, data.length);

      return entry;
    } catch (error) {
      log.error(`Error reading cache for key ${cacheKey}:`, error);
      return undefined;
    }
  }

  /**
   * Store a cache entry.
   * CRITICAL: Must await pendingEntry before storing.
   */
  async set(cacheKey: string, pendingEntry: Promise<UseCacheEntry>): Promise<void> {
    log.debug(`SET: ${cacheKey}`);

    // Build-time results must not reach runtime reads: Next serves them through
    // prerender output, and a dynamic route expects a fresh render.
    if (isBuildPhase()) {
      return getBuildStore().set(cacheKey, pendingEntry);
    }

    await this.ensureInitialized();

    try {
      // CRITICAL: Await the pending entry
      const entry = await pendingEntry;

      // No tags is normal for a function without cacheTag(), and also what
      // Next.js sends when it drops them (https://github.com/vercel/next.js/issues/78864).
      if ((entry.tags?.length ?? 0) === 0) {
        log.debug(`SET ${cacheKey}: no tags (none declared, or not passed on by Next.js)`);
      }

      const serialized = await serializeUseCacheEntry(entry);
      // __buildId is our own addition (not part of SerializedUseCacheEntry) --
      // see the matching check in get().
      const withBuildId = { ...serialized, __buildId: this.buildId };
      const gcsKey = this.getCacheKey(cacheKey);
      const file = this.bucket.file(gcsKey);
      const json = JSON.stringify(withBuildId);

      // Before the write, so a read racing it is already served from memory.
      // Sized in bytes, as get() sizes what it reads.
      this.memory.set(cacheKey, withBuildId, Buffer.byteLength(json));
      try {
        await file.save(json, {
          resumable: false,
          metadata: { contentType: 'application/json' },
        });
      } catch (error) {
        // No other instance will have this value, so don't keep serving it here.
        this.memory.delete(cacheKey);
        throw error;
      }

      log.debug(`Cached ${cacheKey} with ${entry.tags?.length ?? 0} tags`);
    } catch (error) {
      log.error(`Error setting cache for key ${cacheKey}:`, error);
    }
  }

  /**
   * Synchronize tag state from external source: reload tag timestamps from GCS
   * in the background, at most once per CACHE_TAGS_REFRESH_INTERVAL_MS.
   *
   * Next awaits this before a request's first 'use cache' read, inside its
   * staged render, and with cached navigations the static stage ends after one
   * task. Awaiting GCS here pushed every cached result out of the static stage,
   * so the client could not reuse it. A tag revalidated on another instance
   * therefore reaches this one's reads within about one interval; this
   * instance's own updateTags() applies at once. The reload starts inside the
   * request that triggered it, which has CPU.
   */
  async refreshTags(): Promise<void> {
    if (this.tagsReload || Date.now() < this.nextTagsReloadAt) {
      return;
    }
    log.debug('REFRESH TAGS');
    this.nextTagsReloadAt = Date.now() + this.tagsRefreshIntervalMs;
    this.tagsReload = this.loadTagTimestamps().finally(() => {
      this.tagsReload = null;
    });
  }

  /**
   * Return maximum revalidation timestamp for given tags. Next.js 16 passes
   * an array; Next.js 15 spreads the tags as arguments.
   */
  async getExpiration(...args: (string | string[])[]): Promise<number> {
    const tags = args.flat();
    let maxTimestamp = 0;

    for (const tag of tags) {
      const timestamp = this.invalidatedAt(tag);
      if (timestamp > maxTimestamp) {
        maxTimestamp = timestamp;
      }
    }

    log.debug(`GET EXPIRATION for [${tags.join(', ')}]: ${maxTimestamp}`);
    return maxTimestamp;
  }

  /** Next.js 15's name for {@link updateTags}, with the tags spread as arguments. */
  async expireTags(...tags: string[]): Promise<void> {
    await this.updateTags(tags, []);
  }

  /**
   * Invalidate cache entries with matching tags.
   *
   * Updates tag timestamps so that subsequent get() calls for entries
   * with these tags will return undefined (expired). CDN path-based
   * purging is handled by the legacy cacheHandler which maintains the
   * tag-to-path mapping — the use-cache handler only caches function
   * return values (opaque keys), not URL-addressable pages.
   */
  async updateTags(tags: string[], durations: number[]): Promise<void> {
    log.debug(`UPDATE TAGS: [${tags.join(', ')}]`);

    if (tags.length === 0) {
      return;
    }

    const now = Date.now();

    for (const tag of tags) {
      this.tagTimestamps.set(tag, now);
    }

    await this.persistTagTimestamps();
    log.debug(`Updated ${tags.length} tag timestamps`);
  }

  /**
   * Get cache statistics for the use-cache entries in GCS.
   * Returns information about all valid (non-expired) cache entries.
   */
  async getStats(): Promise<UseCacheStats> {
    log.debug('GET STATS');

    const entries: UseCacheEntryInfo[] = [];
    const keys: string[] = [];

    try {
      await this.ensureInitialized();

      // List all files in the use-cache prefix
      const [files] = await this.bucket.getFiles({ prefix: this.cachePrefix });

      for (const file of files) {
        // Skip tags file
        if (file.name === this.tagsKey) {
          continue;
        }

        // Only process .json files
        if (!file.name.endsWith('.json')) {
          continue;
        }

        try {
          const [data] = await file.download();
          const stored = JSON.parse(data.toString());

          // Extract key from filename (remove prefix and .json suffix)
          const key = file.name.replace(this.cachePrefix, '').replace('.json', '');

          // Deserialize to check expiration
          const entry = deserializeUseCacheEntry(stored);

          // Skip expired entries
          if (this.isExpired(entry)) {
            continue;
          }

          // Get file metadata for size
          const [metadata] = await file.getMetadata();

          const entryInfo: UseCacheEntryInfo = {
            key,
            tags: stored.tags || [],
            type: 'use-cache',
            lastModified: new Date(entry.timestamp).toISOString(),
            size: Number(metadata.size) || 0,
            revalidate: entry.revalidate,
            stale: entry.stale,
            expire: entry.expire,
          };

          entries.push(entryInfo);
          keys.push(key);
        } catch (error) {
          log.warn(`Error reading cache file ${file.name}:`, error);
        }
      }
    } catch (error) {
      log.error('Error getting cache stats:', error);
    }

    log.debug(`Found ${entries.length} valid cache entries`);

    return {
      size: entries.length,
      entries,
      keys,
    };
  }
}

function sameTimestamps(a: TagTimestamps, b: TagTimestamps): boolean {
  const aKeys = Object.keys(a);
  if (aKeys.length !== Object.keys(b).length) {
    return false;
  }
  return aKeys.every((tag) => a[tag] === b[tag]);
}

export default UseCacheGcsHandler;
