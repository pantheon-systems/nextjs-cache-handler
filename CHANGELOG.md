# Changelog

## 0.13.0

### Fixed

- GCS tag-mapping writes (`cache/tags/tags.json`) no longer exceed GCS's one-write-per-second-per-object limit under load. Next.js constructs a cache handler per request, so the write buffer was per request rather than per process, and concurrent buffers overwrote each other's tag entries. The GCS handler now shares one buffer per process, writes with an `ifGenerationMatch` precondition (re-reading and re-applying on conflict), skips writes that would not change the mapping, no longer writes on `revalidateTag()` (pending updates are overlaid on the read instead), and retries failed writes with capped exponential backoff instead of every two seconds forever. Failures log one warning per streak instead of one error per attempt.
- A failed read of the tag mapping no longer wipes it. Any transport or parse error used to be treated as an empty map, and the pending updates were written over the real one. Transport errors now fail the flush and the updates stay queued. An unparseable map is replaced under a generation precondition, with a warning.
- Storage clients are shared per process and split by purpose: one for unconditional cache-entry and build-meta writes, one for the conditional tag-map and tag-timestamp writes. The client library disables retries on its shared state for unconditional uploads, so sharing one client could strip retries from the conditional writes. The tags client does not retry 429s itself. The handler's paced backoff handles rate limits.
- The build-invalidation check on a cold start now runs once per process even when several handlers are constructed concurrently (the check is memoized as a promise instead of a flag set after an await).
- `UseCacheGcsHandler.updateTags()` serializes concurrent writes of `use-cache/_tags.json`, merges with the stored timestamps under a generation precondition instead of overwriting them, and backs off after a failure.

### Changed

- New optional `CACHE_TAGS_FLUSH_INTERVAL_MS` (default `5000`, minimum `1000`) controls how often each process writes the tag mapping. The previous fixed interval was `1000`.
- The tag mapping and tag timestamps are no longer pretty-printed, and the tag mapping is no longer created on handler start (the first flush creates it with `ifGenerationMatch: 0`). This also removes the `exists()` call every request made on the mapping before its first cache operation.
- All small JSON writes (cache entries, build meta, tag mapping, tag timestamps) use `resumable: false`, one HTTP round trip instead of two.
- New `flushSharedTagsMapping()` export writes pending tag-mapping updates immediately and returns how many buffers it flushed, for apps that handle `SIGTERM` themselves via `NEXT_MANUAL_SIG_HANDLE`. Call it from process-level code (a custom server), not from code Next.js bundles.
- `GcsCacheHandler.writeTagsMapping()` (protected, unused since updates go through the buffer) now throws instead of performing an unsafe whole-map write.
- `TagsBuffer`'s `readTagsMapping`/`writeTagsMapping` callbacks now carry the object generation (`{ mapping, generation }` / `(mapping, generation)`). Only relevant if you construct `TagsBuffer` directly.

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
