import type { Bucket } from '@google-cloud/storage';
import type { UseCacheEntry, UseCacheHandler, UseCacheStats, UseCacheEntryInfo } from './types.js';
import { serializeUseCacheEntry, deserializeUseCacheEntry } from '../../utils/stream-serialization.js';
import { createLogger } from '../../utils/logger.js';
import { getEnvironmentPrefix } from '../../utils/environment-prefix.js';
import { getBuildId } from '../../utils/build-detection.js';
import { EdgeCacheClear, createEdgeCacheClearer } from '../../edge/edge-cache-clear.js';
import {
  getSharedStorage,
  readJsonObject,
  writeJsonObject,
  isPreconditionFailure,
  getErrorStatusCode,
} from '../../utils/gcs-json-object.js';

type TagTimestamps = Record<string, number>;

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
  // Resolved once per instance, not per call: getBuildId()'s last-resort
  // fallback (no .next/BUILD_ID or build-manifest.json present) is
  // `fallback-${Date.now()}`, which is NOT stable across separate calls --
  // comparing a fresh get()-time value against a fresh set()-time value would
  // spuriously mismatch even within the same build.
  private readonly buildId: string = getBuildId();
  private readonly buildMetaKey: string;
  private readonly edgeCacheClearer: EdgeCacheClear | null;
  private tagTimestamps: Map<string, number> = new Map();
  private initialized: boolean = false;
  private initPromise: Promise<void> | null = null;

  // Serialized, generation-checked persistence of tagTimestamps (see persistTagTimestamps).
  private persistPromise: Promise<boolean> | null = null;
  private persistDirty = false;
  private persistBlockedUntil = 0;
  private persistFailures = 0;
  private persistRetryTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    const bucketName = process.env.CACHE_BUCKET;
    if (!bucketName) {
      throw new Error('CACHE_BUCKET environment variable is required for GCS cache handler');
    }

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

    log.info('Initialized GCS use-cache handler');
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
    await this.checkBuildInvalidation();
    this.initialized = true;
  }

  private async checkBuildInvalidation(): Promise<void> {
    const file = this.bucket.file(this.buildMetaKey);

    try {
      const [exists] = await file.exists();
      if (exists) {
        const [data] = await file.download();
        const meta: BuildMeta = JSON.parse(data.toString());

        if (meta.buildId && meta.buildId !== this.buildId) {
          log.info(`New build detected (${meta.buildId} -> ${this.buildId}), clearing edge cache`);

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
      }
    } catch (error) {
      log.warn('Error checking build invalidation:', error);
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
    const safeKey = cacheKey.replace(/[^a-zA-Z0-9-]/g, '_');
    return `${this.cachePrefix}${safeKey}.json`;
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
      const tagTimestamp = this.tagTimestamps.get(tag);
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

    // Tag timestamps are loaded asynchronously in the constructor; without this,
    // a request racing the very first GET on a cold instance could read an
    // empty tagTimestamps map and treat a tag-invalidated entry as still fresh.
    await this.ensureInitialized();

    try {
      const gcsKey = this.getCacheKey(cacheKey);
      const file = this.bucket.file(gcsKey);

      const [exists] = await file.exists();
      if (!exists) {
        log.debug(`MISS: ${cacheKey} (not found)`);
        return undefined;
      }

      const [data] = await file.download();
      const stored = JSON.parse(data.toString());

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

    await this.ensureInitialized();

    try {
      // CRITICAL: Await the pending entry
      const entry = await pendingEntry;

      // Known Next.js bug: cacheTag() values not propagated to cacheHandlers.set()
      // See: https://github.com/vercel/next.js/issues/78864
      if ((entry.tags?.length ?? 0) === 0) {
        log.warn(`SET ${cacheKey}: empty tags array (known Next.js bug)`);
      }

      const serialized = await serializeUseCacheEntry(entry);
      // __buildId is our own addition (not part of SerializedUseCacheEntry) --
      // see the matching check in get().
      const withBuildId = { ...serialized, __buildId: this.buildId };
      const gcsKey = this.getCacheKey(cacheKey);
      const file = this.bucket.file(gcsKey);

      await file.save(JSON.stringify(withBuildId, null, 2), {
        resumable: false,
        metadata: { contentType: 'application/json' },
      });

      log.debug(`Cached ${cacheKey} with ${entry.tags?.length ?? 0} tags`);
    } catch (error) {
      log.error(`Error setting cache for key ${cacheKey}:`, error);
    }
  }

  /**
   * Synchronize tag state from external source.
   * Reloads tag timestamps from GCS.
   */
  async refreshTags(): Promise<void> {
    log.debug('REFRESH TAGS');
    await this.loadTagTimestamps();
  }

  /**
   * Return maximum revalidation timestamp for given tags.
   */
  async getExpiration(tags: string[]): Promise<number> {
    let maxTimestamp = 0;

    for (const tag of tags) {
      const timestamp = this.tagTimestamps.get(tag) ?? 0;
      if (timestamp > maxTimestamp) {
        maxTimestamp = timestamp;
      }
    }

    log.debug(`GET EXPIRATION for [${tags.join(', ')}]: ${maxTimestamp}`);
    return maxTimestamp;
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
