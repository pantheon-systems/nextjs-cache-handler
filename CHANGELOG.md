# Changelog

## 0.14.0

### Added

- `CACHE_GCS_API_ENDPOINT` points the GCS handlers at a GCS emulator, for tests.

### Changed

- A new build no longer makes requests wait for the previous builds' route entries to be deleted.
- Only one instance at a time deletes the earlier builds' route entries.
- The warning logged when the delete finishes is now `Route cache clean-up for build <id> finished: …`, replacing `Route cache invalidation: deleted …`.
- Earlier builds' route keys are removed from `cache/tags/tags.json` by the background clean-up, after the delete, and only for keys whose entries are not the running build's. 
`CACHE_BUILD_INVALIDATION=off` skips the delete but now still prunes the tags map.

### Fixed

- The delete on a new build no longer removes pages that instances of the new build cached during the deploy. It skips objects stamped with the running build, and each delete is conditional on the object not having changed since it was listed.
- Removing earlier builds' keys from `cache/tags/tags.json` no longer removes keys the new build wrote, so revalidating their tags purges those pages from the CDN. The removals are saved in `route-cache-cleanup-removals.json` until the keys of pages cached meanwhile are added back, so a clean-up that stops part-way no longer loses those keys.
- A full CDN purge that fails when a new build is recorded, on any instance, is retried in the background by later runs of the clean-up (up to 5, waiting 1, 2, 4 and 8 minutes between them) instead of only being logged; giving up is logged as an error. A purge that fails on another instance after an earlier one gave up gets its own 5 retries.

## 0.13.4

### Added

- `CACHE_INVALIDATION_DELETE_CONCURRENCY` sets how many deletes are in flight at once when a new build deletes `route-cache/` and when `clearSharedCache()` runs (default `50`, clamped to `1`–`200`).
- `CACHE_BUILD_INVALIDATION=off` stops a new build from deleting `route-cache/`, for when the delete itself is the problem; the build is still recorded and the CDN still purged. Entries from earlier builds are still not served (see below).
- `getSharedCacheStats({ limit })` reads at most `limit` entries per cache type (fetch, route, image) instead of every object.
- `getSharedCacheCounts()` returns the number of objects in each cache, route objects by the build that wrote them, the size of the tag-to-keys mapping and the recorded build, without reading any entry (on GCS, one list request per 1,000 objects plus two small reads). Use it to watch a large cache grow, or to see how many objects an earlier build left behind. Route entries now also carry their build as GCS object metadata (`generation`), which listings return.

### Fixed

- A new build no longer runs instances out of memory when `route-cache/` is large. The handler listed every object under `route-cache/` into memory, then sent one delete request per object at once; on a site with about 69,000 objects, instances ran out of memory before the delete finished, and since `build-meta.json` is written after it, every restart saw the new build again and started over. Objects are now listed 1,000 at a time and deleted with at most `CACHE_INVALIDATION_DELETE_CONCURRENCY` in flight, so memory stays flat however many there are. A process that stops part-way keeps what it deleted, and the next one deletes only what is left.
- The route-cache delete on a new build is logged as a warning with its counts and duration (`Route cache invalidation: deleted <deleted>/<listed> objects in <ms>ms`), and so is the new build itself. Failures used to be swallowed without a log.
- Route entries from another build are no longer served. Each route entry now records the build that wrote it, and one from a different build is a cache miss. Entries a failed delete left behind, or that the other revision wrote during a rollout or rollback, could serve HTML that loads another build's scripts. Fetch and image entries are unchanged.
- Transient GCS failures (throttling, timeouts, server and network errors) are retried: page listings twice with backoff, deletes once. What still fails is logged with counts by status code, the first error, and the fix: delete permission on the bucket for 401/403 (logged as an error), or a lower `CACHE_INVALIDATION_DELETE_CONCURRENCY` for throttling.
- A failed delete no longer skips the full CDN purge on a new build. One failure used to skip it, leaving the previous build's pages in the CDN.
- A process whose build ID can't be read (`fallback-<timestamp>`, when neither `.next/BUILD_ID` nor the build manifest is readable from the working directory) skips the build check with a warning. Every such cold start used to delete `route-cache/` and purge the whole CDN. Such a process can't tell builds apart, so a deploy no longer deletes or purges anything for it, and it serves route entries from any build; the warning says to start the server from the directory that contains `.next`.
- A new build removes the previous build's route keys from `cache/tags/tags.json`. Nothing removed them before, so the file grew with every URL ever cached, and each tag revalidation purged the CDN for pages that no longer exist. Fetch keys stay, since fetch entries survive deploys. An instance whose check finishes after another instance has already recorded the new build leaves the file alone, since the new build's pages use the same keys and may already be in it.
- `clearSharedCache()` and `getSharedCacheStats()` list and delete or download a page at a time with a bounded number of requests in flight, instead of everything at once.

## 0.13.3

### Added

- CI runs the unit and integration tests against the newest Next.js 15 and 16 releases on every pull request.

### Fixed

- The package works on Next.js 15 (15.5.28 and later). 0.13.2 imported Next.js 16-only modules and failed to load on 15, although its peer dependency allowed `next@>=14.0.0`. The peer dependency is now `next@>=15.5.28 <17.0.0`.
- The `use cache` handlers accept Next.js 15's calls: `getExpiration(...tags)` with the tags spread as arguments, and `expireTags(...tags)`, which invalidates like `updateTags()`. `expireTags` is optional on the `UseCacheHandler` type, so existing implementations still compile.
- Tag revalidations are recorded in the format the running Next.js reads: `{ stale, expired }` on 16, a single timestamp on 15. Writing the 16 format on 15 would make `revalidateTag()` invisible to Next's own tag checks. On Next.js 15 every revalidation is immediate; it has no stale-but-served state.
- During `next build`, `use cache` entries use Next's in-memory default handler through `cache-handlers/default.external.js`, which exists on 15 and 16, instead of `createDefaultCacheHandler`, which is 16-only.
- Cache keys that differ only in characters outside `[a-zA-Z0-9-]` (`/docs/a/b` and `/docs/a_b` under one catch-all route) no longer share a GCS object or file, which let one page be served another's entry. Their names now end in `_` and a hash of the full key. Keys longer than 200 characters are also cut to fit, so the file handlers cache a long slug or `use cache` key instead of failing every write with `ENAMETOOLONG`. Fetch and image entries keep their names; route and `use cache` entries are stored under new names, so they miss once and are rendered again.
- A failed read of `build-meta.json` or `use-cache/_build-meta.json` is no longer taken as a first run, which recorded the new build without wiping `route-cache/` or purging the CDN. The build check is retried on the next request instead, and metadata that isn't valid JSON counts as a different build.
- On Next.js 15, a soft revalidation made by a Next.js 16 instance sharing the bucket is applied. It keeps the tag's earlier `expired`, which a 15 instance used instead of the new `stale`.
- On Next.js 15, a cached `fetch` or `unstable_cache` entry is no longer served after `revalidateTag()` or `revalidatePath()` revalidated one of its tags, or one of the requesting route's implicit tags. Next.js 15 leaves that check to its own FileSystemCache, which a custom handler replaces, so these entries kept being served until their `revalidate` time ran out and they regenerated in the background. Next.js 16 already checked them.
- `FileCacheHandler.get()` and `set()` wait for the build check, as the GCS handler's do. A request on a cold start could read a route entry left from the previous build before it was wiped.
- On Next.js 15, a tag revalidation older than the one already recorded (one that reached this instance late) no longer replaces it, which made entries the newer revalidation expired look fresh again.
- On Next.js 15, a revalidation time ahead of the instance's clock (written by an instance whose clock runs ahead) is recorded as now. Next.js 15 treats every entry older than the tag's timestamp as expired, even if that timestamp is still ahead, so entries regenerated before the clock caught up expired at once and were rendered again on every read.
- An instance now purges the CDN for pages it served from cache after another instance revalidated them, once it reads that revalidation from `revalidations.json`. Until then it could put the old page back in the CDN. Only paths this process served after the revalidation are purged, so an instance that served none sends no purge, and `revalidatePath('/', 'layout')` does not purge the whole site again from each instance. The purge starts in the request whose cache read found the revalidation, but that read does not wait for it. Revalidations already stored when an instance first reads the object are not purged.
- The GCS `use cache` handler keeps entries a process has read or written in memory (new optional `memoryMb` option on `createUseCacheHandler` or `CACHE_USE_CACHE_MEMORY_MB`, default `32`, `0` disables), with the same tag and revalidate checks as a GCS read. With `cacheComponents` and `experimental.cachedNavigations`, Next ends a render's static stage without waiting for cache reads, so a hit that needed a GCS round trip arrived too late for the client to reuse the segment, and the navigation waited for the server. A memory hit arrives in time. A key's first read on a new process still goes to GCS.
- The GCS `use cache` handler's `refreshTags()` no longer waits for GCS. Next awaits it before a request's first `'use cache'` read, so the round trip pushed even memory hits past the static stage. Tag timestamps now reload in the background, at most once per `CACHE_TAGS_REFRESH_INTERVAL_MS`, so another instance's revalidation reaches this instance's `'use cache'` reads within about one interval. This instance's own `updateTag()`/`revalidateTag()` applies at once, as do revalidations the route cache handler has read from `revalidations.json`, so a regenerated page never stores an older `'use cache'` value as fresh. Cached navigations need both this change and the in-memory entries.
- `clearEdgeCachePaths()` purges the trailing-slash URL on sites with `trailingSlash: true` (`/about/`, not `/about`). It used to drop the slash, so it missed the URL the CDN caches. Without `trailingSlash` it still drops it.
- Regenerating a Pages Router page under `/index` (such as `pages/index/foo.js`) purges the data route Next serves, `/_next/data/<buildId>/index/index/foo.json`, not `/_next/data/<buildId>/index/foo.json`.
- Regenerating a Pages Router page in a default locale also purges its URL without the locale prefix (`/blog` as well as `/en/blog`), which is where Next serves it. Default locales come from `i18n.defaultLocale` and each `i18n.domains` entry.
- A page whose dynamic segment contains `/`, `?`, `#` or `\` (`/what%3F`) is purged at its decoded URL (`/what?`), which is what the CDN keys it by. The purge used the cache key as Next escapes it, so it never matched.
- `clearEdgeCachePaths()` drops a query string or fragment from the paths you pass (`/search?q=x` purges `/search`). The CDN keys a page by its path alone, so a purge that kept the query matched nothing.

## 0.13.2

### Fixed

- A slow read of revalidations from other instances no longer delays every cache read by up to 2 s. Each read used to start its own 2 s wait, so when GCS was slow to answer, every cache read made during that time took up to 2 s longer. Reads now share one deadline, 2 s after the in-flight read started, so a read arriving during a stall waits only for the time left, and one arriving after it goes ahead at once.
- The "Revalidations from other instances took over 2000ms to read" warning is logged once per streak of slow reads instead of once per waiting cache read, which could produce dozens of lines for a single stall. The recovery message reports how many slow reads there were and how many cache reads were served without them. Both are now logged as `[SharedRevalidations]` instead of `[GcsCacheHandler]`.
- `use cache` entries set during `next build` are served again within the same build process. 0.13.1 made the `use cache` handlers miss every read during the build, but Next's prerender reads back what it just cached, so cached data counted as uncached: static output rendered runtime values (`use-cache-metadata-route-handler` sitemaps showed `runtime` instead of `buildtime`, and so did `fallback-shells` layouts), and builds with Cache Components could fail with "encountered uncached or runtime data during prerendering" (`resume-data-cache`). During the build the handlers now use Next's own in-memory default handler, per process. Build-time values still never reach GCS, the shared file store, or a runtime read, and the build still never reads or deletes the live revision's entries.
- A server action that calls `revalidateTag()` or `revalidatePath()` responds after the first CDN purge again, not after the second. 0.13.1 waited for the second purge (two refresh intervals, 2 s by default) before responding, so the action's response took 2 s or more and clients saw the page update late (the Next.js `app-action`, `parallel-routes-revalidation` and `actions-revalidate-remount` deploy tests timed out). The second purge still waits until every instance has applied the revalidation, now on a timer: second purges due within 1 s of each other go out as one, each path and key once, and `flushSharedTagsMapping()` sends any still owed at shutdown.
- `clearEdgeCachePaths()` and the handlers' path purges send each path once per call. Repeats, and `a` alongside `/a` (the same request), used to send one request each. `/a/` is still its own path, since with `trailingSlash` it is the URL the CDN caches.

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
