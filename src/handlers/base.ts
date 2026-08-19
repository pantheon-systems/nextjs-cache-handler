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

// Global singleton to track if build invalidation has been checked for this process
let buildInvalidationChecked = false;

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
