// ============================================================================
// Next.js 16 'use cache' Handler Types
// ============================================================================
// These types implement the cacheHandlers (plural) interface for the
// 'use cache' directive introduced in Next.js 16.
// See: https://nextjs.org/docs/app/api-reference/config/next-config-js/cacheHandlers
// ============================================================================

/**
 * Cache entry structure for 'use cache' directive.
 *
 * Key differences from the legacy cacheHandler interface:
 * - value is a ReadableStream<Uint8Array> instead of a serializable object
 * - Includes timing metadata: stale, expire, revalidate
 * - timestamp is in milliseconds (creation time)
 */
export interface UseCacheEntry {
  /**
   * The cached value as a stream.
   * Must be consumed or tee()'d if needed for multiple reads.
   */
  value: ReadableStream<Uint8Array>;

  /**
   * Cache tags for on-demand revalidation.
   * Used with cacheTag() and revalidateTag().
   */
  tags: string[];

  /**
   * Duration in seconds for client-side staleness.
   * Controls how long the entry can be served as stale while revalidating.
   */
  stale: number;

  /**
   * Creation timestamp in milliseconds.
   * Used to determine cache age.
   */
  timestamp: number;

  /**
   * How long (in seconds) the entry is allowed to be used.
   * After this time, the entry should not be served.
   */
  expire: number;

  /**
   * How long (in seconds) until the entry should be revalidated.
   * After this time, the entry is considered stale but may still be served.
   */
  revalidate: number;
}

/**
 * Serialized format for storing UseCacheEntry to persistent storage.
 * The ReadableStream is converted to a base64 string.
 */
export interface SerializedUseCacheEntry {
  /**
   * Base64-encoded bytes from the stream.
   */
  value: string;

  /**
   * Cache tags for on-demand revalidation.
   */
  tags: string[];

  /**
   * Duration in seconds for client-side staleness.
   */
  stale: number;

  /**
   * Creation timestamp in milliseconds.
   */
  timestamp: number;

  /**
   * How long (in seconds) the entry is allowed to be used.
   */
  expire: number;

  /**
   * How long (in seconds) until the entry should be revalidated.
   */
  revalidate: number;
}

/**
 * Cache handler interface for 'use cache' directive (cacheHandlers plural).
 *
 * Key differences from the legacy CacheHandler interface:
 * - get() receives softTags parameter
 * - set() receives a Promise that must be awaited
 * - Includes refreshTags(), getExpiration(), and updateTags() methods
 */
export interface UseCacheHandler {
  /**
   * Retrieve a cache entry.
   *
   * @param cacheKey - The cache key to look up
   * @param softTags - Framework-provided tags for additional filtering
   * @returns The cache entry if found and valid, undefined otherwise
   *
   * Implementation notes:
   * - Check expiration based on entry.revalidate and entry.timestamp
   * - Return undefined if missing or expired
   */
  get(cacheKey: string, softTags: string[]): Promise<UseCacheEntry | undefined>;

  /**
   * Store a cache entry.
   *
   * @param cacheKey - The cache key to store under
   * @param pendingEntry - A Promise that MUST be awaited before storage
   *
   * Implementation notes:
   * - CRITICAL: Must await pendingEntry before storing
   * - entry.value is a ReadableStream that may need .tee() if reading
   * - For persistent storage, convert stream to bytes before storing
   */
  set(cacheKey: string, pendingEntry: Promise<UseCacheEntry>): Promise<void>;

  /**
   * Synchronize tag state from external source.
   *
   * Implementation notes:
   * - Can be no-op for in-memory caches
   * - For distributed caches, sync tag invalidation state from shared storage
   */
  refreshTags(): Promise<void>;

  /**
   * Return maximum revalidation timestamp for given tags.
   *
   * @param tags - Array of tag names to check
   * @returns The most recent invalidation timestamp, or 0 if no cached info
   *
   * Implementation notes:
   * - Used to determine if cached entries are still valid
   * - Return 0 if no tags have been invalidated
   */
  getExpiration(tags: string[]): Promise<number>;

  /**
   * Invalidate cache entries with matching tags.
   *
   * @param tags - Array of tag names to invalidate
   * @param durations - Corresponding invalidation durations (currently unused by Next.js)
   *
   * Implementation notes:
   * - Store invalidation timestamps for each tag
   * - Entries with matching tags should be considered invalid
   */
  updateTags(tags: string[], durations: number[]): Promise<void>;
}

/**
 * Configuration options for creating a use cache handler instance.
 */
export interface UseCacheHandlerConfig {
  /**
   * Handler type selection:
   * - 'auto': Automatically detect based on environment (GCS if CACHE_BUCKET is set, otherwise file)
   * - 'file': Use file-based caching (local development)
   * - 'gcs': Use Google Cloud Storage (production/Pantheon)
   */
  type?: 'auto' | 'file' | 'gcs';
}

// ============================================================================
// Stats Types
// ============================================================================

/**
 * Information about a single use-cache entry for stats reporting.
 */
export interface UseCacheEntryInfo {
  /**
   * The cache key.
   */
  key: string;

  /**
   * Cache tags associated with this entry.
   */
  tags: string[];

  /**
   * Type identifier for stats reporting.
   * Always 'use-cache' for entries from cacheHandlers (plural).
   */
  type: 'use-cache';

  /**
   * When the entry was created (ISO timestamp).
   */
  lastModified?: string;

  /**
   * Approximate size in bytes (if available).
   */
  size?: number;

  /**
   * Revalidation time in seconds.
   */
  revalidate?: number;

  /**
   * Stale time in seconds.
   */
  stale?: number;

  /**
   * Expire time in seconds.
   */
  expire?: number;
}

/**
 * Cache statistics for use-cache entries.
 */
export interface UseCacheStats {
  /**
   * Number of cache entries.
   */
  size: number;

  /**
   * Detailed information about each entry.
   */
  entries: UseCacheEntryInfo[];

  /**
   * List of cache keys.
   */
  keys: string[];
}
