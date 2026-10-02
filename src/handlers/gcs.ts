import type { Bucket } from '@google-cloud/storage';
import type {
  CacheEntryType,
  CacheStats,
  CacheEntryInfo,
  CacheHandlerValue,
  FileSystemCacheContext,
} from '../types.js';
import { BaseCacheHandler, type BuildMeta } from './base.js';
import { EdgeCacheClear, createEdgeCacheClearer } from '../edge/edge-cache-clear.js';
import { getStaticRoutes } from '../utils/static-routes.js';
import {
  TagsBuffer,
  resolveTagsFlushIntervalMs,
  type TagsMapping,
  type TagsMappingSnapshot,
} from '../utils/tags-buffer.js';
import {
  getSharedStorage,
  readJsonObject,
  writeJsonObject,
  resetSharedStorageForTests,
} from '../utils/gcs-json-object.js';
import { createLogger } from '../utils/logger.js';
import { getEnvironmentPrefix } from '../utils/environment-prefix.js';

const gcsLog = createLogger('GcsCacheHandler');

// One buffer per (bucket, tags object) per process. Next.js constructs a new
// cache handler for every request (IncrementalCache is request-scoped), so
// state that paces writes to a shared object cannot live on the handler.
const sharedTagsBuffers = new Map<string, TagsBuffer>();

function getSharedTagsBuffer(bucketName: string, tagsBucket: Bucket, tagsMapKey: string): TagsBuffer {
  const key = `${bucketName}/${tagsMapKey}`;
  let buffer = sharedTagsBuffers.get(key);
  if (!buffer) {
    buffer = new TagsBuffer({
      flushIntervalMs: resolveTagsFlushIntervalMs(),
      readTagsMapping: () => readTagsSnapshot(tagsBucket, tagsMapKey),
      writeTagsMapping: (mapping, generation) => writeJsonObject(tagsBucket, tagsMapKey, mapping, generation),
      handlerName: 'GcsCacheHandler',
    });
    sharedTagsBuffers.set(key, buffer);
  }
  return buffer;
}

async function readTagsSnapshot(bucket: Bucket, tagsMapKey: string): Promise<TagsMappingSnapshot> {
  const { value, generation } = await readJsonObject<TagsMapping>(bucket, tagsMapKey);
  return { mapping: value ?? {}, generation };
}

export interface FlushTagsMappingOptions {
  /**
   * How long to keep retrying a failed flush (the shared object accepts one
   * write per second, so several instances shutting down together take turns).
   * Default 8000 ms, inside Cloud Run's 10 s SIGTERM grace period.
   */
  timeoutMs?: number;
}

/**
 * Write every pending tag-mapping update in this process now, retrying until
 * `timeoutMs`. Next.js exits on SIGTERM itself, so the handler cannot hook
 * shutdown; an app that sets NEXT_MANUAL_SIG_HANDLE and handles the signal can
 * call this before exiting so the last interval's updates are not lost. Never
 * rejects.
 *
 * Only sees buffers in this module instance. Code bundled by Next (routes,
 * instrumentation) may carry its own copy of the package and see none; call it
 * from process-level code such as a custom server.
 *
 * @returns the number of buffers that had pending updates and were fully flushed.
 */
export async function flushGcsTagsMapping(options: FlushTagsMappingOptions = {}): Promise<number> {
  const deadline = Date.now() + (options.timeoutMs ?? 8000);
  const pending = [...sharedTagsBuffers.values()].filter((buffer) => buffer.hasPending);
  if (sharedTagsBuffers.size === 0) {
    gcsLog.debug('flushGcsTagsMapping: no tag buffers in this module instance (nothing to flush)');
  }

  const droppedBefore = new Map(pending.map((buffer) => [buffer, buffer.droppedUpdates]));
  await Promise.all(
    pending.map(async (buffer) => {
      while (buffer.hasPending) {
        await buffer.flush();
        if (!buffer.hasPending) {
          return;
        }
        const remaining = deadline - Date.now();
        if (remaining <= 0) {
          gcsLog.warn(
            `flushGcsTagsMapping: ${buffer.pendingCount} tag update(s) still pending at the deadline; ` +
              `they are lost if the process exits now`
          );
          return;
        }
        // The object takes one write per second; retrying faster only adds 429s.
        await new Promise((resolve) => setTimeout(resolve, Math.min(remaining, 1000 + Math.random() * 500)));
      }
    })
  );

  return pending.filter((buffer) => !buffer.hasPending && buffer.droppedUpdates === droppedBefore.get(buffer)).length;
}

/**
 * Drop the process-wide tag buffers and storage clients.
 * @internal Test hook.
 */
export function resetGcsSharedState(): void {
  for (const buffer of sharedTagsBuffers.values()) {
    buffer.destroy();
  }
  sharedTagsBuffers.clear();
  resetSharedStorageForTests();
}

/**
 * Google Cloud Storage cache handler for production/Pantheon environments.
 * Stores cache entries in a GCS bucket.
 */
export class GcsCacheHandler extends BaseCacheHandler {
  private readonly bucket: Bucket;
  private readonly tagsBucket: Bucket;
  private readonly fetchCachePrefix: string;
  private readonly routeCachePrefix: string;
  private readonly imageCachePrefix: string;
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

    // Two clients on purpose: unconditional entry writes disable retries on
    // their client's shared state, which must not leak into tag-map writes.
    this.bucket = getSharedStorage(bucketName, 'entries').bucket(bucketName);
    this.tagsBucket = getSharedStorage(bucketName, 'tags').bucket(bucketName);

    const envPrefix = getEnvironmentPrefix();
    this.fetchCachePrefix = `${envPrefix}fetch-cache/`;
    this.routeCachePrefix = `${envPrefix}route-cache/`;
    this.imageCachePrefix = `${envPrefix}image-cache/`;
    this.buildMetaKey = `${envPrefix}build-meta.json`;
    this.tagsPrefix = `${envPrefix}cache/tags/`;
    this.tagsMapKey = `${this.tagsPrefix}tags.json`;

    this.edgeCacheClearer = createEdgeCacheClearer();

    this.tagsBuffer = getSharedTagsBuffer(bucketName, this.tagsBucket, this.tagsMapKey);

    // Initialize asynchronously (constructors can't be async) -- stored via
    // setInitPromise() so get()/set() can await it before touching the store.
    this.setInitPromise(this.initialize().catch(() => {}));
  }

  // ============================================================================
  // Tags mapping implementation (buffered for GCS rate limiting)
  // ============================================================================

  protected async initializeTagsMapping(): Promise<void> {
    // Nothing to create up front. The first flush writes the object with an
    // `ifGenerationMatch: 0` precondition, so racing processes cannot clobber it.
  }

  /**
   * Stored mapping with this process's pending updates overlaid. Does not
   * write: a read (every revalidateTag) must not count against the object's
   * write rate.
   */
  protected async readTagsMapping(): Promise<Record<string, string[]>> {
    let stored: TagsMapping = {};
    try {
      stored = (await readTagsSnapshot(this.tagsBucket, this.tagsMapKey)).mapping;
    } catch (error) {
      this.log.error(
        'Error reading tags mapping; this revalidation will not purge the CDN for entries stored by other processes:',
        error
      );
    }
    return this.tagsBuffer.overlay(stored);
  }

  /**
   * Not supported: a whole-map write built from an earlier read cannot be made
   * safe against concurrent flushes. Exists only because BaseCacheHandler
   * declares it; updateTagsMapping is overridden so nothing reaches it.
   */
  protected async writeTagsMapping(_tagsMapping: Record<string, string[]>): Promise<void> {
    throw new Error('GcsCacheHandler.writeTagsMapping is not supported; tag updates go through the shared TagsBuffer');
  }

  /**
   * Queue the update; flush inline when the interval has elapsed. Awaiting
   * here (inside the request that produced the update) is deliberate: Cloud
   * Run may not grant CPU to background timers between requests.
   */
  protected override async updateTagsMapping(cacheKey: string, tags: string[], isDelete = false): Promise<void> {
    if (isDelete) {
      this.tagsBuffer.deleteKey(cacheKey);
    } else if (tags.length > 0) {
      this.tagsBuffer.addTags(cacheKey, tags);
    }
    this.log.debug(`Queued tags update for ${cacheKey} (pending: ${this.tagsBuffer.pendingCount})`);

    const dueFlush = this.tagsBuffer.flushIfDue();
    if (dueFlush) {
      await dueFlush;
    }
  }

  // ============================================================================
  // Cache entry implementation
  // ============================================================================

  private getCacheKey(cacheKey: string, cacheType: CacheEntryType): string {
    const safeKey = cacheKey.replace(/[^a-zA-Z0-9-]/g, '_');
    const prefix =
      cacheType === 'fetch'
        ? this.fetchCachePrefix
        : cacheType === 'image'
          ? this.imageCachePrefix
          : this.routeCachePrefix;
    return `${prefix}${safeKey}.json`;
  }

  protected async readCacheEntry(cacheKey: string, cacheType: CacheEntryType): Promise<CacheHandlerValue | null> {
    try {
      const gcsKey = this.getCacheKey(cacheKey, cacheType);
      const file = this.bucket.file(gcsKey);

      const [exists] = await file.exists();
      if (!exists) {
        return null;
      }

      const [data] = await file.download();
      const parsedData = JSON.parse(data.toString());

      return (this.deserializeFromStorage({ [cacheKey]: parsedData })[cacheKey] as CacheHandlerValue) || null;
    } catch {
      return null;
    }
  }

  protected async writeCacheEntry(
    cacheKey: string,
    cacheValue: CacheHandlerValue,
    cacheType: CacheEntryType
  ): Promise<void> {
    try {
      const gcsKey = this.getCacheKey(cacheKey, cacheType);
      const file = this.bucket.file(gcsKey);

      const serializedData = this.serializeForStorage({ [cacheKey]: cacheValue });

      await file.save(JSON.stringify(serializedData[cacheKey], null, 2), {
        resumable: false,
        metadata: { contentType: 'application/json' },
      });
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
      resumable: false,
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

  const storage = getSharedStorage(bucketName, 'entries');
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

  const storage = getSharedStorage(bucketName, 'entries');
  const bucket = storage.bucket(bucketName);

  const envPrefix = getEnvironmentPrefix();
  const fetchCachePrefix = `${envPrefix}fetch-cache/`;
  const routeCachePrefix = `${envPrefix}route-cache/`;
  const imageCachePrefix = `${envPrefix}image-cache/`;
  const tagsFilePath = `${envPrefix}cache/tags/tags.json`;

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
