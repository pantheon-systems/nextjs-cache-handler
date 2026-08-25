import { Bucket, Storage } from '@google-cloud/storage';
import type { CacheEntryType, CacheStats, CacheEntryInfo, CacheHandlerValue, FileSystemCacheContext } from '../types.js';
import { BaseCacheHandler, type BuildMeta } from './base.js';
import { EdgeCacheClear, createEdgeCacheClearer } from '../edge/edge-cache-clear.js';
import { getStaticRoutes } from '../utils/static-routes.js';
import { TagsBuffer } from '../utils/tags-buffer.js';
import { createLogger } from '../utils/logger.js';
import { getEnvironmentPrefix } from '../utils/environment-prefix.js';
import type { TagsManifestRecord } from '../utils/tags-manifest-sync.js';
import { isBuildPhase } from '../utils/build-detection.js';
import { withBuildTimeout } from '../utils/build-timeout.js';

const gcsLog = createLogger('GcsCacheHandler');

/**
 * How long a GCS read/write is allowed to run during the build/prerender
 * phase before this handler gives up on it and lets prerendering proceed
 * (cache miss on read, fire-and-forget on write) -- see `build-timeout.ts`
 * for why this exists and why it's build-phase-only. Not applied at runtime.
 */
const BUILD_IO_TIMEOUT_MS = 500;

/**
 * Google Cloud Storage cache handler for production/Pantheon environments.
 * Stores cache entries in a GCS bucket.
 */
export class GcsCacheHandler extends BaseCacheHandler {
  private readonly bucket: Bucket;
  private readonly fetchCachePrefix: string;
  private readonly routeCachePrefix: string;
  private readonly imageCachePrefix: string;
  private readonly buildMetaKey: string;
  private readonly tagsPrefix: string;
  private readonly tagsMapKey: string;
  private readonly tagsManifestKey: string;
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

    const envPrefix = getEnvironmentPrefix();
    this.fetchCachePrefix = `${envPrefix}fetch-cache/`;
    this.routeCachePrefix = `${envPrefix}route-cache/`;
    this.imageCachePrefix = `${envPrefix}image-cache/`;
    this.buildMetaKey = `${envPrefix}build-meta.json`;
    this.tagsPrefix = `${envPrefix}cache/tags/`;
    this.tagsMapKey = `${this.tagsPrefix}tags.json`;
    this.tagsManifestKey = `${this.tagsPrefix}manifest.json`;

    this.edgeCacheClearer = createEdgeCacheClearer();

    // Create tags buffer for rate-limited writes
    this.tagsBuffer = new TagsBuffer({
      flushIntervalMs: 1000, // GCS rate limit is 1 write/second per object
      readTagsMapping: () => this.readTagsMappingDirect(),
      writeTagsMapping: (mapping) => this.writeTagsMapping(mapping),
      handlerName: 'GcsCacheHandler',
    });

    // Initialize asynchronously (constructors can't be async) -- stored via
    // setInitPromise() so get()/set() can await it before touching the store.
    this.setInitPromise(this.initialize().catch(() => {}));
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
   * Read the shared tags-manifest snapshot (tag staleness, not tag -> keys --
   * see `writeTagsManifest`). Used by `BaseCacheHandler.maybeSyncTagsManifest()`
   * to fold another replica's `revalidateTag()` into this process's own
   * in-memory state -- this is the read side of the fix for the cross-replica
   * staleness bug (adapter repo's ticket 17): without it, a revalidation
   * handled by one replica is invisible to every other one, since Next's own
   * `areTagsExpired`/`areTagsStale` only ever check this process's in-memory
   * `tagsManifest` Map.
   */
  protected async readTagsManifest(): Promise<TagsManifestRecord> {
    try {
      const file = this.bucket.file(this.tagsManifestKey);
      const [exists] = await file.exists();
      if (!exists) {
        return {};
      }
      const [data] = await file.download();
      return JSON.parse(data.toString());
    } catch (error) {
      this.log.warn('Error reading tags manifest:', error);
      return {};
    }
  }

  /**
   * Write the shared tags-manifest snapshot. Called directly (not buffered)
   * from `revalidateTag()` -- see that method's own comment in `base.ts` for
   * why this doesn't go through `TagsBuffer` the way per-key tag mapping
   * writes do.
   */
  protected async writeTagsManifest(manifest: TagsManifestRecord): Promise<void> {
    try {
      const file = this.bucket.file(this.tagsManifestKey);
      await file.save(JSON.stringify(manifest, null, 2), {
        metadata: { contentType: 'application/json' },
      });
    } catch (error) {
      this.log.error('Error writing tags manifest:', error);
      throw error;
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

  // ============================================================================
  // Cache entry implementation
  // ============================================================================

  private getCacheKey(cacheKey: string, cacheType: CacheEntryType): string {
    const safeKey = cacheKey.replace(/[^a-zA-Z0-9-]/g, '_');
    const prefix =
      cacheType === 'fetch' ? this.fetchCachePrefix : cacheType === 'image' ? this.imageCachePrefix : this.routeCachePrefix;
    return `${prefix}${safeKey}.json`;
  }

  protected async readCacheEntry(cacheKey: string, cacheType: CacheEntryType): Promise<CacheHandlerValue | null> {
    const doRead = async (): Promise<CacheHandlerValue | null> => {
      const gcsKey = this.getCacheKey(cacheKey, cacheType);
      const file = this.bucket.file(gcsKey);

      const [exists] = await file.exists();
      if (!exists) {
        return null;
      }

      const [data] = await file.download();
      const parsedData = JSON.parse(data.toString());

      return (this.deserializeFromStorage({ [cacheKey]: parsedData })[cacheKey] as CacheHandlerValue) || null;
    };

    try {
      if (isBuildPhase()) {
        // A hanging/slowly-failing GCS read during prerendering (e.g. no
        // credentials reachable) must not block the page for real wall-clock
        // time -- see BUILD_IO_TIMEOUT_MS's comment and ticket 7. Falling
        // back to a cache miss here is exactly what a genuine miss already
        // does, so this can't produce a result Next doesn't already handle.
        return await withBuildTimeout(doRead(), BUILD_IO_TIMEOUT_MS, () => {
          this.log.warn(
            `GCS read for ${cacheKey} exceeded ${BUILD_IO_TIMEOUT_MS}ms during build -- treating as a cache miss rather than blocking prerendering`
          );
          return null;
        });
      }
      return await doRead();
    } catch {
      return null;
    }
  }

  protected async writeCacheEntry(
    cacheKey: string,
    cacheValue: CacheHandlerValue,
    cacheType: CacheEntryType
  ): Promise<void> {
    const doWrite = async (): Promise<void> => {
      const gcsKey = this.getCacheKey(cacheKey, cacheType);
      const file = this.bucket.file(gcsKey);

      const serializedData = this.serializeForStorage({ [cacheKey]: cacheValue });

      await file.save(JSON.stringify(serializedData[cacheKey], null, 2), {
        metadata: { contentType: 'application/json' },
      });
    };

    try {
      if (isBuildPhase()) {
        // Same rationale as readCacheEntry above: a fetch-cache write this
        // slow blocks the calling `fetch()` (patch-fetch.ts awaits
        // incrementalCache.set() inline), which is indistinguishable, from
        // cacheComponents' perspective, from genuinely uncached/dynamic data
        // accessed outside Suspense -- regardless of whether the write
        // eventually throws (it's already caught below either way).
        await withBuildTimeout(doWrite(), BUILD_IO_TIMEOUT_MS, () => {
          this.log.warn(
            `GCS write for ${cacheKey} exceeded ${BUILD_IO_TIMEOUT_MS}ms during build -- letting prerendering proceed without waiting for it (see ticket 7)`
          );
        });
      } else {
        await doWrite();
      }
    } catch (error) {
      this.log.error(`Error writing cache entry ${cacheKey}:`, error);
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

      // Awaited (unlike the ordinary tag-revalidation path below, which uses
      // the fire-and-forget clearEdgeCache()/nukeCacheInBackground): this runs
      // during startup-time build invalidation, which get()/set() now block
      // on via ensureInitialized() before touching the store. Awaiting here
      // means the edge purge request has actually been ISSUED (not just
      // queued) before this process starts serving real traffic that could
      // otherwise race a still-cached page from the previous build. Bounded
      // by nukeCache()'s own internal timeout, so this can't hang startup.
      if (this.edgeCacheClearer) {
        const result = await this.edgeCacheClearer.nukeCache();
        if (!result.success) {
          this.log.warn(`Edge cache purge on build invalidation failed: ${result.error}`);
        }
      }
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

  protected override async onRevalidateComplete(tags: string[], affectedKeys: string[]): Promise<void> {
    // Runs on every revalidation, including soft ones (durations.expire in the
    // future): the CDN edge cache has no concept of "stale-while-revalidate"
    // for tag invalidation, so it must be cleared immediately whenever a tag
    // is revalidated, even though the origin's own stored entry is intentionally
    // kept servable in the interim (see BaseCacheHandler.revalidateTag).
    if (affectedKeys.length === 0 || !this.edgeCacheClearer) {
      return;
    }

    // Clear by tags/keys
    this.edgeCacheClearer.clearKeysInBackground(tags, `tag revalidation: ${tags.join(', ')}`);

    // Also clear by route paths for routes that may not have tags (e.g., ISR routes)
    const routePaths = this.extractRoutePaths(affectedKeys);
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

  const envPrefix = getEnvironmentPrefix();
  const fetchCachePrefix = `${envPrefix}fetch-cache/`;
  const routeCachePrefix = `${envPrefix}route-cache/`;
  const imageCachePrefix = `${envPrefix}image-cache/`;

  const keys: string[] = [];
  const entries: CacheEntryInfo[] = [];

  try {
    await processGcsCachePrefix(bucket, fetchCachePrefix, 'fetch', keys, entries);
    await processGcsCachePrefix(bucket, routeCachePrefix, 'route', keys, entries);
    await processGcsCachePrefix(bucket, imageCachePrefix, 'image', keys, entries);

    gcsLog.debug(
      `Found ${keys.length} cache entries ` +
        `(${keys.filter((k) => k.startsWith('fetch:')).length} fetch, ` +
        `${keys.filter((k) => k.startsWith('route:')).length} route, ` +
        `${keys.filter((k) => k.startsWith('image:')).length} image)`
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
  cacheType: CacheEntryType,
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
  cacheType: CacheEntryType,
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

  const envPrefix = getEnvironmentPrefix();
  const fetchCachePrefix = `${envPrefix}fetch-cache/`;
  const routeCachePrefix = `${envPrefix}route-cache/`;
  const imageCachePrefix = `${envPrefix}image-cache/`;
  const tagsFilePath = `${envPrefix}cache/tags/tags.json`;
  const tagsManifestPath = `${envPrefix}cache/tags/manifest.json`;

  const staticRoutes = getStaticRoutes();
  let clearedCount = 0;

  try {
    // Clear fetch cache (data cache - always clearable)
    clearedCount += await clearGcsFetchCache(bucket, fetchCachePrefix);

    // Clear route cache (skip static routes)
    const routeResult = await clearGcsRouteCache(bucket, routeCachePrefix, staticRoutes);
    clearedCount += routeResult.cleared;

    // Clear image cache (content-derived, no build/static-route scoping needed)
    clearedCount += await clearGcsFetchCache(bucket, imageCachePrefix);

    // Clear tags mapping and the shared tags-manifest (staleness state)
    await clearGcsTagsMapping(bucket, tagsFilePath);
    await clearGcsTagsMapping(bucket, tagsManifestPath);

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
