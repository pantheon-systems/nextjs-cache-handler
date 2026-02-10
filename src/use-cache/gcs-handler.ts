import { Bucket, Storage } from '@google-cloud/storage';
import type { UseCacheEntry, UseCacheHandler, UseCacheStats, UseCacheEntryInfo } from './types.js';
import {
  serializeUseCacheEntry,
  deserializeUseCacheEntry,
} from './stream-serialization.js';
import { createLogger } from '../utils/logger.js';
import { RequestContext } from '../utils/request-context.js';
import { createEdgeCacheClearer, type EdgeCacheClear } from '../edge/edge-cache-clear.js';

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
  private readonly edgeCacheClearer: EdgeCacheClear | null;
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

    this.cachePrefix = 'use-cache/';
    this.tagsKey = `${this.cachePrefix}_tags.json`;

    this.edgeCacheClearer = createEdgeCacheClearer();

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

      // Capture tags for Surrogate-Key header propagation
      const storedTagsLength = entry.tags?.length ?? 0;
      const contextActive = RequestContext.isActive();

      if (storedTagsLength > 0 && contextActive) {
        RequestContext.addTags(entry.tags);
        log.debug(`Captured ${storedTagsLength} tags for Surrogate-Key: ${entry.tags.join(', ')}`);
      } else {
        // TODO: Remove this diagnostic logging once Next.js fixes the empty tags bug
        // See: https://github.com/vercel/next.js/issues/78864
        // Log why tags weren't propagated
        log.info(`GET ${cacheKey} - Tag propagation status:`, {
          storedTags: entry.tags,
          storedTagsLength,
          requestContextActive: contextActive,
          reason: storedTagsLength === 0
            ? 'No tags stored (Next.js empty tags bug)'
            : 'RequestContext not active'
        });
      }

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

    try {
      // CRITICAL: Await the pending entry
      const entry = await pendingEntry;

      // TODO: Remove this diagnostic logging once Next.js fixes the empty tags bug
      // Diagnostic logging for empty tags issue
      // See: https://github.com/vercel/next.js/issues/78864
      // See: docs/known-issues-nextjs16.md
      const tagsLength = entry.tags?.length ?? 0;
      if (tagsLength === 0) {
        // Use info level so this is gated behind CACHE_DEBUG
        log.info(`[EMPTY_TAGS_BUG] SET ${cacheKey}: Next.js passed empty tags array. ` +
          `This is a known Next.js bug - cacheTag() values are not propagated to cacheHandlers.set(). ` +
          `See: https://github.com/vercel/next.js/issues/78864`);
      }
      log.info(`SET entry structure for ${cacheKey}:`, {
        hasTags: !!entry.tags,
        tags: entry.tags,
        tagsLength,
        stale: entry.stale,
        revalidate: entry.revalidate,
        expire: entry.expire,
        timestamp: entry.timestamp,
        hasValue: !!entry.value,
        entryKeys: Object.keys(entry),
      });

      const serialized = await serializeUseCacheEntry(entry);
      const gcsKey = this.getCacheKey(cacheKey);
      const file = this.bucket.file(gcsKey);

      await file.save(JSON.stringify(serialized, null, 2), {
        metadata: { contentType: 'application/json' },
      });

      log.debug(`Cached ${cacheKey}`);
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

    // Clear edge cache if configured
    if (this.edgeCacheClearer) {
      this.edgeCacheClearer.clearKeysInBackground(tags, `use-cache tag invalidation: ${tags.join(', ')}`);
    }
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
