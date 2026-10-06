# Changelog

## 0.13.1

### Fixed

- `use cache` results computed during `next build` are no longer served at runtime. Next calls the `use cache` handlers while it prerenders, including for routes it then treats as dynamic, and the GCS (and shared file) store kept those entries under the runtime's generation ID, so a dynamic page could render a build-time value (`app-dir/use-cache-private` showed `buildtime` instead of `runtime`). During the build phase the `use cache` handlers now neither persist nor read entries. Build-time values still reach the runtime through Next's prerender output.
- The GCS `use cache` handler no longer runs its build-invalidation check during `next build`. The build used to record the new generation in `_build-meta.json` and purge the CDN before the new revision was serving, so the runtime saw a matching generation and never purged. The runtime that serves the build now does both, as the route handler already did.
- A build no longer deletes `use cache` entries that the live revision is still serving (a build-phase read used to delete any entry with a different generation).
- CDN path purges target the page's URL on Next.js 16.3.8+, which keys route cache entries as `/route-cache/<kind>/<hash>/$<path>`. The GCS handler purged that key as if it were a path, so neither ISR regeneration (including Pages Router `res.revalidate()`) nor `revalidateTag()`/`revalidatePath()` cleared the CDN.
- The root page's cache key (`/index`) now purges `/`, not `/index`.
- `revalidateTag()` and `revalidatePath()` now purge pages prerendered at build. Those pages are served from the build output and never pass through `set()`, so the tag mapping had no keys for them until they regenerated (never, for a fully static page). Each process now indexes their tags from `prerender-manifest.json` and the `.meta` files, with no writes to shared storage.
- `revalidatePath()` purges its own path even when no cache key is recorded for it, using the `_N_T_` tag (including the `/page` and `/layout` type forms). `revalidatePath('/', 'layout')` purges the whole site.
- Tag (key) purges are sent even when no cache keys are found. They clear nothing today, but match once responses carry tags as `Surrogate-Key`.
- Partial-fallback shell keys (such as `/prefix/c/[two]`) are no longer purged as paths, as they match no URL. The `_`-prefixed key handling is removed: route keys always start with `/`.
- A revalidation made on one instance now applies on every instance. Next.js records revalidations in a per-process manifest, so an instance that did not receive the `revalidateTag()` kept serving the old page, and the CDN cached it again after the purge. Revalidations are now stored in `cache/tags/revalidations.json` and applied by each instance before it serves from the cache.
- A page cached on one instance shortly before its tag is revalidated on another is now purged. The revalidating instance read a tags mapping that did not have the key yet; the instance that flushes the key now purges it when one of its tags was revalidated after it was cached.
- Regenerating a Pages Router page also purges its `/_next/data/<buildId>/…json` data route, which client-side navigations fetch and the CDN caches.
- CDN purges use the served URL on sites with `trailingSlash: true` (`/tags/`, not `/tags`) or a `basePath`.
- `clearSharedCache()` keeps the cached entries of fully static routes again on Next.js 16.3.8+, whose route keys no longer matched the static-route list.
- Every handler instance finds the build output. Next.js 16.3.8 constructs some instances without `serverDistDir` (seen with the handler bundled through `transpilePackages`); those now read `.next/server` under the working directory, so `revalidateTag()` on them also purges build-time prerenders.

### Changed

- New optional `CACHE_TAGS_REFRESH_INTERVAL_MS` (default `1000`, minimum `100`): how often each process reads revalidations made by other processes.
- `revalidateTag()` stores the revalidation in GCS before reading the tags mapping (batching revalidations that arrive within 250 ms into one write, and retrying a failed write for up to 5 s), purges the CDN, then purges it again once every instance has applied the revalidation (two refresh intervals, 2 s by default). A server action that revalidates responds that much later. A revalidation that could not be stored is retried on later cache reads and at `flushSharedTagsMapping()`, and its second purge runs once it is stored.
- A cache read waits at most 2 s for revalidations from other instances before serving with what the instance already knows.
- At each deploy, the first instance of the new build prunes `revalidations.json` to the revalidations made since the previous build, deleting first the `fetch`/`unstable_cache` entries listed under the pruned tags (the only entries that survive a deploy and can be older). `build-meta.json` gains `builtAt`, so pruning starts at the second deploy after upgrading.

## 0.13.0

### Fixed

- GCS tag-mapping writes (`cache/tags/tags.json`) no longer exceed GCS's one-write-per-second-per-object limit under load. Next.js constructs a cache handler per request, so the write buffer was per request rather than per process, and concurrent buffers overwrote each other's tag entries. The GCS handler now shares one buffer per process, writes with an `ifGenerationMatch` precondition (re-reading and re-applying on conflict), skips writes that would not change the mapping, no longer writes on `revalidateTag()` (pending updates are overlaid on the read instead), and retries failed writes with capped exponential backoff instead of every two seconds forever. Failures log one warning per streak instead of one error per attempt.
- A failed read of the tag mapping no longer wipes it. Any transport or parse error used to be treated as an empty map, and the pending updates were written over the real one. Transport errors now fail the flush and the updates stay queued. An unparseable map is replaced under a generation precondition, with a warning.
- Storage clients are shared per process and split by purpose: one for unconditional cache-entry and build-meta writes, one for the conditional tag-map and tag-timestamp writes. The client library disables retries on its shared state for unconditional uploads, so sharing one client could strip retries from the conditional writes. The tags client does not retry 429s itself. The handler's paced backoff handles rate limits.
- The build-invalidation check on a cold start now runs once per process even when several handlers are constructed concurrently (the check is memoized as a promise instead of a flag set after an await).
- `UseCacheGcsHandler.updateTags()` serializes concurrent writes of `use-cache/_tags.json`, merges with the stored timestamps under a generation precondition instead of overwriting them, and backs off after a failure.
- A redeploy that changes the Next.js deployment ID (`deploymentId` in `next.config`, or `NEXT_DEPLOYMENT_ID`) now invalidates the route/ISR cache and the `use cache` entries, and purges the CDN. Next writes a constant `BUILD_ID` whenever a deployment ID is set, so the build-ID comparison never saw a new build. Build-scoped invalidation is now keyed on the build ID plus the deployment ID (`<BUILD_ID>:<deploymentId>`), read from `NEXT_DEPLOYMENT_ID` or `.next/routes-manifest.json`. Matches Vercel, whose ISR cache is scoped per deployment.

  **Upgrade behaviour:** sites with no deployment ID are unaffected (the key is exactly the old `BUILD_ID`, so no invalidation on upgrade). Sites with a deployment ID invalidate once on the first startup after upgrading.

### Changed

- New optional `CACHE_TAGS_FLUSH_INTERVAL_MS` (default `5000`, minimum `1000`) controls how often each process writes the tag mapping. The previous fixed interval was `1000`.
- The tag mapping and tag timestamps are no longer pretty-printed, and the tag mapping is no longer created on handler start (the first flush creates it with `ifGenerationMatch: 0`). This also removes the `exists()` call every request made on the mapping before its first cache operation.
- All small JSON writes (cache entries, build meta, tag mapping, tag timestamps) use `resumable: false`, one HTTP round trip instead of two.
- New `flushSharedTagsMapping({ timeoutMs? })` export writes pending tag-mapping updates immediately, retrying a failed write until the deadline (default 8000 ms) because several instances shutting down together take turns on the shared object, and returns how many buffers were fully flushed. For apps that handle `SIGTERM` themselves via `NEXT_MANUAL_SIG_HANDLE`. Call it from process-level code (a custom server), not from code Next.js bundles.
- The tag-mapping flush interval carries upward-only random jitter of up to 25% (`TagsBuffer` option `intervalJitter`), so processes that start together do not keep writing the shared object in the same second.
- Pending tag updates are dropped only after they have been pending for more than 10 minutes of failed writes (`TagsBuffer` option `maxPendingAgeMs`), not after a fixed number of attempts.
- `GcsCacheHandler.writeTagsMapping()` (protected, unused since updates go through the buffer) now throws instead of performing an unsafe whole-map write.
- `TagsBuffer`'s `readTagsMapping`/`writeTagsMapping` callbacks now carry the object generation (`{ mapping, generation }` / `(mapping, generation)`). Only relevant if you construct `TagsBuffer` directly.

### Added

- `getCacheGenerationId()` exported from the utils. `getBuildId()` is unchanged and still returns the plain `BUILD_ID`.

## 0.12.0

### Changed

- Bumped the `next` devDependency to `^16.3.6` (and the example app to `next@~16.3.6` with `react`/`react-dom@^19.3.0`) to test and confirm compatibility with Next.js 16.3.

### Fixed

- `get` now returns `null` for a page, route handler or Pages Router entry that carries an expired tag, as Next.js's built-in `FileSystemCache.get` does. Entries whose tags are only stale are still returned, so `revalidateTag(tag, 'max')` keeps serving the last-good value while it regenerates. Before this, an immediate invalidation (`revalidateTag(tag, { expire: 0 })`, `updateTag` or `revalidatePath`) served stale content once on Next.js 16.2, and on 16.3 re-ran every cached scope on each affected route instead of only the tagged ones.

## 0.9.0

### Changed

- `revalidateTag` no longer deletes the underlying cache entries it revalidates. This matches Next.js's own built-in `FileSystemCache.revalidateTag`, which never deletes entries either — staleness is tracked via the shared `tagsManifest` instead, so the last-good value stays servable while Next revalidates in the background (and so `cacheComponents`/PPR routes can resume from the cached postponed state).

  **If you relied on the previous behavior** (cache entries being physically deleted on `revalidateTag`), this is a behavior change: entries now remain readable until overwritten by a subsequent `set`.

- `revalidateTag` now accepts an optional second `durations` argument (`{ expire?: number }`), matching Next's `CacheHandler.revalidateTag` signature. Passing `{ expire: N }` sets a future expiry (soft/background revalidation) instead of the immediate hard expiry used when no durations are provided.

### Fixed

- Fixed a race condition in the build-prerender fallback lazy-init (`getBuildPrerender`) where concurrent first-miss callers could read a not-yet-assigned instance field as a false miss. Now memoized as an in-flight promise.
