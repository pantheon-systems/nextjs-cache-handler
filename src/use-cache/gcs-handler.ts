import { Bucket, Storage } from '@google-cloud/storage';
import type { UseCacheEntry, UseCacheHandler, UseCacheStats, UseCacheEntryInfo } from './types.js';
import {
  serializeUseCacheEntry,
  deserializeUseCacheEntry,
} from './stream-serialization.js';
import { createLogger } from '../utils/logger.js';
import { createEdgeCacheClearer, type EdgeCacheClear } from '../edge/edge-cache-clear.js';

const log = createLogger('UseCacheGcsHandler');

/**
 * Next.js internal prefix for path-based cache tags.
 * When revalidatePath('/api/foo') is called, Next.js internally calls
 * revalidateTag('_N_T_/api/foo'). This prefix identifies path tags.
 */
const NEXTJS_PATH_TAG_PREFIX = '_N_T_';

/**
 * Symbol used to access CacheTagContext from globalThis.
 * This matches the Symbol.for pattern used by Next.js for @next/request-context.
 */
const CACHE_TAG_CONTEXT_SYMBOL = Symbol.for('@nextjs-cache-handler/tag-context');

/**
 * Symbol used to expose registerPathTags on globalThis.
 * This allows withSurrogateKey (which knows the request path and captured tags)
 * to register path→surrogate-key mappings without a direct module import.
 */
const PATH_TAGS_REGISTRY_SYMBOL = Symbol.for('@nextjs-cache-handler/path-tags-registry');

interface CacheTagContextData {
  tags: string[];
  requestId: string;
  startTime: number;
}

interface CacheTagContextAccessor {
  get(): CacheTagContextData | undefined;
}

/**
 * Access the CacheTagContext via globalThis using Symbol.for.
 * This allows cross-context access without direct module imports.
 */
function getCacheTagContext(): CacheTagContextData | undefined {
  const accessor = (globalThis as Record<symbol, unknown>)[CACHE_TAG_CONTEXT_SYMBOL] as
    | CacheTagContextAccessor
    | undefined;
  return accessor?.get();
}

/**
 * Add tags to the CacheTagContext if available.
 * Falls back to global store if CacheTagContext is not active.
 */
function captureTags(tags: string[]): { captured: boolean; source: string } {
  if (tags.length === 0) {
    return { captured: false, source: 'none' };
  }

  // Primary: Try CacheTagContext (Symbol.for pattern)
  const context = getCacheTagContext();
  if (context) {
    context.tags.push(...tags);
    log.debug(`Captured ${tags.length} tags via CacheTagContext: ${tags.join(', ')}`);
    return { captured: true, source: 'CacheTagContext' };
  }

  // Fallback: Use global store (for environments where Symbol.for doesn't propagate)
  let globalTags = (globalThis as Record<string, unknown>).__pantheonSurrogateKeyTags as
    | string[]
    | undefined;
  if (!globalTags) {
    globalTags = [];
    (globalThis as Record<string, unknown>).__pantheonSurrogateKeyTags = globalTags;
  }
  globalTags.push(...tags);
  log.debug(`Captured ${tags.length} tags via globalStore fallback: ${tags.join(', ')}`);
  return { captured: true, source: 'globalStore' };
}

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
  private pathToSurrogateKeys: Map<string, string[]> = new Map();
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

    // Expose registerPathTags on globalThis so withSurrogateKey can register
    // path→surrogate-key mappings without direct module coupling
    (globalThis as Record<symbol, unknown>)[PATH_TAGS_REGISTRY_SYMBOL] =
      (path: string, tags: string[]) => this.registerPathTags(path, tags);

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
   * Check if an entry is expired based on expire time.
   */
  private isExpired(entry: UseCacheEntry): boolean {
    const now = Date.now();
    const age = now - entry.timestamp;
    const expireMs = entry.expire * 1000;

    // Entry is expired if it's older than expire time
    if (age > expireMs) {
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
      // Uses Symbol.for pattern to access PantheonContext across async boundaries
      const storedTags = entry.tags ?? [];
      const { captured, source } = captureTags(storedTags);

      if (captured) {
        log.debug(`HIT ${cacheKey}: Captured ${storedTags.length} tags via ${source}`);
      } else if (storedTags.length === 0) {
        // TODO: Remove this diagnostic logging once Next.js fixes the empty tags bug
        // See: https://github.com/vercel/next.js/issues/78864
        log.info(`HIT ${cacheKey}: No tags to capture (Next.js empty tags bug)`);
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
   * Register the surrogate keys (explicit cacheTag values) associated with a path.
   * Called by withSurrogateKey when tags are captured during a cache HIT,
   * enabling revalidatePath to resolve the correct CDN surrogate keys.
   */
  registerPathTags(path: string, surrogateKeys: string[]): void {
    this.pathToSurrogateKeys.set(path, surrogateKeys);
    log.debug(`Registered path tags: ${path} → [${surrogateKeys.join(', ')}]`);
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
      // Separate explicit tags from _N_T_ path tags
      const explicitTags: string[] = [];
      const pathTags: string[] = [];

      for (const tag of tags) {
        if (tag.startsWith(NEXTJS_PATH_TAG_PREFIX)) {
          pathTags.push(tag);
        } else {
          explicitTags.push(tag);
        }
      }

      // Purge explicit tags as surrogate keys (these match CDN Surrogate-Key headers directly)
      if (explicitTags.length > 0) {
        this.edgeCacheClearer.clearKeysInBackground(explicitTags, `use-cache tag invalidation: ${explicitTags.join(', ')}`);
      }

      // Resolve _N_T_ path tags to surrogate keys via the registered mapping
      if (pathTags.length > 0) {
        const resolvedKeys: string[] = [];
        const unresolvedPaths: string[] = [];

        for (const pathTag of pathTags) {
          const path = pathTag.substring(NEXTJS_PATH_TAG_PREFIX.length);
          const surrogateKeys = this.pathToSurrogateKeys.get(path);

          if (surrogateKeys && surrogateKeys.length > 0) {
            resolvedKeys.push(...surrogateKeys);
            log.debug(`Resolved path tag ${pathTag} → surrogate keys: [${surrogateKeys.join(', ')}]`);
          } else {
            unresolvedPaths.push(path);
            log.debug(`No surrogate key mapping for path tag ${pathTag}, falling back to path purge`);
          }
        }

        // Purge resolved surrogate keys
        if (resolvedKeys.length > 0) {
          this.edgeCacheClearer.clearKeysInBackground(resolvedKeys, `path revalidation (resolved): ${resolvedKeys.join(', ')}`);
        }

        // Fallback: attempt path-based purge for unmapped paths
        if (unresolvedPaths.length > 0) {
          this.edgeCacheClearer.clearPathsInBackground(unresolvedPaths, `path revalidation (fallback): ${unresolvedPaths.join(', ')}`);
        }
      }
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
