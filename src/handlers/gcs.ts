import type { Bucket, File } from '@google-cloud/storage';
import type {
  CacheEntryType,
  CacheStats,
  CacheEntryInfo,
  CacheHandlerValue,
  FileSystemCacheContext,
  SharedCacheCounts,
  SharedCacheStatsOptions,
} from '../types.js';
import { BaseCacheHandler, getProcessGeneration, isFallbackGeneration, type BuildMeta } from './base.js';
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
import {
  loadSiteUrlConfig,
  pagesDataRoute,
  toPublicPath,
  withoutDefaultLocale,
  type SiteUrlConfig,
} from '../utils/site-urls.js';
import { isBuildPhase } from '../utils/build-detection.js';
import { toObjectName } from '../utils/object-names.js';
import { DelayedPurges, type DelayedPurge } from '../utils/delayed-purges.js';
import {
  MAX_PURGE_RUNS,
  RouteCacheCleanup,
  createCleanupJob,
  type CleanupTagsMap,
} from '../utils/route-cache-cleanup.js';
import {
  DEFAULT_DELETE_CONCURRENCY,
  deletePrefix,
  describeFailures,
  errorLabel,
  errorMessage,
  listPrefixPages,
  mapInBatches,
  resolveBuildInvalidationMode,
  resolveDeleteConcurrency,
  type DeletePrefixResult,
} from '../utils/gcs-delete-prefix.js';

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

// Re-purges once every instance has applied a revalidation, per process.
const delayedPurges = new DelayedPurges();

// One clean-up runner per (bucket, job object) per process, like the tag buffers.
const routeCacheCleanups = new Map<string, RouteCacheCleanup>();

/**
 * Whether a route entry stamped with `generation` belongs to the running build.
 * A process that can't read its build ID serves any entry, as before stamping:
 * its fallback generation is unique, so it would otherwise never hit.
 */
function isCurrentGeneration(generation: unknown): boolean {
  const current = getProcessGeneration();
  return isFallbackGeneration(current) || generation === current;
}

/** The generation a route object was written by, from the custom metadata listings return. */
function routeObjectGeneration(file: File): unknown {
  return (file.metadata?.metadata as Record<string, unknown> | undefined)?.generation;
}

/**
 * What an operator can do about failed deletes or listings, from their error
 * labels (see errorLabel): grant delete permission, or ease throttling.
 */
function deleteFailureHints(bucketName: string, labels: string[]): string[] {
  const hints: string[] = [];
  if (labels.some((label) => label === '401' || label === '403')) {
    hints.push(
      `Permission denied: the service account needs storage.objects.delete and storage.objects.list on gs://${bucketName}.`
    );
  }
  if (labels.some((label) => label !== '401' && label !== '403' && !/^4\d\d$/.test(label))) {
    hints.push(
      `GCS throttled or was unavailable after retries; a lower CACHE_INVALIDATION_DELETE_CONCURRENCY ` +
        `(now ${resolveDeleteConcurrency()}) reduces throttling.`
    );
  }
  return hints;
}

/** Most route paths remembered as served; the oldest are forgotten first. */
const MAX_SERVED_PATHS = 5000;
/** Slack for clock differences between instances when comparing a serve to a revalidation. */
const SERVED_SKEW_MS = 1000;
/** When this process last served each route path from the cache. Per process, like the listener that reads it. */
const servedAt = new Map<string, number>();

function recordServed(routePath: string): void {
  servedAt.delete(routePath); // re-insert so the map stays in order of last serve
  servedAt.set(routePath, Date.now());
  if (servedAt.size > MAX_SERVED_PATHS) {
    servedAt.delete(servedAt.keys().next().value as string);
  }
}

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
  // has not refreshed yet cannot put the old page back in the CDN.
  const latest = Math.max(...added.flatMap(({ tags }) => tags.map((tag) => revalidations.get(tag)?.at ?? 0)));
  const due = latest + applyDelayMs(revalidations);
  if (due > Date.now()) {
    delayedPurges.schedule(clearer, { paths: list }, due, `revalidated before flush, re-purge: ${list.join(', ')}`);
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
 * `timeoutMs`, and send the CDN re-purges it still owes. Next.js exits on SIGTERM itself, so the handler cannot hook
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

  // Re-purges this process still owes the CDN, once they are due if the deadline allows.
  const purgesSent = delayedPurges.flush(deadline).catch((error) => {
    gcsLog.warn('flushGcsTagsMapping: delayed CDN purges failed:', error);
  });

  await Promise.all([revalidationsStored, purgesSent]);
  return pending.filter((buffer) => !buffer.hasPending && buffer.droppedUpdates === droppedBefore.get(buffer)).length;
}

/**
 * Wait for the route cache clean-ups running in this process.
 * @internal Test hook.
 */
export async function waitForRouteCacheCleanupsForTests(): Promise<void> {
  await Promise.all([...routeCacheCleanups.values()].map((cleanup) => cleanup.current));
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
  delayedPurges.reset();
  routeCacheCleanups.clear();
  servedAt.clear();
  resetSharedRevalidationsForTests();
  resetSharedStorageForTests();
}

/**
 * Google Cloud Storage cache handler for production/Pantheon environments.
 * Stores cache entries in a GCS bucket.
 */
export class GcsCacheHandler extends BaseCacheHandler {
  private readonly bucketName: string;
  private readonly bucket: Bucket;
  private readonly tagsBucket: Bucket;
  private readonly fetchCachePrefix: string;
  private readonly routeCachePrefix: string;
  private readonly imageCachePrefix: string;
  private readonly buildMetaKey: string;
  private readonly cleanupJobKey: string;
  private readonly cleanupRemovalsKey: string;
  private readonly cleanup: RouteCacheCleanup;
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

    this.bucketName = bucketName;
    // Two clients on purpose: unconditional entry writes disable retries on
    // their client's shared state, which must not leak into tag-map writes.
    this.bucket = getSharedStorage(bucketName, 'entries').bucket(bucketName);
    this.tagsBucket = getSharedStorage(bucketName, 'tags').bucket(bucketName);

    const envPrefix = getEnvironmentPrefix();
    this.fetchCachePrefix = `${envPrefix}fetch-cache/`;
    this.routeCachePrefix = `${envPrefix}route-cache/`;
    this.imageCachePrefix = `${envPrefix}image-cache/`;
    this.buildMetaKey = `${envPrefix}build-meta.json`;
    // Outside route-cache/, so the clean-up's own listing never includes it.
    this.cleanupJobKey = `${envPrefix}route-cache-cleanup.json`;
    this.cleanupRemovalsKey = `${envPrefix}route-cache-cleanup-removals.json`;
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
    // Likewise per process: purge the pages this one served after another
    // instance revalidated them, before it learned of it, since those may have
    // put the old pages back in the CDN. An instance that served none purges nothing.
    if (edgeCacheClearer) {
      revalidations.setOnLearned((tags) => this.purgeServedAfterRevalidation(tags));
    }

    this.cleanup = this.getSharedCleanup();

    // Initialize asynchronously (constructors can't be async) -- stored via
    // setInitPromise() so get()/set() can await it before touching the store.
    this.setInitPromise(this.initialize().catch(() => {}));
  }

  /** The process's clean-up runner; the first handler's clearer and tags buffer do the work. */
  private getSharedCleanup(): RouteCacheCleanup {
    const key = `${this.bucketName}/${this.cleanupJobKey}`;
    let cleanup = routeCacheCleanups.get(key);
    if (!cleanup) {
      const { edgeCacheClearer } = this;
      cleanup = new RouteCacheCleanup({
        bucket: this.bucket,
        jobBucket: this.tagsBucket,
        jobKey: this.cleanupJobKey,
        removalsKey: this.cleanupRemovalsKey,
        prefix: this.routeCachePrefix,
        generationOf: routeObjectGeneration,
        concurrency: () => resolveDeleteConcurrency(),
        purge: edgeCacheClearer ? async () => (await edgeCacheClearer.nukeCache()).success : undefined,
        tagsMap: this.cleanupTagsMap(),
        failureHints: (labels) => deleteFailureHints(this.bucketName, labels),
        log: this.log,
      });
      routeCacheCleanups.set(key, cleanup);
    }
    return cleanup;
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
    const prefix =
      cacheType === 'fetch'
        ? this.fetchCachePrefix
        : cacheType === 'image'
          ? this.imageCachePrefix
          : this.routeCachePrefix;
    return `${prefix}${toObjectName(cacheKey)}.json`;
  }

  protected async readCacheEntry(cacheKey: string, cacheType: CacheEntryType): Promise<CacheHandlerValue | null> {
    // Picks up a clean-up whose instance stopped, at most once per lock
    // lifetime per process; not awaited. One read, a 404 when there is none.
    if (cacheType === 'route' && !isBuildPhase() && !isFallbackGeneration(getProcessGeneration())) {
      void this.cleanup.resume(getProcessGeneration());
    }
    try {
      const gcsKey = this.getCacheKey(cacheKey, cacheType);
      const file = this.bucket.file(gcsKey);

      const [exists] = await file.exists();
      if (!exists) {
        return null;
      }

      const [data] = await file.download();
      const { generation, ...parsedData } = JSON.parse(data.toString());

      // A route entry from another build can reference that build's assets,
      // which this deploy no longer serves: one a failed delete left behind,
      // or one an instance of another revision wrote during a rollout.
      if (cacheType === 'route' && !isCurrentGeneration(generation)) {
        this.log.debug(`MISS: ${cacheKey} (route, stored by ${generation ?? 'an unstamped earlier version'})`);
        return null;
      }

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
      // Route entries carry their build (see readCacheEntry). Fetch and image
      // entries don't depend on the build and are kept across deploys.
      const stored =
        cacheType === 'route'
          ? { ...(serializedData[cacheKey] as object), generation: getProcessGeneration() }
          : serializedData[cacheKey];

      await file.save(JSON.stringify(stored, null, 2), {
        resumable: false,
        metadata: {
          contentType: 'application/json',
          // Also as object metadata, which listings return: getSharedCacheCounts
          // counts route entries by build without downloading them.
          ...(cacheType === 'route' ? { metadata: { generation: getProcessGeneration() } } : {}),
        },
      });
    } catch (error) {
      this.log.error(`Error writing cache entry ${cacheKey}:`, error);
    }
  }

  // ============================================================================
  // Build meta implementation
  // ============================================================================

  protected async readBuildMeta(): Promise<BuildMeta | null> {
    let data: Buffer;
    try {
      [data] = await this.bucket.file(this.buildMetaKey).download();
    } catch (error) {
      if (isNotFound(error)) {
        return null;
      }
      throw error;
    }
    return this.parseBuildMeta(data.toString());
  }

  protected async writeBuildMeta(meta: BuildMeta): Promise<void> {
    const file = this.bucket.file(this.buildMetaKey);
    await file.save(JSON.stringify(meta), {
      resumable: false,
      metadata: { contentType: 'application/json' },
    });
  }

  /**
   * Purge the CDN and record that the previous builds' route entries are to be
   * deleted. The delete itself runs in the background (onBuildCurrent): the
   * entries are misses already (see readCacheEntry), so requests don't wait
   * for it. Never throws.
   */
  protected async invalidateRouteCache(): Promise<void> {
    const location = `gs://${this.bucketName}/${this.routeCachePrefix}`;
    const deleteEntries = resolveBuildInvalidationMode() !== 'off';
    if (!deleteEntries) {
      this.log.warn(
        `CACHE_BUILD_INVALIDATION=off: ${location} is not deleted for the new build. Its entries from earlier ` +
          `builds are not served (they count as cache misses), but stay in storage until a deploy runs without ` +
          `CACHE_BUILD_INVALIDATION=off.`
      );
    }

    // Awaited, so the purge is sent before this process serves a request that
    // could race a still-cached previous-build page. Bounded by nukeCache()'s
    // timeout; a failure is recorded on the job and retried in the background.
    const purge = this.edgeCacheClearer ? await this.edgeCacheClearer.nukeCache() : { success: true };
    const purgeFailed = `Edge cache purge on build invalidation failed: ${purge.error}.`;
    const stayInCdn =
      "pages from the previous build stay in the CDN until they expire or the site's edge cache is cleared.";

    // Before the build is recorded, so a process that dies after recording it
    // still leaves the job for a later instance.
    try {
      await createCleanupJob(this.tagsBucket, this.cleanupJobKey, getProcessGeneration(), {
        deleteEntries,
        purgePending: !purge.success,
      });
    } catch (error) {
      this.log.error(
        `Could not record the route cache clean-up in gs://${this.bucketName}/${this.cleanupJobKey} ` +
          `(${errorLabel(error)}: ${errorMessage(error)}). The previous build's entries in ${location} are not ` +
          `served, but stay in storage, and their keys in the tags map, until the next deploy.` +
          (purge.success ? '' : ` ${purgeFailed} It is not retried, so ${stayInCdn}`)
      );
      return;
    }
    if (!purge.success) {
      this.log.error(
        `${purgeFailed} The background clean-up retries it (up to ${MAX_PURGE_RUNS} runs); until then, ` +
          `pages from the previous build stay in the CDN.`
      );
    }
  }

  /** Start, or resume, the pending route cache clean-up in the background. */
  protected override onBuildCurrent(): void {
    void this.cleanup.resume(getProcessGeneration(), { force: true });
  }

  /**
   * The tags map as the route cache clean-up prunes it: route keys (starting
   * with `/`) by their object's name. Fetch keys are left out; those entries
   * survive deploys. Removals go through the shared buffer, whose conditional
   * writes merge with other instances.
   */
  private cleanupTagsMap(): CleanupTagsMap {
    const { tagsBuffer } = this;
    // The buffer is shared with every request in the process, so a prune
    // judges only its own removals and add-backs, and any updates dropped
    // since it queued them.
    let removing = new Set<string>();
    let restoring = new Set<string>();
    let droppedBefore = 0;
    return {
      routeKeysByObject: async () => {
        const { mapping } = await readTagsSnapshot(this.tagsBucket, this.tagsMapKey);
        const byObject = new Map<string, string[]>();
        for (const key of new Set(Object.values(mapping).flat())) {
          if (typeof key === 'string' && key.startsWith('/')) {
            const name = this.getCacheKey(key, 'route');
            byObject.set(name, [...(byObject.get(name) ?? []), key]);
          }
        }
        return byObject;
      },
      remove: async (keys) => {
        removing = new Set(keys);
        restoring = new Set();
        droppedBefore = tagsBuffer.droppedUpdates;
        tagsBuffer.deleteKeys(keys);
        await tagsBuffer.flushIfDue();
      },
      flush: async () => {
        await tagsBuffer.flush();
        // A failed write leaves them queued (the buffer logged why); a drop
        // may have discarded them.
        const stored =
          tagsBuffer.droppedUpdates === droppedBefore &&
          ![...removing].some((key) => tagsBuffer.isDeletePending(key)) &&
          ![...restoring].some((key) => tagsBuffer.isAddPending(key));
        if (!stored) {
          // Left queued, a later write could store them after another instance
          // took the job over and added keys back; the next run removes them
          // again from the saved removals. Additions stay queued.
          tagsBuffer.cancelDeletes([...removing]);
        }
        return stored;
      },
      restore: async (keysByObject) => {
        let queued = 0;
        const results = await mapInBatches([...keysByObject], resolveDeleteConcurrency(), async ([name, keys]) => {
          const [data] = await this.bucket.file(name).download();
          const { tags } = JSON.parse(data.toString()) as { tags?: unknown };
          const strings = Array.isArray(tags) ? tags.filter((tag): tag is string => typeof tag === 'string') : [];
          for (const key of keys) {
            tagsBuffer.addTags(key, strings);
            if (strings.length > 0) {
              restoring.add(key);
              queued++;
            }
          }
        });
        const failed = results.filter((result) => result.status === 'rejected');
        if (failed.length > 0) {
          this.log.warn(
            `Could not read ${failed.length} route entries to add their keys back to ` +
              `gs://${this.bucketName}/${this.tagsMapKey} (first: ${errorMessage(
                (failed[0] as PromiseRejectedResult).reason
              )}); tag revalidations do not purge the CDN for those pages until they are cached again`
          );
        }
        return queued;
      },
      location: `gs://${this.bucketName}/${this.tagsMapKey}`,
    };
  }

  // ============================================================================
  // Edge cache integration
  // ============================================================================

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

    // Purge now for the instances that already serve the new entry, then again
    // once every instance does, so none can put the old page back in the CDN.
    // Only the first is awaited: a server action's response waits for it. Cloud
    // Run may give the timer no CPU until the next request, so the second is a
    // backstop: each other instance also purges when it learns of the
    // revalidation (setOnLearned), inside a request.
    const clearer = this.edgeCacheClearer;
    await this.purgeTags(tags, affectedKeys, 'now');
    const again = this.purgeTarget(tags, affectedKeys);
    const schedule = (phase: string) =>
      delayedPurges.schedule(
        clearer,
        again,
        Date.now() + applyDelayMs(this.revalidations),
        `tag revalidation (${phase}): ${tags.join(', ')}`
      );
    if (published) {
      schedule('after every instance applied it');
    } else {
      // Not stored yet, so other instances do not know it: purge after the retry that stores it.
      this.revalidations.whenStored(tags, () => schedule('after a delayed store'));
    }
  }

  /** Purge the paths of `tags` that this process served from the cache after they were revalidated elsewhere. */
  private async purgeServedAfterRevalidation(tags: string[]): Promise<void> {
    const clearer = this.edgeCacheClearer;
    if (!clearer) {
      return;
    }
    const since = Math.min(...tags.map((tag) => this.revalidations.get(tag)?.at ?? Date.now())) - SERVED_SKEW_MS;
    const { paths: candidates } = this.purgeTarget(tags, await this.findAffectedKeys(tags));
    const paths = candidates.filter((path) => (servedAt.get(path) ?? 0) >= since);
    if (paths.length === 0) {
      return;
    }
    this.log.debug(`Purging edge paths served before learning of ${tags.join(', ')}: ${paths.join(', ')}`);
    await clearer.clearPaths(paths);
  }

  /** Remember what this process serves, for purgeServedAfterRevalidation. */
  protected override onServed(cacheKey: string, cacheType: CacheEntryType): void {
    if (!this.edgeCacheClearer || cacheType === 'image') {
      return;
    }
    const routePath = cacheKeyToPurgePath(cacheKey);
    if (routePath) {
      recordServed(toPublicPath(routePath, this.site));
    }
  }

  /** What to purge for revalidated tags: the tags as keys, and the paths of their cache keys. */
  private purgeTarget(tags: string[], affectedKeys: string[]): Required<DelayedPurge> {
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
    return { keys: tags, paths, purgeAll: implicit.purgeAll };
  }

  /** Purge the CDN for revalidated tags now. */
  private async purgeTags(tags: string[], affectedKeys: string[], phase: string): Promise<void> {
    if (!this.edgeCacheClearer) {
      return;
    }

    const clearer = this.edgeCacheClearer;
    const { paths, purgeAll } = this.purgeTarget(tags, affectedKeys);

    // Keys are sent even when no keys were found: they only match once responses
    // carry the tags as Surrogate-Key, which the tenant router turns into purge keys.
    const context = `tag revalidation (${phase}): ${tags.join(', ')}`;
    if (purgeAll) {
      await Promise.all([clearer.clearKeys(tags), clearer.nukeCache()]);
      this.log.debug(`Purged the whole site for ${context}`);
      return;
    }
    if (paths.length > 0) {
      this.log.debug(`Purging edge paths for ${context}: ${paths.join(', ')}`);
    }
    await Promise.all([clearer.clearKeys(tags), clearer.clearPaths(paths)]);
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
    if (kind === 'PAGES') {
      // Client-side navigation fetches a Pages Router page's props from its data route.
      const dataRoute = pagesDataRoute(routePath, this.site);
      if (dataRoute) {
        paths.push(dataRoute);
      }
      const unprefixed = withoutDefaultLocale(routePath, this.site);
      if (unprefixed) {
        paths.push(toPublicPath(unprefixed, this.site));
      }
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
export async function getSharedCacheStats(options: SharedCacheStatsOptions = {}): Promise<CacheStats> {
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
  const limit = options.limit ?? Infinity;

  const keys: string[] = [];
  const entries: CacheEntryInfo[] = [];

  try {
    await processGcsCachePrefix(bucket, fetchCachePrefix, 'fetch', keys, entries, limit);
    await processGcsCachePrefix(bucket, routeCachePrefix, 'route', keys, entries, limit);
    await processGcsCachePrefix(bucket, imageCachePrefix, 'image', keys, entries, limit);

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

/** Read up to `limit` entries under `prefix`, one listed page at a time, with bounded downloads in flight. */
async function processGcsCachePrefix(
  bucket: Bucket,
  prefix: string,
  cacheType: CacheEntryType,
  keys: string[],
  entries: CacheEntryInfo[],
  limit: number
): Promise<void> {
  let read = 0;
  try {
    for await (const files of listPrefixPages(bucket, prefix)) {
      const jsonFiles = files.filter((file) => file.name.endsWith('.json')).slice(0, limit - read);
      read += jsonFiles.length;
      const infos = await mapInBatches(jsonFiles, DEFAULT_DELETE_CONCURRENCY, (file) =>
        readGcsEntryInfo(file, prefix, cacheType)
      );
      for (const info of infos) {
        // readGcsEntryInfo never rejects.
        if (info.status === 'fulfilled') {
          keys.push(info.value.key);
          entries.push(info.value);
        }
      }
      if (read >= limit) {
        return;
      }
    }
  } catch (error) {
    gcsLog.warn(`Error reading ${cacheType} cache:`, error);
  }
}

async function readGcsEntryInfo(
  file: { name: string; download: () => Promise<[Buffer]> },
  prefix: string,
  cacheType: CacheEntryType
): Promise<CacheEntryInfo> {
  const cacheKey = file.name.replace(prefix, '').replace('.json', '').replace(/_/g, '-');
  const displayKey = `${cacheType}:${cacheKey}`;

  try {
    const [data] = await file.download();
    const cacheData = JSON.parse(data.toString());

    return {
      key: displayKey,
      tags: cacheData.tags || [],
      lastModified: cacheData.lastModified || Date.now(),
      type: cacheType,
    };
  } catch {
    return {
      key: displayKey,
      tags: [],
      type: cacheType,
    };
  }
}

/**
 * Count the objects in each cache and read the size of the tags map and the
 * recorded build, without downloading entries: one GCS list request per 1,000
 * objects, plus two small reads. Route objects are also counted by the build
 * that wrote them, so leftovers from earlier builds show up. Rejects when GCS
 * can't be read, rather than reporting zeros.
 *
 * Each call lists the whole cache: protect any route that exposes it.
 */
export async function getSharedCacheCounts(): Promise<SharedCacheCounts> {
  const bucketName = process.env.CACHE_BUCKET;
  if (!bucketName) {
    gcsLog.debug('CACHE_BUCKET environment variable not found');
    return emptySharedCacheCounts();
  }
  const bucket = getSharedStorage(bucketName, 'entries').bucket(bucketName);
  const envPrefix = getEnvironmentPrefix();

  const byGeneration: Record<string, number> = {};
  const routeObjects = await countObjects(bucket, `${envPrefix}route-cache/`, (file) => {
    const generation = (file.metadata?.metadata as Record<string, unknown> | undefined)?.generation;
    const key = typeof generation === 'string' ? generation : 'unstamped';
    byGeneration[key] = (byGeneration[key] ?? 0) + 1;
  });

  return {
    route: { objects: routeObjects, byGeneration },
    fetch: { objects: await countObjects(bucket, `${envPrefix}fetch-cache/`) },
    image: { objects: await countObjects(bucket, `${envPrefix}image-cache/`) },
    tagsMap: await readObjectSize(bucket, `${envPrefix}cache/tags/tags.json`),
    buildMeta: await readStoredBuildMeta(bucket, `${envPrefix}build-meta.json`),
  };
}

/** Counts with nothing in them, for when there is no cache to read. */
function emptySharedCacheCounts(): SharedCacheCounts {
  return {
    route: { objects: 0, byGeneration: {} },
    fetch: { objects: 0 },
    image: { objects: 0 },
    tagsMap: null,
    buildMeta: null,
  };
}

async function countObjects(bucket: Bucket, prefix: string, onFile?: (file: File) => void): Promise<number> {
  let count = 0;
  for await (const files of listPrefixPages(bucket, prefix)) {
    count += files.length;
    if (onFile) {
      files.forEach(onFile);
    }
  }
  return count;
}

async function readObjectSize(bucket: Bucket, key: string): Promise<{ bytes: number } | null> {
  try {
    const [metadata] = await bucket.file(key).getMetadata();
    return { bytes: Number(metadata.size ?? 0) };
  } catch (error) {
    if (isNotFound(error)) {
      return null;
    }
    throw error;
  }
}

async function readStoredBuildMeta(bucket: Bucket, key: string): Promise<BuildMeta | null> {
  let data: Buffer;
  try {
    [data] = await bucket.file(key).download();
  } catch (error) {
    if (isNotFound(error)) {
      return null;
    }
    throw error;
  }
  return JSON.parse(data.toString()) as BuildMeta;
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
    clearedCount += await clearGcsFetchCache(bucket, bucketName, fetchCachePrefix, 'fetch');

    // Clear route cache (skip static routes)
    const routeResult = await clearGcsRouteCache(bucket, bucketName, routeCachePrefix, staticRoutes);
    clearedCount += routeResult.cleared;

    // Clear image cache (content-derived, no build/static-route scoping needed)
    clearedCount += await clearGcsFetchCache(bucket, bucketName, imageCachePrefix, 'image');

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

async function clearGcsFetchCache(
  bucket: Bucket,
  bucketName: string,
  prefix: string,
  cacheType: 'fetch' | 'image'
): Promise<number> {
  try {
    const r = await deletePrefix(bucket, prefix, {
      concurrency: resolveDeleteConcurrency(),
      shouldDelete: (file) => file.name.endsWith('.json'),
    });
    logClearFailures(bucketName, prefix, r);

    gcsLog.debug(`Cleared ${r.deleted} ${cacheType} cache entries`);
    return r.deleted;
  } catch (error) {
    gcsLog.warn(`Error clearing ${cacheType} cache:`, error);
    return 0;
  }
}

async function clearGcsRouteCache(
  bucket: Bucket,
  bucketName: string,
  prefix: string,
  staticRoutes: Set<string>
): Promise<{ cleared: number; preserved: number }> {
  let cleared = 0;
  let preserved = 0;

  try {
    const r = await deletePrefix(bucket, prefix, {
      concurrency: resolveDeleteConcurrency(),
      shouldDelete: (file) => {
        if (!file.name.endsWith('.json')) {
          return false;
        }
        if (staticRoutes.has(file.name.replace(prefix, '').replace('.json', ''))) {
          preserved++;
          return false;
        }
        return true;
      },
    });
    cleared = r.deleted;
    logClearFailures(bucketName, prefix, r);

    gcsLog.debug(`Route cache: cleared ${cleared}, preserved ${preserved} static routes`);
  } catch (error) {
    gcsLog.warn('Error clearing route cache:', error);
  }

  return { cleared, preserved };
}

function logClearFailures(bucketName: string, prefix: string, r: DeletePrefixResult): void {
  if (r.failed === 0) {
    return;
  }
  gcsLog.error(
    [
      `clearSharedCache: ${r.failed} of the objects under gs://${bucketName}/${prefix} could not be deleted ` +
        `(${describeFailures(r.failures)}; first error: ${errorMessage(r.firstError)}) and are still served.`,
      ...deleteFailureHints(bucketName, Object.keys(r.failures)),
      'Run clearSharedCache() again to retry them.',
    ].join(' ')
  );
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
