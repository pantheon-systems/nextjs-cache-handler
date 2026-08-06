import { Bucket, Storage } from '@google-cloud/storage';
import type { UseCacheEntry, UseCacheHandler, UseCacheStats, UseCacheEntryInfo } from './types.js';
import { serializeUseCacheEntry, deserializeUseCacheEntry } from '../../utils/stream-serialization.js';
import { createLogger } from '../../utils/logger.js';
import { getEnvironmentPrefix } from '../../utils/environment-prefix.js';
import { getBuildId } from '../../utils/build-detection.js';

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
  private readonly cachePrefix: string;
  private readonly tagsKey: string;
  // Resolved once per instance, not per call: getBuildId()'s last-resort
  // fallback (no .next/BUILD_ID or build-manifest.json present) is
  // `fallback-${Date.now()}`, which is NOT stable across separate calls --
  // comparing a fresh get()-time value against a fresh set()-time value would
  // spuriously mismatch even within the same build.
  private readonly buildId: string = getBuildId();
  private tagTimestamps: Map<string, number> = new Map();
  private initialized: boolean = false;
  private initPromise: Promise<void> | null = null;

  constructor() {
    const bucketName = process.env.CACHE_BUCKET;
    if (!bucketName) {
      throw new Error('CACHE_BUCKET environment variable is required for GCS cache handler');
    }

    const storage = new Storage();
    this.bucket = storage.bucket(bucketName);

    const envPrefix = getEnvironmentPrefix();
    this.cachePrefix = `${envPrefix}use-cache/`;
    this.tagsKey = `${this.cachePrefix}_tags.json`;

    // Initialize asynchronously but track the promise
    this.initPromise = this.initialize().catch(() => {});

    log.info('Initialized GCS use-cache handler');
  }

  private async initialize(): Promise<void> {
    if (this.initialized) return;
    await this.loadTagTimestamps();
    this.initialized = true;
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
      const parsed = JSON.parse(data.toString());
      // Merge with existing in-memory state (local updates take precedence)
      const loadedTimestamps = new Map<string, number>(Object.entries(parsed));
      for (const [tag, timestamp] of loadedTimestamps) {
        const existing = this.tagTimestamps.get(tag);
        if (!existing || timestamp > existing) {
          this.tagTimestamps.set(tag, timestamp);
        }
      }
    } catch (error) {
      log.warn('Error loading tag timestamps:', error);
      // Don't reset - keep existing in-memory state
    }
  }

  private async saveTagTimestamps(): Promise<void> {
    try {
      const obj = Object.fromEntries(this.tagTimestamps);
      const file = this.bucket.file(this.tagsKey);
      await file.save(JSON.stringify(obj, null, 2), {
        metadata: { contentType: 'application/json' },
      });
    } catch (error) {
      log.error('Error saving tag timestamps:', error);
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

    await this.saveTagTimestamps();
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

export default UseCacheGcsHandler;
