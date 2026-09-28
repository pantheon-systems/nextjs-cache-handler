# Changelog

## 0.12.0

### Fixed

- `get` now returns `null` for a page, route handler or Pages Router entry that carries an expired tag, as Next.js's built-in `FileSystemCache.get` does. Entries whose tags are only stale are still returned, so `revalidateTag(tag, 'max')` keeps serving the last-good value while it regenerates. Before this, an immediate invalidation (`revalidateTag(tag, { expire: 0 })`, `updateTag` or `revalidatePath`) served stale content once on Next.js 16.2, and on 16.3 re-ran every cached scope on each affected route instead of only the tagged ones.

## 0.9.0

### Changed

- `revalidateTag` no longer deletes the underlying cache entries it revalidates. This matches Next.js's own built-in `FileSystemCache.revalidateTag`, which never deletes entries either — staleness is tracked via the shared `tagsManifest` instead, so the last-good value stays servable while Next revalidates in the background (and so `cacheComponents`/PPR routes can resume from the cached postponed state).

  **If you relied on the previous behavior** (cache entries being physically deleted on `revalidateTag`), this is a behavior change: entries now remain readable until overwritten by a subsequent `set`.

- `revalidateTag` now accepts an optional second `durations` argument (`{ expire?: number }`), matching Next's `CacheHandler.revalidateTag` signature. Passing `{ expire: N }` sets a future expiry (soft/background revalidation) instead of the immediate hard expiry used when no durations are provided.

### Fixed

- Fixed a race condition in the build-prerender fallback lazy-init (`getBuildPrerender`) where concurrent first-miss callers could read a not-yet-assigned instance field as a false miss. Now memoized as an in-flight promise.
