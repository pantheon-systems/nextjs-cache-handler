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
  type FlushedKey,
  type TagsMapping,
  type TagsMappingSnapshot,
} from '../utils/tags-buffer.js';
import {
  getSharedStorage,
  isNotFound,
  readJsonObject,
  writeJsonObject,
  resetSharedStorageForTests,
} from '../utils/gcs-json-object.js';
import { createLogger } from '../utils/logger.js';
import { getEnvironmentPrefix } from '../utils/environment-prefix.js';
import { cacheKeyToPurgePath, implicitTagsToPurgePaths } from '../utils/route-paths.js';
import {
  flushSharedRevalidations,
  getSharedRevalidations,
  resetSharedRevalidationsForTests,
  type SharedRevalidations,
  type SharedRevalidationMap,
} from '../utils/shared-revalidations.js';
import { loadSiteUrlConfig, pagesDataRoute, toPublicPath, type SiteUrlConfig } from '../utils/site-urls.js';
import { isBuildPhase } from '../utils/build-detection.js';

const gcsLog = createLogger('GcsCacheHandler');

// One buffer per (bucket, tags object) per process. Next.js constructs a new
// cache handler for every request (IncrementalCache is request-scoped), so
// state that paces writes to a shared object cannot live on the handler.
const sharedTagsBuffers = new Map<string, TagsBuffer>();

function getSharedTagsBuffer(
  bucketName: string,
  tagsBucket: Bucket,
  tagsMapKey: string,
  onFlushed: (added: FlushedKey[]) => Promise<void>
): TagsBuffer {
  const key = `${bucketName}/${tagsMapKey}`;
  let buffer = sharedTagsBuffers.get(key);
  if (!buffer) {
    buffer = new TagsBuffer({
      flushIntervalMs: resolveTagsFlushIntervalMs(),
      readTagsMapping: () => readTagsSnapshot(tagsBucket, tagsMapKey),
      writeTagsMapping: (mapping, generation) => writeJsonObject(tagsBucket, tagsMapKey, mapping, generation),
      handlerName: 'GcsCacheHandler',
      onFlushed,
    });
    sharedTagsBuffers.set(key, buffer);
  }
  return buffer;
}

// Clock skew between instances; purging a key twice is harmless.
const MISSED_REVALIDATION_SKEW_MS = 2000;

// After a revalidation is stored, every instance applies it at its next cache
// read once the refresh interval has passed; the margin covers that read's GCS
// round trip (up to 1 s, less with a shorter interval).
const MAX_APPLY_MARGIN_MS = 1000;

// How long after a read of revalidations from other instances starts the cache
// reads waiting on it go ahead with what this process already knows (the read
// still completes).
const REFRESH_WAIT_MS = 2000;

/** How long after a revalidation is stored every instance has applied it. */
const applyDelayMs = (revalidations: SharedRevalidations) =>
  revalidations.refreshIntervalMs + Math.min(MAX_APPLY_MARGIN_MS, revalidations.refreshIntervalMs);

// Deletes in flight at once during the deploy hand-over (onNewGeneration).
const FETCH_DELETE_BATCH_SIZE = 50;

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));

/**
 * Purge keys this process just made visible in the tags map whose tags were
 * revalidated after they were added. A revalidateTag on another instance read
 * the map before they landed, so it could not purge them.
 */
async function purgeMissedRevalidations(
  added: FlushedKey[],
  revalidations: SharedRevalidations,
  clearer: EdgeCacheClear | null,
  site: SiteUrlConfig
): Promise<void> {
  if (!clearer) {
    return;
  }
  await revalidations.refresh(true);

  const paths = new Set<string>();
  for (const { cacheKey, tags, addedAt } of added) {
    const missed = tags.some((tag) => (revalidations.get(tag)?.at ?? 0) > addedAt - MISSED_REVALIDATION_SKEW_MS);
    const routePath = missed ? cacheKeyToPurgePath(cacheKey) : null;
    if (routePath) {
      paths.add(toPublicPath(routePath, site));
    }
  }
  if (paths.size === 0) {
    return;
  }
  const list = [...paths];
  gcsLog.debug(`Purging edge paths revalidated before their keys were flushed: ${list.join(', ')}`);
  clearer.clearPathsInBackground(list, `revalidated before flush: ${list.join(', ')}`);

  // Purge again once every instance serves the revalidated entry, so one that
  // has not refreshed yet cannot put the old page back in the CDN. A timer, not
  // awaited, so the flush does not hold up the request that triggered it.
  const latest = Math.max(...added.flatMap(({ tags }) => tags.map((tag) => revalidations.get(tag)?.at ?? 0)));
  const wait = latest + applyDelayMs(revalidations) - Date.now();
  if (wait > 0) {
    setTimeout(
      () => clearer.clearPathsInBackground(list, `revalidated before flush, re-purge: ${list.join(', ')}`),
      wait
    );
  }
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

  // Revalidations an earlier write gave up on, so other instances still learn them.
  const revalidationsStored = flushSharedRevalidations(Math.max(0, deadline - Date.now()));

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

  await revalidationsStored;
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
  resetSharedRevalidationsForTests();
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
  private readonly revalidations: SharedRevalidations;
  private readonly site: SiteUrlConfig;

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
    this.site = loadSiteUrlConfig(context?.serverDistDir);
    this.revalidations = getSharedRevalidations(bucketName, this.tagsBucket, `${this.tagsPrefix}revalidations.json`);

    // The buffer is per process, so it keeps the first handler's clearer and site config.
    const { revalidations, edgeCacheClearer, site } = this;
    this.tagsBuffer = getSharedTagsBuffer(bucketName, this.tagsBucket, this.tagsMapKey, (added) =>
      purgeMissedRevalidations(added, revalidations, edgeCacheClearer, site)
    );

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

  /**
   * Prune revalidations older than the previous build. Only `fetch` entries
   * survive a deploy from before then, so those listed under the pruned tags
   * are deleted first. In the background: requests wait on initialize(), and
   * prune() keeps each revalidation until its entries are gone.
   */
  protected override async onNewGeneration(previous: BuildMeta): Promise<void> {
    if (previous.builtAt === undefined) {
      this.log.debug('The previous build recorded no build time; revalidations are pruned at the next deploy');
      return;
    }
    this.revalidations
      .prune(previous.builtAt, (tags) => this.deleteFetchEntriesForTags(tags))
      .catch((error) => this.log.warn('Pruning revalidations failed; it is retried at the next deploy:', error));
  }

  private async deleteFetchEntriesForTags(tags: string[]): Promise<void> {
    const { mapping } = await readTagsSnapshot(this.tagsBucket, this.tagsMapKey);
    // Route keys start with `/`; fetch keys are hashes.
    const fetchKeys = [...new Set(tags.flatMap((tag) => mapping[tag] ?? []))].filter((key) => !key.startsWith('/'));

    for (let i = 0; i < fetchKeys.length; i += FETCH_DELETE_BATCH_SIZE) {
      await Promise.all(
        fetchKeys.slice(i, i + FETCH_DELETE_BATCH_SIZE).map((key) =>
          this.bucket
            .file(this.getCacheKey(key, 'fetch'))
            .delete()
            .catch((error: unknown) => {
              if (!isNotFound(error)) {
                throw error;
              }
            })
        )
      );
    }
    if (fetchKeys.length > 0) {
      this.tagsBuffer.deleteKeys(fetchKeys);
      this.log.info(`Deleted ${fetchKeys.length} fetch entries revalidated before the previous build`);
    }
  }

  protected override async publishRevalidations(revalidations: SharedRevalidationMap): Promise<boolean> {
    return isBuildPhase() ? true : this.revalidations.record(revalidations);
  }

  protected override async refreshRevalidations(): Promise<void> {
    if (isBuildPhase()) {
      return;
    }
    await this.revalidations.refreshWithin(REFRESH_WAIT_MS);
  }

  protected override async onRevalidateComplete(
    tags: string[],
    affectedKeys: string[],
    published = true
  ): Promise<void> {
    // Runs on every revalidation, including soft ones (durations.expire in the
    // future): the CDN edge cache has no concept of "stale-while-revalidate"
    // for tag invalidation, so it must be cleared immediately whenever a tag
    // is revalidated, even though the origin's own stored entry is intentionally
    // kept servable in the interim (see BaseCacheHandler.revalidateTag).
    if (!this.edgeCacheClearer) {
      return;
    }

    const clearer = this.edgeCacheClearer;
    const implicit = implicitTagsToPurgePaths(tags);

    // revalidatePath's own path is purged even when the tags map has no key for it.
    const routePaths = new Set(implicit.paths);
    for (const key of affectedKeys) {
      const routePath = cacheKeyToPurgePath(key);
      if (routePath) {
        routePaths.add(routePath);
      } else if (key.startsWith('/')) {
        this.log.debug(`Not purging shell pattern ${key}: it matches no URL`);
      }
    }
    const paths = [...routePaths].map((routePath) => toPublicPath(routePath, this.site));

    const purge = async (phase: string) => {
      // Keys are sent even when no keys were found: they only match once responses
      // carry the tags as Surrogate-Key, which the tenant router turns into purge keys.
      const context = `tag revalidation (${phase}): ${tags.join(', ')}`;
      if (implicit.purgeAll) {
        await Promise.all([clearer.clearKeys(tags), clearer.nukeCache()]);
        this.log.debug(`Purged the whole site for ${context}`);
        return;
      }
      if (paths.length > 0) {
        this.log.debug(`Purging edge paths for ${context}: ${paths.join(', ')}`);
      }
      await Promise.all([clearer.clearKeys(tags), clearer.clearPaths(paths)]);
    };

    // Purge now for the instances that already serve the new entry, then again
    // once every instance does, so none can put the old page back in the CDN.
    // Awaited rather than a timer: a server action's response waits for it, and
    // Cloud Run may not give a detached timer CPU.
    await purge('now');
    if (published) {
      await delay(applyDelayMs(this.revalidations));
      await purge('after every instance applied it');
    } else {
      // Not stored yet, so other instances do not know it: purge after the retry that stores it.
      this.revalidations.whenStored(tags, () => {
        setTimeout(() => purge('after a delayed store').catch(() => {}), applyDelayMs(this.revalidations));
      });
    }
  }

  /**
   * Called when a route cache entry is set (ISR page update).
   * Clears the edge cache for this specific route so users get the fresh version.
   */
  protected override onRouteCacheSet(cacheKey: string, kind?: string): void {
    if (!this.edgeCacheClearer) {
      return;
    }

    const routePath = cacheKeyToPurgePath(cacheKey);
    if (!routePath) {
      this.log.debug(`Not purging ${cacheKey}: it matches no URL`);
      return;
    }
    const paths = [toPublicPath(routePath, this.site)];
    // Client-side navigation fetches a Pages Router page's props from its data route.
    const dataRoute = kind === 'PAGES' ? pagesDataRoute(routePath, this.site) : null;
    if (dataRoute) {
      paths.push(dataRoute);
    }
    this.log.debug(`Purging edge paths for ISR update of ${cacheKey}: ${paths.join(', ')}`);
    this.edgeCacheClearer.clearPathsInBackground(paths, `ISR route update: ${paths.join(', ')}`);
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
