import { Bucket, Storage } from '@google-cloud/storage';
import type {
  CacheStats,
  CacheEntryInfo,
  CacheHandlerValue,
  FileSystemCacheContext,
} from '../types.js';
import { BaseCacheHandler, type BuildMeta } from './base.js';
import { EdgeCacheClear, createEdgeCacheClearer } from '../edge/edge-cache-clear.js';
import { getStaticRoutes } from '../utils/static-routes.js';
import { TagsBuffer } from '../utils/tags-buffer.js';
import { createLogger } from '../utils/logger.js';

const gcsLog = createLogger('GcsCacheHandler');

/**
 * Google Cloud Storage cache handler for production/Pantheon environments.
 * Stores cache entries in a GCS bucket.
 */
export class GcsCacheHandler extends BaseCacheHandler {
  private readonly bucket: Bucket;
  private readonly fetchCachePrefix: string;
  private readonly routeCachePrefix: string;
  private readonly buildMetaKey: string;
  private readonly tagsPrefix: string;
  private readonly tagsMapKey: string;
  private readonly edgeCacheClearer: EdgeCacheClear | null;
  private readonly tagsBuffer: TagsBuffer;

  constructor(context: FileSystemCacheContext) {
    super(context, 'GcsCacheHandler');

    const bucketName = process.env.CACHE_BUCKET;
    if (!bucketName) {
      throw new Error('CACHE_BUCKET environment variable is required for GCS cache handler');
    }

    const storage = new Storage();
    this.bucket = storage.bucket(bucketName);

    this.fetchCachePrefix = 'fetch-cache/';
    this.routeCachePrefix = 'route-cache/';
    this.buildMetaKey = 'build-meta.json';
    this.tagsPrefix = 'cache/tags/';
    this.tagsMapKey = `${this.tagsPrefix}tags.json`;

    this.edgeCacheClearer = createEdgeCacheClearer();

    // Create tags buffer for rate-limited writes
    this.tagsBuffer = new TagsBuffer({
      flushIntervalMs: 1000, // GCS rate limit is 1 write/second per object
      readTagsMapping: () => this.readTagsMappingDirect(),
      writeTagsMapping: (mapping) => this.writeTagsMapping(mapping),
      handlerName: 'GcsCacheHandler',
    });

    // Initialize asynchronously (don't await to avoid blocking constructor)
    this.initialize().catch(() => { });
  }

  // ============================================================================
  // Tags mapping implementation (buffered for GCS rate limiting)
  // ============================================================================

  protected async initializeTagsMapping(): Promise<void> {
    try {
      const file = this.bucket.file(this.tagsMapKey);
      const [exists] = await file.exists();

      if (!exists) {
        await file.save(JSON.stringify({}), {
          metadata: { contentType: 'application/json' },
        });
      }
    } catch (error) {
      this.log.error('Error initializing tags mapping:', error);
      // Don't throw - tags mapping will be created on first write
    }
  }

  /**
   * Read tags mapping, flushing any pending updates first to ensure accuracy.
   */
  protected async readTagsMapping(): Promise<Record<string, string[]>> {
    // Flush pending updates before reading to ensure we have accurate data
    await this.tagsBuffer.flush();
    return this.readTagsMappingDirect();
  }

  /**
   * Direct read from GCS without flushing buffer.
   * Used internally by the buffer.
   */
  private async readTagsMappingDirect(): Promise<Record<string, string[]>> {
    try {
      const file = this.bucket.file(this.tagsMapKey);
      const [exists] = await file.exists();

      if (!exists) {
        return {};
      }

      const [data] = await file.download();
      return JSON.parse(data.toString());
    } catch (error) {
      this.log.warn('Error reading tags mapping:', error);
      return {};
    }
  }

  /**
   * Write tags mapping directly to GCS.
   * Used by the buffer for batched writes.
   */
  protected async writeTagsMapping(tagsMapping: Record<string, string[]>): Promise<void> {
    try {
      const file = this.bucket.file(this.tagsMapKey);
      await file.save(JSON.stringify(tagsMapping, null, 2), {
        metadata: { contentType: 'application/json' },
      });
    } catch (error) {
      this.log.error('Error writing tags mapping:', error);
      throw error; // Re-throw so buffer can retry
    }
  }

  /**
   * Override to use buffered updates instead of immediate writes.
   */
  protected override async updateTagsMapping(cacheKey: string, tags: string[], isDelete = false): Promise<void> {
    if (isDelete) {
      this.tagsBuffer.deleteKey(cacheKey);
    } else if (tags.length > 0) {
      this.tagsBuffer.addTags(cacheKey, tags);
    }
    // Updates are queued and will be flushed automatically
    this.log.debug(`Queued tags update for ${cacheKey} (pending: ${this.tagsBuffer.pendingCount})`);
  }

  /**
   * Override to use buffered deletes instead of immediate writes.
   */
  protected override async updateTagsMappingBulkDelete(
    cacheKeysToDelete: string[],
    _tagsMapping: Record<string, string[]>
  ): Promise<void> {
    this.tagsBuffer.deleteKeys(cacheKeysToDelete);
    // Force flush after bulk delete to ensure consistency for revalidation
    await this.tagsBuffer.flush();
  }

  // ============================================================================
  // Cache entry implementation
  // ============================================================================

  private getCacheKey(cacheKey: string, cacheType: 'fetch' | 'route'): string {
    const safeKey = cacheKey.replace(/[^a-zA-Z0-9-]/g, '_');
    const prefix = cacheType === 'fetch' ? this.fetchCachePrefix : this.routeCachePrefix;
    return `${prefix}${safeKey}.json`;
  }

  protected async readCacheEntry(cacheKey: string, cacheType: 'fetch' | 'route'): Promise<CacheHandlerValue | null> {
    try {
      const gcsKey = this.getCacheKey(cacheKey, cacheType);
      const file = this.bucket.file(gcsKey);

      const [exists] = await file.exists();
      if (!exists) {
        return null;
      }

      const [data] = await file.download();
      const parsedData = JSON.parse(data.toString());

      return this.deserializeFromStorage({ [cacheKey]: parsedData })[cacheKey] as CacheHandlerValue || null;
    } catch {
      return null;
    }
  }

  protected async writeCacheEntry(
    cacheKey: string,
    cacheValue: CacheHandlerValue,
    cacheType: 'fetch' | 'route'
  ): Promise<void> {
    try {
      const gcsKey = this.getCacheKey(cacheKey, cacheType);
      const file = this.bucket.file(gcsKey);

      const serializedData = this.serializeForStorage({ [cacheKey]: cacheValue });

      await file.save(JSON.stringify(serializedData[cacheKey], null, 2), {
        metadata: { contentType: 'application/json' },
      });
    } catch (error) {
      this.log.error(`Error writing cache entry ${cacheKey}:`, error);
    }
  }

  protected async deleteCacheEntry(cacheKey: string, cacheType: 'fetch' | 'route'): Promise<void> {
    try {
      const gcsKey = this.getCacheKey(cacheKey, cacheType);
      const file = this.bucket.file(gcsKey);
      await file.delete();
    } catch (error) {
      if (!error || typeof error !== 'object' || !('code' in error) || (error as { code: number }).code !== 404) {
        this.log.error(`Error deleting cache entry ${cacheKey}:`, error);
      }
      throw error;
    }
  }

  // ============================================================================
  // Build meta implementation
  // ============================================================================

  protected async readBuildMeta(): Promise<BuildMeta> {
    const file = this.bucket.file(this.buildMetaKey);
    const [data] = await file.download();
    return JSON.parse(data.toString());
  }

  protected async writeBuildMeta(meta: BuildMeta): Promise<void> {
    const file = this.bucket.file(this.buildMetaKey);
    await file.save(JSON.stringify(meta), {
      metadata: { contentType: 'application/json' },
    });
  }

  protected async invalidateRouteCache(): Promise<void> {
    try {
      const [files] = await this.bucket.getFiles({ prefix: this.routeCachePrefix });
      const deletePromises = files.map((file) => file.delete());
      await Promise.all(deletePromises);

      // Also clear the edge cache since route cache was invalidated
      this.clearEdgeCache('route cache invalidation on new build');
    } catch {
      // Silently fail - cache invalidation is best effort
    }
  }

  // ============================================================================
  // Edge cache integration
  // ============================================================================

  private clearEdgeCache(context: string): void {
    if (!this.edgeCacheClearer) {
      this.log.debug(`Edge cache clearer not configured, skipping edge cache clear for: ${context}`);
      return;
    }

    this.edgeCacheClearer.nukeCacheInBackground(context);
  }

  protected override async onRevalidateComplete(tags: string[], deletedKeys: string[]): Promise<void> {
    if (deletedKeys.length === 0 || !this.edgeCacheClearer) {
      return;
    }

    // Clear by tags/keys
    this.edgeCacheClearer.clearKeysInBackground(tags, `tag revalidation: ${tags.join(', ')}`);

    // Also clear by route paths for routes that may not have tags (e.g., ISR routes)
    const routePaths = this.extractRoutePaths(deletedKeys);
    if (routePaths.length > 0) {
      this.edgeCacheClearer.clearPathsInBackground(routePaths, `path revalidation: ${routePaths.join(', ')}`);
    }
  }

  /**
   * Called when a route cache entry is set (ISR page update).
   * Clears the edge cache for this specific route so users get the fresh version.
   */
  protected override onRouteCacheSet(cacheKey: string): void {
    if (!this.edgeCacheClearer) {
      return;
    }

    const routePath = this.cacheKeyToRoutePath(cacheKey);
    this.edgeCacheClearer.clearPathInBackground(routePath, `ISR route update: ${routePath}`);
  }

  private cacheKeyToRoutePath(cacheKey: string): string {
    // Cache keys may be encoded (e.g., underscores for slashes)
    // Convert to a proper path format
    if (cacheKey.startsWith('/')) {
      return cacheKey;
    }

    // Handle encoded paths (underscores represent slashes in some cases)
    if (cacheKey.startsWith('_')) {
      return cacheKey.replace(/_/g, '/');
    }

    return `/${cacheKey}`;
  }

  private extractRoutePaths(keys: string[]): string[] {
    return keys
      .filter((key) => key.startsWith('/') || key.startsWith('_'))
      .map((key) => {
        if (key.startsWith('_')) {
          return key.replace(/_/g, '/');
        }
        return key.startsWith('/') ? key : `/${key}`;
      });
  }
}

// ============================================================================
// Standalone functions for API usage
// ============================================================================

/**
 * Get cache statistics for the GCS-based cache.
 */
export async function getSharedCacheStats(): Promise<CacheStats> {
  const bucketName = process.env.CACHE_BUCKET;
  if (!bucketName) {
    gcsLog.debug('CACHE_BUCKET environment variable not found');
    return { size: 0, keys: [], entries: [] };
  }

  const storage = new Storage();
  const bucket = storage.bucket(bucketName);

  const fetchCachePrefix = 'fetch-cache/';
  const routeCachePrefix = 'route-cache/';

  const keys: string[] = [];
  const entries: CacheEntryInfo[] = [];

  try {
    await processGcsCachePrefix(bucket, fetchCachePrefix, 'fetch', keys, entries);
    await processGcsCachePrefix(bucket, routeCachePrefix, 'route', keys, entries);

    gcsLog.debug(
      `Found ${keys.length} cache entries ` +
      `(${keys.filter((k) => k.startsWith('fetch:')).length} fetch, ` +
      `${keys.filter((k) => k.startsWith('route:')).length} route)`
    );

    return { size: keys.length, keys, entries };
  } catch (error) {
    gcsLog.error('Error reading cache:', error);
    return { size: 0, keys: [], entries: [] };
  }
}

async function processGcsCachePrefix(
  bucket: Bucket,
  prefix: string,
  cacheType: 'fetch' | 'route',
  keys: string[],
  entries: CacheEntryInfo[]
): Promise<void> {
  try {
    const [files] = await bucket.getFiles({ prefix });
    const jsonFiles = files.filter((file) => file.name.endsWith('.json'));

    for (const file of jsonFiles) {
      await processGcsFile(file, prefix, cacheType, keys, entries);
    }
  } catch (error) {
    gcsLog.warn(`Error reading ${cacheType} cache:`, error);
  }
}

async function processGcsFile(
  file: { name: string; download: () => Promise<[Buffer]> },
  prefix: string,
  cacheType: 'fetch' | 'route',
  keys: string[],
  entries: CacheEntryInfo[]
): Promise<void> {
  const cacheKey = file.name.replace(prefix, '').replace('.json', '').replace(/_/g, '-');
  const displayKey = `${cacheType}:${cacheKey}`;
  keys.push(displayKey);

  try {
    const [data] = await file.download();
    const cacheData = JSON.parse(data.toString());

    entries.push({
      key: displayKey,
      tags: cacheData.tags || [],
      lastModified: cacheData.lastModified || Date.now(),
      type: cacheType,
    });
  } catch {
    entries.push({
      key: displayKey,
      tags: [],
      type: cacheType,
    });
  }
}

/**
 * Clear all cache entries for the GCS-based cache.
 */
export async function clearSharedCache(): Promise<number> {
  const bucketName = process.env.CACHE_BUCKET;
  if (!bucketName) {
    gcsLog.debug('CACHE_BUCKET environment variable not found');
    return 0;
  }

  const storage = new Storage();
  const bucket = storage.bucket(bucketName);

  const fetchCachePrefix = 'fetch-cache/';
  const routeCachePrefix = 'route-cache/';
  const tagsFilePath = 'cache/tags/tags.json';

  const staticRoutes = getStaticRoutes();
  let clearedCount = 0;

  try {
    // Clear fetch cache (data cache - always clearable)
    clearedCount += await clearGcsFetchCache(bucket, fetchCachePrefix);

    // Clear route cache (skip static routes)
    const routeResult = await clearGcsRouteCache(bucket, routeCachePrefix, staticRoutes);
    clearedCount += routeResult.cleared;

    // Clear tags mapping
    await clearGcsTagsMapping(bucket, tagsFilePath);

    gcsLog.info(`Total cleared: ${clearedCount} cache entries`);

    // Clear edge cache if configured and entries were cleared
    if (clearedCount > 0) {
      const edgeCacheClearer = createEdgeCacheClearer();
      if (edgeCacheClearer) {
        edgeCacheClearer.nukeCacheInBackground('shared cache clear');
      }
    }

    return clearedCount;
  } catch (error) {
    gcsLog.error('Error clearing cache:', error);
    return 0;
  }
}

async function clearGcsFetchCache(bucket: Bucket, prefix: string): Promise<number> {
  try {
    const [files] = await bucket.getFiles({ prefix });
    const jsonFiles = files.filter((file) => file.name.endsWith('.json'));

    const deletePromises = jsonFiles.map((file) => file.delete());
    await Promise.all(deletePromises);

    gcsLog.debug(`Cleared ${jsonFiles.length} fetch cache entries`);
    return jsonFiles.length;
  } catch (error) {
    gcsLog.warn('Error clearing fetch cache:', error);
    return 0;
  }
}

async function clearGcsRouteCache(
  bucket: Bucket,
  prefix: string,
  staticRoutes: Set<string>
): Promise<{ cleared: number; preserved: number }> {
  let cleared = 0;
  let preserved = 0;

  try {
    const [files] = await bucket.getFiles({ prefix });
    const jsonFiles = files.filter((file) => file.name.endsWith('.json'));

    const filesToDelete: typeof files = [];
    for (const file of jsonFiles) {
      const cacheKey = file.name.replace(prefix, '').replace('.json', '');

      if (staticRoutes.has(cacheKey)) {
        preserved++;
        continue;
      }

      filesToDelete.push(file);
    }

    const deletePromises = filesToDelete.map((file) => file.delete());
    await Promise.all(deletePromises);
    cleared = filesToDelete.length;

    gcsLog.debug(`Route cache: cleared ${cleared}, preserved ${preserved} static routes`);
  } catch (error) {
    gcsLog.warn('Error clearing route cache:', error);
  }

  return { cleared, preserved };
}

async function clearGcsTagsMapping(bucket: Bucket, tagsFilePath: string): Promise<void> {
  try {
    const tagsFile = bucket.file(tagsFilePath);
    const [exists] = await tagsFile.exists();
    if (exists) {
      await tagsFile.delete();
    }
  } catch {
    // Ignore errors
  }
}

export default GcsCacheHandler;
