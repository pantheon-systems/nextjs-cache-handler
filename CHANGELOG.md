# Changelog

## 0.12.1

### Fixed

- A redeploy that changes the Next.js deployment ID (`deploymentId` in `next.config`, or `NEXT_DEPLOYMENT_ID`) now invalidates the route/ISR cache and the `use cache` entries, and purges the CDN. Next writes a constant `BUILD_ID` whenever a deployment ID is set, so the build-ID comparison never saw a new build. Build-scoped invalidation is now keyed on the build ID plus the deployment ID (`<BUILD_ID>:<deploymentId>`), read from `NEXT_DEPLOYMENT_ID` or `.next/routes-manifest.json`. Matches Vercel, whose ISR cache is scoped per deployment.

  **Upgrade behaviour:** sites with no deployment ID are unaffected (the key is exactly the old `BUILD_ID`, so no invalidation on upgrade). Sites with a deployment ID invalidate once on the first startup after upgrading.

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
