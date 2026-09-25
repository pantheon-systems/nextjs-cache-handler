import type {
  CacheData,
  CacheEntryType,
  CacheHandlerParametersGet,
  CacheHandlerParametersSet,
  CacheHandlerParametersRevalidateTag,
  CacheHandlerValue,
  FileSystemCacheContext,
  Revalidate,
  SerializedCacheData,
} from '../types.js';
import { serializeForStorage, deserializeFromStorage } from '../utils/serialization.js';
import { getBuildId, isBuildPhase } from '../utils/build-detection.js';
import { createLogger, type Logger } from '../utils/logger.js';
import { tagsManifest } from 'next/dist/server/lib/incremental-cache/tags-manifest.external.js';
import {
  mergeRemoteTagsManifest,
  mergeManifestForWrite,
  snapshotLocalTagsManifest,
  type TagsManifestRecord,
} from '../utils/tags-manifest-sync.js';

// Global singleton to track if build invalidation has been checked for this process
let buildInvalidationChecked = false;

/**
 * How often a replica pulls the shared tags-manifest snapshot into its own
 * process-local `tagsManifest` Map (see `get()`/`maybeSyncTagsManifest()`
 * below). This bounds how long a `revalidateTag()`/`updateTag()` call on one
 * replica can take to become visible on another — without this sync, it would
 * never become visible at all. Kept short enough that "on-demand" revalidation
 * still feels close to immediate, long enough that it doesn't turn every
 * `get()` into a network round trip.
 */
const MANIFEST_SYNC_INTERVAL_MS = 2000;

/**
 * Minimal shape of Next.js's built-in FileSystemCache that we delegate to for
 * reading build-time prerenders (see BaseCacheHandler.get).
 */
interface FileSystemCacheLike {
  get(key: string, ctx: unknown): Promise<CacheHandlerValue | null>;
}
type FileSystemCacheCtor = new (context: FileSystemCacheContext) => FileSystemCacheLike;

// Lazily-resolved Next.js FileSystemCache constructor. The module is CJS
// (`exports.default = FileSystemCache`); imported from ESM it surfaces as
// `mod.default.default`, but we probe every interop shape defensively. Loaded
// via dynamic import so it never lands in the edge bundle (Node-only path).
let fileSystemCacheCtorPromise: Promise<FileSystemCacheCtor | null> | null = null;
function loadFileSystemCacheCtor(): Promise<FileSystemCacheCtor | null> {
  if (!fileSystemCacheCtorPromise) {
    fileSystemCacheCtorPromise = import('next/dist/server/lib/incremental-cache/file-system-cache.js')
      .then((mod: unknown) => {
        const m = mod as { default?: { default?: FileSystemCacheCtor } & FileSystemCacheCtor } & FileSystemCacheCtor;
        return m?.default?.default ?? m?.default ?? m ?? null;
      })
      .catch(() => null);
  }
  return fileSystemCacheCtorPromise;
}

/**
 * Reset the build invalidation check flag.
 * Useful for testing purposes.
 * @internal
 */
export function resetBuildInvalidationCheck(): void {
  buildInvalidationChecked = false;
}

export interface BuildMeta {
  buildId: string;
  timestamp: number;
}

/**
 * Abstract base class for cache handlers.
 * Provides shared functionality for tag mapping, serialization, and build invalidation.
 */
export abstract class BaseCacheHandler {
  protected readonly context: FileSystemCacheContext;
  protected readonly handlerName: string;
  protected readonly log: Logger;

  // Read-through fallback to Next's built-in FileSystemCache for build-time
  // prerenders (lazily constructed on first miss). See getBuildPrerender.
  // Memoized as an in-flight PROMISE (not a boolean flag) so concurrent
  // callers racing on the first miss all await the same construction instead
  // of a second caller observing the "already initializing" flag and reading
  // the not-yet-assigned instance field as null (a false miss).
  private buildPrerenderFallbackPromise: Promise<FileSystemCacheLike | null> | null = null;

  // Tracks the in-flight initialize() call so get()/set() can await it before
  // touching the store. Without this, a request's get() could race ahead of
  // checkBuildInvalidation() below and read a stale route-cache entry left
  // over from the previous build, before this process has had a chance to
  // wipe it -- initialize() itself can't be awaited from the constructor (JS
  // constructors can't be async), so this is the only place that gap can
  // close. Cleared to null once awaited so later get()/set() calls short-circuit.
  private initPromise: Promise<void> | null = null;

  // Throttles the shared-tags-manifest pull in get() to at most once per
  // MANIFEST_SYNC_INTERVAL_MS. Tracked as an in-flight promise (like
  // buildPrerenderFallbackPromise above) rather than a boolean so concurrent
  // callers within the same window await the same read instead of each firing
  // their own.
  private manifestSyncPromise: Promise<void> | null = null;
  private lastManifestSyncAt = 0;

  // Whether this instance has completed at least one shared-manifest sync.
  // The FIRST sync is awaited (a cold replica has no local knowledge at all, so
  // it could otherwise serve content it would have known was invalidated);
  // every later one runs in the background -- see maybeSyncTagsManifest().
  private hasSyncedTagsManifest = false;

  constructor(context: FileSystemCacheContext, handlerName: string) {
    this.context = context;
    this.handlerName = handlerName;
    this.log = createLogger(handlerName);

    // Only log during server runtime, not during build (too noisy with parallel workers)
    if (!isBuildPhase()) {
      this.log.info('Initializing cache handler');
    }
  }

  /**
   * Subclass constructors must assign the result of initialize() here
   * (`this.initPromise = this.initialize().catch(() => {})`) instead of
   * calling initialize() directly, so get()/set() below can await it.
   */
  protected setInitPromise(promise: Promise<void>): void {
    this.initPromise = promise;
  }

  private async ensureInitialized(): Promise<void> {
    if (this.initPromise) {
      await this.initPromise;
      this.initPromise = null;
    }
  }

  /**
   * Pulls the shared tags-manifest snapshot and merges it into this
   * process's local `tagsManifest` Map, at most once per
   * MANIFEST_SYNC_INTERVAL_MS. Failures are logged and swallowed -- a sync
   * miss just means this replica stays unaware of a revalidation for another
   * interval, not a request-affecting error.
   *
   * Only the FIRST sync on an instance is awaited. A cold replica has no local
   * knowledge of any invalidation, so blocking that one request is worth it.
   * After that, refreshes run in the background and the calling request is not
   * held up: the merge is one-directional and idempotent, so awaiting it only
   * tightens the visibility window by a single round trip -- and the
   * MANIFEST_SYNC_INTERVAL_MS throttle already means an invalidation can be up
   * to that interval late. Paying two blocking GCS round trips on one request
   * every interval, forever, on the hottest path in the handler was not a good
   * trade for that.
   */
  private async maybeSyncTagsManifest(): Promise<void> {
    // Nothing to sync during the build: there are no other replicas, so the
    // shared manifest cannot contain anything this process doesn't know. It
    // also MUST not run here -- an unguarded blocking GCS read on the get()
    // path is exactly the prerender stall that withBuildTimeout/
    // BUILD_IO_TIMEOUT_MS exist to prevent (see gcs.ts readCacheEntry). The
    // failure mode there is wall-clock blocking, not a thrown error, so
    // catching it below would not have helped.
    if (isBuildPhase()) {
      return;
    }

    const inFlight = this.manifestSyncPromise;
    if (inFlight) {
      // Join the in-flight read only if we haven't got a baseline yet.
      if (!this.hasSyncedTagsManifest) {
        await inFlight;
      }
      return;
    }

    if (Date.now() - this.lastManifestSyncAt < MANIFEST_SYNC_INTERVAL_MS) {
      return;
    }

    const sync = (async () => {
      try {
        const remote = await this.readTagsManifest();
        // null means "unchanged since this instance last read it" -- nothing to
        // merge, and no download was performed (see gcs.ts readTagsManifest).
        if (remote !== null) {
          const changed = mergeRemoteTagsManifest(remote);
          if (changed > 0) {
            this.log.debug(`Synced ${changed} tag(s) from shared tags-manifest`);
          }
        }
      } catch (error) {
        this.log.warn('Error syncing shared tags-manifest:', error);
      } finally {
        this.lastManifestSyncAt = Date.now();
        this.hasSyncedTagsManifest = true;
      }
    })();

    this.manifestSyncPromise = sync;
    const settled = sync.finally(() => {
      if (this.manifestSyncPromise === sync) {
        this.manifestSyncPromise = null;
      }
    });

    if (!this.hasSyncedTagsManifest) {
      await settled;
    } else {
      // Background refresh. The body above already swallows every error, so
      // this can't produce an unhandled rejection.
      void settled;
    }
  }

  /**
   * Initialize the handler. Should be called after construction.
   * Handles build invalidation check and tags mapping initialization.
   */
  protected async initialize(): Promise<void> {
    await this.initializeTagsMapping();

    // Only check build invalidation once per process
    // Skip during build phase to avoid race conditions with parallel workers
    if (!buildInvalidationChecked && !isBuildPhase()) {
      await this.checkBuildInvalidation();
      buildInvalidationChecked = true;
    }
  }

  // ============================================================================
  // Abstract methods to be implemented by subclasses
  // ============================================================================

  protected abstract initializeTagsMapping(): Promise<void>;
  protected abstract readTagsMapping(): Promise<Record<string, string[]>>;
  protected abstract writeTagsMapping(tagsMapping: Record<string, string[]>): Promise<void>;

  /**
   * Shared-store persistence for tag staleness ({@link TagsManifestRecord}) --
   * distinct from {@link readTagsMapping}/{@link writeTagsMapping}, which map
   * tag -> cache keys. This is what makes `revalidateTag()` visible across
   * replicas; see `maybeSyncTagsManifest()` and `revalidateTag()` below.
   *
   * Resolves to `null` when the shared snapshot has not changed since this
   * instance last read it, so the caller can skip the merge and the
   * implementation can skip transferring the (potentially large) body. Only
   * valid for the sync path, whose merge is one-directional -- a read-modify-
   * write must use {@link updateTagsManifest}, which always reads
   * authoritatively.
   */
  protected abstract readTagsManifest(): Promise<TagsManifestRecord | null>;

  /**
   * Atomically read-modify-write the shared tags-manifest: `mutate` receives
   * the current stored record and returns the record to store.
   *
   * Must be atomic with respect to other replicas. A plain read-then-write
   * loses updates -- two replicas revalidating DIFFERENT tags inside the same
   * round trip would each write a record missing the other's tag, and since
   * nothing rewrites it afterwards the dropped invalidation is never seen by
   * anyone else. Implementations use optimistic concurrency (GCS generation
   * preconditions) and retry `mutate` against the fresher record on conflict,
   * which is why `mutate` must be a pure function of its input and safe to
   * call more than once.
   */
  protected abstract updateTagsManifest(mutate: (current: TagsManifestRecord) => TagsManifestRecord): Promise<void>;

  protected abstract readCacheEntry(cacheKey: string, cacheType: CacheEntryType): Promise<CacheHandlerValue | null>;
  protected abstract writeCacheEntry(
    cacheKey: string,
    cacheValue: CacheHandlerValue,
    cacheType: CacheEntryType
  ): Promise<void>;

  protected abstract readBuildMeta(): Promise<BuildMeta>;
  protected abstract writeBuildMeta(meta: BuildMeta): Promise<void>;
  protected abstract invalidateRouteCache(): Promise<void>;

  // ============================================================================
  // Shared tag mapping methods
  // ============================================================================

  protected async updateTagsMapping(cacheKey: string, tags: string[], isDelete = false): Promise<void> {
    try {
      const tagsMapping = await this.readTagsMapping();

      if (isDelete) {
        this.removeKeysFromAllTags(tagsMapping, [cacheKey]);
      } else {
        this.addKeyToTags(tagsMapping, cacheKey, tags);
      }

      await this.writeTagsMapping(tagsMapping);
    } catch (error) {
      this.log.error('Error updating tags mapping:', error);
    }
  }

  /**
   * Removes cache keys from all tag mappings they're associated with.
   * This is used when cache entries are deleted to keep the tag mapping consistent.
   * Empty tags are cleaned up automatically.
   */
  private removeKeysFromAllTags(tagsMapping: Record<string, string[]>, keysToRemove: string[]): void {
    const keysSet = new Set(keysToRemove);

    for (const tag of Object.keys(tagsMapping)) {
      tagsMapping[tag] = tagsMapping[tag].filter((key) => !keysSet.has(key));
      if (tagsMapping[tag].length === 0) {
        delete tagsMapping[tag];
      }
    }
  }

  private addKeyToTags(tagsMapping: Record<string, string[]>, cacheKey: string, tags: string[]): void {
    for (const tag of tags) {
      if (!tagsMapping[tag]) {
        tagsMapping[tag] = [];
      }
      if (!tagsMapping[tag].includes(cacheKey)) {
        tagsMapping[tag].push(cacheKey);
      }
    }
  }

  // ============================================================================
  // Build invalidation
  // ============================================================================

  private async checkBuildInvalidation(): Promise<void> {
    const currentBuildId = getBuildId();

    try {
      const buildMeta = await this.readBuildMeta();

      if (buildMeta.buildId !== currentBuildId) {
        this.log.info(`New build detected (${buildMeta.buildId} -> ${currentBuildId}), invalidating route cache`);

        await this.invalidateRouteCache();

        await this.writeBuildMeta({
          buildId: currentBuildId,
          timestamp: Date.now(),
        });
      }
    } catch {
      // No previous build metadata - first run, just save current build ID
      await this.writeBuildMeta({
        buildId: currentBuildId,
        timestamp: Date.now(),
      });
    }
  }

  // ============================================================================
  // Serialization helpers
  // ============================================================================

  protected serializeForStorage(data: CacheData): SerializedCacheData {
    return serializeForStorage(data);
  }

  protected deserializeFromStorage(data: SerializedCacheData): CacheData {
    return deserializeFromStorage(data);
  }

  // ============================================================================
  // Cache type determination
  // ============================================================================

  protected determineCacheType(ctx?: CacheHandlerParametersGet[1]): CacheEntryType {
    if (!ctx) {
      return 'route';
    }

    // The image optimizer (`images.customCacheHandler: true`) calls get() with
    // `{ kind: 'IMAGE', isFallback: false }` — check this before the fetch checks
    // below, since it doesn't carry any of the fetchCache/fetchUrl/fetchIdx fields.
    if ('kind' in ctx && ctx.kind === 'IMAGE') {
      return 'image';
    }

    if ('fetchCache' in ctx && ctx.fetchCache === true) {
      return 'fetch';
    }

    if ('fetchUrl' in ctx) {
      return 'fetch';
    }

    if ('fetchIdx' in ctx) {
      return 'fetch';
    }

    return 'route';
  }

  protected determineCacheTypeFromValue(incrementalCacheValue: CacheHandlerParametersSet[1]): CacheEntryType {
    if (incrementalCacheValue && typeof incrementalCacheValue === 'object' && 'kind' in incrementalCacheValue) {
      if (incrementalCacheValue.kind === 'FETCH') {
        return 'fetch';
      }
      if (incrementalCacheValue.kind === 'IMAGE') {
        return 'image';
      }
    }
    return 'route';
  }

  // ============================================================================
  // Tag extraction from cached data headers
  // ============================================================================

  /**
   * Extracts cache tags from the cached data's headers.
   * Next.js stores tags in x-next-cache-tags header on the cached data
   * regardless of minimal mode. This is a fallback for when ctx.tags is empty
   * (common in Next.js 16.2+ for page cache entries).
   */
  private extractTagsFromDataHeaders(data: CacheHandlerParametersSet[1]): string[] {
    if (!data || typeof data !== 'object') {
      this.log.debug('extractTagsFromDataHeaders: no data or not an object');
      return [];
    }

    const record = data as unknown as Record<string, unknown>;
    const kind = typeof record.kind === 'string' ? record.kind : 'unknown';
    const headers = record.headers as Record<string, string | undefined> | undefined;

    if (!headers) {
      this.log.debug(`extractTagsFromDataHeaders: no headers on data (kind=${kind})`);
      return [];
    }

    const tagHeader = headers['x-next-cache-tags'];
    if (!tagHeader) {
      this.log.debug(`extractTagsFromDataHeaders: data.headers exists but no x-next-cache-tags (kind=${kind})`);
      return [];
    }

    const tags = tagHeader.split(',');
    this.log.info(`extractTagsFromDataHeaders: found ${tags.length} tags from data.headers (kind=${kind})`);
    this.log.debug('extractTagsFromDataHeaders: tags:', tags);
    return tags;
  }

  // ============================================================================
  // CacheHandler interface implementation
  // ============================================================================

  async get(
    cacheKey: CacheHandlerParametersGet[0],
    ctx?: CacheHandlerParametersGet[1]
  ): Promise<CacheHandlerValue | null> {
    this.log.debug(`GET: ${cacheKey}`);

    // Without this, a request racing the very first GET on a cold instance
    // could read a route-cache entry left over from the previous build,
    // before checkBuildInvalidation() (in initialize()) has had a chance to
    // wipe it.
    await this.ensureInitialized();

    // Pull any tag revalidations another replica has recorded since our last
    // sync into this process's own tagsManifest, so the areTagsExpired/
    // areTagsStale checks Next's IncrementalCache runs right after this
    // returns see them. Throttled, not per-request -- see
    // MANIFEST_SYNC_INTERVAL_MS.
    await this.maybeSyncTagsManifest();

    try {
      const cacheType = this.determineCacheType(ctx);
      const entry = await this.readCacheEntry(cacheKey, cacheType);

      if (!entry) {
        // Our store only holds entries written at *runtime*. The initial value
        // for a statically prerendered route/handler is emitted at build to
        // `<serverDistDir>/app|pages/<key>.body|.html|.meta` and is never
        // written through this handler — so a plain store miss here would send
        // Next off to regenerate the route on demand, discarding the build-time
        // output (e.g. a `'use cache'` value computed during the build phase).
        // Next's own FileSystemCache seeds itself from those files; since we
        // replace it, we must reproduce that read-through.
        //
        // Doesn't apply to images: `/_next/image` requests are always resolved
        // on demand (never build-time prerendered), and this fallback delegates
        // to Next's page/fetch FileSystemCache, which doesn't understand the
        // `kind: 'IMAGE'` ctx shape.
        if (cacheType !== 'image') {
          const prerender = await this.getBuildPrerender(cacheKey, ctx);
          if (prerender) {
            this.log.debug(`HIT (build prerender): ${cacheKey} (${cacheType})`);
            return prerender;
          }
        }

        this.log.debug(`MISS: ${cacheKey} (${cacheType})`);
        return null;
      }

      this.log.debug(`HIT: ${cacheKey} (${cacheType})`, {
        entryType: typeof entry,
        hasValue: entry && typeof entry === 'object' && 'value' in entry,
      });

      return entry;
    } catch (error) {
      this.log.error(`Error reading cache for key ${cacheKey}:`, error);
      return null;
    }
  }

  /**
   * Read-through to Next.js's built-in FileSystemCache for build-time
   * prerendered routes, used only when our own store misses.
   *
   * Safe against revalidation: the FileSystemCache we build shares the process
   * `tagsManifest` external singleton that {@link revalidateTag} writes to, so
   * FileSystemCache's own `areTagsExpired` check suppresses a build prerender
   * whose tag has since been revalidated (returns null) rather than resurrecting
   * stale content. Applies to both file- and GCS-backed handlers because
   * build-time prerenders always live on local disk in the deployed image.
   */
  private async getBuildPrerender(
    cacheKey: CacheHandlerParametersGet[0],
    ctx?: CacheHandlerParametersGet[1]
  ): Promise<CacheHandlerValue | null> {
    try {
      const fallback = await this.loadBuildPrerenderFallback();
      if (!fallback) {
        return null;
      }

      const entry = await fallback.get(cacheKey, ctx);
      return entry ?? null;
    } catch (error) {
      this.log.debug(`Build-prerender fallback failed for ${cacheKey}:`, error);
      return null;
    }
  }

  private loadBuildPrerenderFallback(): Promise<FileSystemCacheLike | null> {
    if (!this.buildPrerenderFallbackPromise) {
      this.buildPrerenderFallbackPromise = (async () => {
        const Ctor = await loadFileSystemCacheCtor();
        if (!Ctor) {
          return null;
        }
        try {
          return new Ctor(this.context);
        } catch (error) {
          this.log.warn('Build-prerender fallback unavailable:', error);
          return null;
        }
      })();
    }

    return this.buildPrerenderFallbackPromise;
  }

  async set(
    cacheKey: CacheHandlerParametersSet[0],
    incrementalCacheValue: CacheHandlerParametersSet[1],
    ctx: CacheHandlerParametersSet[2] & {
      tags?: string[];
      revalidate?: Revalidate;
    }
  ): Promise<void> {
    // Same race as get() above -- a write racing ahead of build invalidation
    // could persist a fresh entry that the still-pending wipe would then
    // incorrectly delete.
    await this.ensureInitialized();

    const cacheType = this.determineCacheTypeFromValue(incrementalCacheValue);

    this.log.debug(`SET: ${cacheKey} (${cacheType})`, {
      valueType: typeof incrementalCacheValue,
      hasKind: incrementalCacheValue && typeof incrementalCacheValue === 'object' && 'kind' in incrementalCacheValue,
    });

    try {
      const { tags: ctxTags = [] } = ctx;

      // Extract tags from the cached data's headers as well.
      // In Next.js 16.2+, ctx.tags may be empty for page cache entries
      // (see https://github.com/vercel/next.js/issues/78864), but the tags
      // are always present in data.headers['x-next-cache-tags'].
      // We merge both sources (deduplicated) to ensure we never miss tags,
      // whether they come from ctx or from the cached data headers.
      const headerTags = this.extractTagsFromDataHeaders(incrementalCacheValue);
      const tags = [...new Set([...ctxTags, ...headerTags])];

      const cacheHandlerValue: CacheHandlerValue = {
        value: incrementalCacheValue,
        lastModified: Date.now(),
        tags: Object.freeze(tags),
      };

      await this.writeCacheEntry(cacheKey, cacheHandlerValue, cacheType);

      if (tags.length > 0) {
        await this.updateTagsMapping(cacheKey, tags);
        this.log.debug(`Updated tags mapping for ${cacheKey} with tags:`, tags);
      }

      // For route cache updates (ISR), trigger edge cache invalidation
      if (cacheType === 'route') {
        this.onRouteCacheSet(cacheKey);
      }

      this.log.debug(`Cached ${cacheKey} in ${cacheType} cache`);
    } catch (error) {
      this.log.error(`Error setting cache for key ${cacheKey}:`, error);
    }
  }

  async revalidateTag(
    tag: CacheHandlerParametersRevalidateTag[0],
    durations?: CacheHandlerParametersRevalidateTag[1]
  ): Promise<void> {
    this.log.debug(`REVALIDATE TAG: ${tag}`);

    const tagArray = [tag].flat();
    const affectedKeys: string[] = [];

    let tagsMapping: Record<string, string[]>;
    try {
      tagsMapping = await this.readTagsMapping();
    } catch (error) {
      this.log.error('Error reading tags mapping during revalidateTag:', error);
      tagsMapping = {};
    }

    for (const currentTag of tagArray) {
      const cacheKeysForTag = tagsMapping[currentTag] || [];

      if (cacheKeysForTag.length === 0) {
        this.log.debug(`No cache entries found for tag: ${currentTag}`);
        continue;
      }

      this.log.debug(`Found ${cacheKeysForTag.length} cache entries for tag: ${currentTag}`);
      affectedKeys.push(...cacheKeysForTag);
    }

    // Update Next.js's shared tagsManifest so the staleness checks the
    // IncrementalCache wrapper runs on every subsequent get() (areTagsStale /
    // areTagsExpired) recognise this tag as invalidated. We deliberately do
    // NOT delete the underlying stored entries here (unlike Next's own
    // built-in FileSystemCache.revalidateTag, which also never deletes
    // anything): the last-good value must stay servable so Next can serve it
    // once while revalidating in the background, and — for cacheComponents
    // (PPR) routes — so a dynamic request can still find the cached postponed
    // state to resume from instead of being forced into a full fresh render.
    //
    // `durations.expire` (present when the caller passed a cacheLife profile,
    // e.g. `revalidateTag(tag, 'minutes')`) sets a FUTURE expiry, which keeps
    // areTagsExpired() false and areTagsStale() true — a soft/background
    // revalidation. Omitting it while `durations` is still present (no
    // `expire` on the profile) leaves any previously-set expiry untouched.
    // No `durations` at all (e.g. `updateTag()`, which never carries a
    // profile) forces an immediate/hard expiry — correct there, since
    // updateTag's whole point is read-your-own-writes within the same action.
    // This mirrors Next's own FileSystemCache.revalidateTag exactly.
    const now = Date.now();
    for (const currentTag of tagArray) {
      const existingEntry = tagsManifest.get(currentTag) ?? {};
      if (durations) {
        const updates: { stale: number; expired?: number } = { ...existingEntry, stale: now };
        if (durations.expire !== undefined) {
          updates.expired = now + durations.expire * 1000;
        }
        tagsManifest.set(currentTag, updates);
      } else {
        tagsManifest.set(currentTag, { ...existingEntry, expired: now });
      }
    }

    // Persist the same staleness update to the shared store so every OTHER
    // replica's own get() eventually picks it up via maybeSyncTagsManifest()
    // -- without this, only this process's own in-memory tagsManifest knows
    // about the revalidation, and every other replica keeps serving the
    // pre-revalidation value as fresh forever. Not buffered
    // like updateTagsMapping()/TagsBuffer: revalidateTag() is a deliberate,
    // comparatively rare call (unlike set(), which runs on every cache
    // write), so a plain read-merge-write here is an acceptable cost and
    // keeps the propagation delay to one round trip instead of up to a full
    // buffer-flush interval on top of it.
    //
    // Done as an atomic read-modify-write (see updateTagsManifest): a plain
    // read-then-write drops one of two concurrent revalidations of different
    // tags, and nothing would ever rewrite the lost one.
    //
    // Skipped during the build for the same two reasons maybeSyncTagsManifest()
    // skips it: there is no other replica to inform, and blocking GCS I/O on a
    // prerender path is what trips cacheComponents' "uncached data outside
    // <Suspense>". Nothing is lost by skipping -- an entry written
    // later in the same build has a lastModified AFTER this invalidation, so
    // the staleness wouldn't apply to it anyway.
    if (!isBuildPhase()) {
      try {
        const localSnapshot = snapshotLocalTagsManifest(tagArray);
        await this.updateTagsManifest((current) => mergeManifestForWrite(current, localSnapshot));
      } catch (error) {
        this.log.warn('Error persisting shared tags-manifest during revalidateTag:', error);
      }
    }

    this.log.info(`Revalidated ${affectedKeys.length} entries for tags: ${tagArray.join(', ')}`);

    // Hook for subclasses to perform additional cleanup (e.g., edge cache clearing)
    await this.onRevalidateComplete(tagArray, affectedKeys);
  }

  /**
   * Hook called after revalidation is complete.
   * Subclasses can override to perform additional cleanup.
   */
  protected async onRevalidateComplete(_tags: string[], _affectedKeys: string[]): Promise<void> {
    // Default implementation does nothing
  }

  /**
   * Hook called when a route cache entry is set (ISR page update).
   * Subclasses can override to perform edge cache invalidation.
   */
  protected onRouteCacheSet(_cacheKey: string): void {
    // Default implementation does nothing
  }

  resetRequestCache(): void {
    this.log.debug('RESET REQUEST CACHE: No-op for this cache handler');
    // For persistent cache handlers, this is typically a no-op since we're not maintaining
    // per-request caches. The storage backend is the source of truth.
  }
}
