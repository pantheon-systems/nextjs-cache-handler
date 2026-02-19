# Pages Router Support: Cache Clearing & Edge Cache Invalidation

## Problem

The cache handler does not currently work with Next.js Pages Router (`getStaticProps` / ISR). While the handler's get/set/clear infrastructure is largely router-agnostic, it has never been tested or validated for Pages Router cache entries, and several gaps exist in how cache clearing and edge cache invalidation integrate with the Pages Router lifecycle.

## Prior Art & Known Issues

Custom cache handlers with Pages Router are a known pain point in the Next.js ecosystem:

- **[vercel/next.js#58094](https://github.com/vercel/next.js/issues/58094)** — "Next.js with custom cache handler fails to serve pre-rendered pages." When using a custom cache handler with Pages Router, pre-rendered SSG pages return 404 because the cache is empty on first request and the handler has no fallback to read the build-time HTML/JSON from disk. The official Next.js cache handler examples don't cover this case.

- **[@neshca/cache-handler](https://github.com/caching-tools/next-shared-cache)** (now `@caching-tools/next-shared-cache`) — The most mature third-party cache handler. It explicitly supports Pages Router by implementing a filesystem fallback: when `get()` misses the cache for a `fallback: false` route, it reads the pre-rendered HTML and JSON from `.next/server/pages/`. This is the only well-known solution in the ecosystem. The official Next.js Redis cache handler example also delegates to this library.

- **Next.js self-hosting docs** — The [self-hosting guide](https://nextjs.org/docs/app/guides/self-hosting#caching-and-isr) confirms the shared cache works with "both the Pages and App Router" and that `cacheHandler` (singular) is the config option. The docs also note: "`revalidatePath` is a convenience layer on top of cache tags. Calling `revalidatePath` will call the `revalidateTag` function with a special default tag for the provided page."

### Key lesson from the ecosystem

The critical gap that `@neshca/cache-handler` solves — and that our handler currently lacks — is **filesystem fallback for pre-rendered pages**. During build, Next.js writes pre-rendered HTML and JSON to `.next/server/pages/`. On first request, the custom cache handler's `get()` is called but the cache is empty (nothing has been `set()` yet). Without a fallback to read from disk, the page 404s.

This is the **primary blocker** for Pages Router support, not cache clearing or edge invalidation.

## Background: How Next.js Calls the Cache Handler for Pages Router

Based on the Next.js source code (`next/dist/server/`), the call chain for Pages Router ISR is:

```
pages-handler.js → routeModule.handleResponse()
  → responseCache.get(cacheKey, responseGenerator, context)
  → incrementalCache.get(cacheKey, ctx)
  → cacheHandler.get(cacheKey, { kind: 'PAGES', isRoutePPREnabled, isFallback })
```

### Key differences from App Router

| Aspect | Pages Router (`kind: PAGES`) | App Router (`kind: APP_PAGE`) |
|--------|------------------------------|-------------------------------|
| **Value structure** | `{ html, pageData, headers, status }` | `{ html, rscData, headers, status, postponed }` |
| **Data types** | `pageData` is plain JSON | `rscData` is a `Buffer` |
| **AsyncLocalStorage** | Not used during render | Uses `workAsyncStorage`, `workUnitAsyncStorage` |
| **Revalidation model** | Time-based ISR (`revalidate: N`), on-demand via `res.revalidate()` | Tags via `cacheTag()` / `revalidateTag()` / `revalidatePath()` |
| **`set()` ctx** | `{ fetchCache: false, cacheControl, isFallback }` | `{ fetchCache: false, cacheControl, isRoutePPREnabled }` |
| **`get()` ctx** | `{ kind: 'PAGES', isFallback }` | `{ kind: 'APP_PAGE', isRoutePPREnabled }` |
| **Fetch cache** | Not used (Pages Router doesn't cache `fetch()` calls) | Uses `kind: 'FETCH'` entries |

### How `revalidatePath()` works under the hood

`revalidatePath('/blog/my-post')` does **not** trigger a re-render directly. It converts the path to an implicit tag and calls `revalidateTag()`:

```
revalidatePath('/blog/my-post')
  → tag = '_N_T_/blog/my-post'
  → queued in store.pendingRevalidatedTags
  → after request: executeRevalidates()
  → cacheHandler.revalidateTag('_N_T_/blog/my-post')
```

This means the cache handler's `revalidateTag()` method receives `_N_T_`-prefixed tags for path-based revalidation on both routers.

## Current State: What Works and What Doesn't

### Already works (untested)

1. **`set()` stores Pages Router entries** — `determineCacheTypeFromValue()` classifies `kind: 'PAGES'` as `'route'` (correct). The `pageData` field is plain JSON, so serialization should round-trip without issues.

2. **`get()` retrieves Pages Router entries** — `determineCacheType()` classifies the `ctx` (no `fetchCache`/`fetchUrl`/`fetchIdx`) as `'route'` (correct).

3. **`onRouteCacheSet()` triggers edge cache path clearing** — When Next.js calls `set()` after ISR background revalidation, the GCS handler extracts the route path and calls `clearPathInBackground()`. This is router-agnostic.

4. **`clearSharedCache()` clears Pages Router entries** — Clears all entries in `route-cache/` regardless of `kind`. Static route preservation via `prerender-manifest.json` works for both routers.

5. **Static route detection** — `getStaticRoutes()` reads `prerender-manifest.json`, which contains routes from both routers.

### Gaps

1. **No filesystem fallback for pre-rendered pages** — This is the **primary blocker** (see [vercel/next.js#58094](https://github.com/vercel/next.js/issues/58094)). During `next build`, Pages Router pre-renders HTML and JSON to `.next/server/pages/`. On first request, Next.js calls `cacheHandler.get()`, but the custom cache is empty — nothing has been `set()` yet. Without a fallback to read from `.next/server/pages/{path}.html` and `.next/server/pages/{path}.json`, the page returns 404. The `@neshca/cache-handler` library solves this by reading from disk on cache miss for `fallback: false` routes.

2. **`revalidateTag()` with `_N_T_`-prefixed path tags** — When `revalidatePath()` is used from a Pages Router API route or `getServerSideProps`, the handler receives `_N_T_/path` tags. The tags mapping must contain these implicit tags for the lookup to succeed. Whether Next.js passes them in `ctx.tags` during `set()` for Pages Router ISR needs verification.

3. **Edge cache clearing from `_N_T_` tags** — `onRevalidateComplete()` passes raw tag names to `clearKeysInBackground()`. The CDN doesn't know about `_N_T_` prefixed surrogate keys. The path needs to be extracted from the tag and cleared via `clearPathsInBackground()` instead.

4. **Surrogate-Key header propagation** — Pages Router rendering does not use `workAsyncStorage` (confirmed in source). The `RequestContext` AsyncLocalStorage from the middleware does not propagate through Pages Router renders. Without `Surrogate-Key` headers on responses, tag-based CDN purging won't work. Path-based clearing via `onRouteCacheSet()` is the practical mechanism for Pages Router.

5. **No test coverage** — No tests exist for `kind: 'PAGES'` cache entries.

## Implementation Plan

### Phase 0: Filesystem fallback for pre-rendered pages

**Goal:** Serve pre-rendered Pages Router pages on first request when the cache is cold.

This is the primary blocker for Pages Router support. Without this, Pages Router SSG/ISR pages 404 on first request.

**How it works:**

When `get()` is called for a `kind: 'PAGES'` cache entry and the custom cache has no entry, fall back to reading the pre-rendered files from `.next/server/pages/`:

```
cacheHandler.get('/blog/my-post', { kind: 'PAGES', ... })
  → cache miss
  → read .next/server/pages/blog/my-post.html
  → read .next/server/pages/blog/my-post.json  (pageData from getStaticProps)
  → return { value: { kind: 'PAGES', html, pageData, ... }, lastModified, tags: [] }
  → optionally: call set() to populate the cache for future requests
```

**Scope decisions:**

- **Which routes need fallback?** Routes with `fallback: false` in `getStaticPaths` are pre-rendered at build time and won't have a `set()` before the first `get()`. Routes with `fallback: 'blocking'` or `fallback: true` generate on-demand, so Next.js calls `set()` after rendering. The `@neshca/cache-handler` only does filesystem fallback for `fallback: false` routes, using the prerender manifest.
- **Where to implement?** In `base.ts` `get()`, after the cache miss, check if `ctx.kind === 'PAGES'` and attempt filesystem read. Alternatively, implement in each subclass (`file.ts`, `gcs.ts`). The filesystem read is always local (`.next/server/pages/` is on disk, not in GCS), so it could live in the base class.
- **Promote to cache?** After a successful filesystem read, optionally call `set()` to populate the custom cache so subsequent requests are served from cache, not disk.

**Tasks:**

- [ ] Parse `prerender-manifest.json` to identify `fallback: false` Pages Router routes (extend `getStaticRoutes()` or create a new utility)
- [ ] Implement filesystem read for `.next/server/pages/{path}.html` and `.next/server/pages/{path}.json`
- [ ] In `base.ts` `get()`: after cache miss, if `ctx.kind === 'PAGES'` and route is a known pre-rendered route, read from disk
- [ ] Return the value in the format Next.js expects: `{ value: { kind: 'PAGES', html, pageData, headers, status }, lastModified, tags: [] }`
- [ ] Optionally promote filesystem reads to cache via `set()`
- [ ] Add tests for cold-cache `get()` with pre-rendered pages present on disk

**Files:**
- `src/handlers/base.ts`
- `src/utils/static-routes.ts` (or new utility)
- `tests/handlers/file.test.ts`
- `tests/handlers/gcs.test.ts`

**Reference:** `@neshca/cache-handler` implements this via `#readPagesRouterPage()` which reads from `.next/server/pages/`, returning `{ kind: 'PAGE', html, pageData }`.

### Phase 1: Verify and test basic get/set round-trip

**Goal:** Confirm that Pages Router ISR entries survive storage and retrieval.

**Tasks:**

- [ ] Add test fixtures with `kind: 'PAGES'` cache values (`{ html, pageData, headers, status }`) in both file and GCS handler tests
- [ ] Test `set()` → `get()` round-trip with realistic `pageData` shapes (nested objects, arrays, strings, numbers, nulls)
- [ ] Test that `determineCacheTypeFromValue()` returns `'route'` for `kind: 'PAGES'`
- [ ] Test that `determineCacheType()` returns `'route'` for Pages Router `get()` context (`{ kind: 'PAGES', isFallback: false }`)
- [ ] Test serialization/deserialization of `pageData` (plain JSON — no Buffers or Maps expected, but verify)

**Files:**
- `tests/handlers/file.test.ts`
- `tests/handlers/gcs.test.ts`

### Phase 2: Handle `_N_T_` path tags in `revalidateTag()`

**Goal:** Ensure `revalidatePath()` correctly invalidates Pages Router cache entries and clears the edge cache.

**Tasks:**

- [ ] Determine whether Next.js includes `_N_T_` implicit tags in `ctx.tags` when calling `set()` for Pages Router ISR pages. If not, the handler must synthesize them from the cache key during `set()`.
- [ ] If synthesis is needed: in `base.ts` `set()`, when `cacheType === 'route'`, add `_N_T_${cacheKey}` to the tags before storing in the tags mapping. This ensures `revalidatePath()` can find the entry.
- [ ] In `gcs.ts` `onRevalidateComplete()`: extract paths from `_N_T_`-prefixed tags and add them to the `clearPathsInBackground()` call. Currently only `extractRoutePaths()` extracts paths from deleted cache keys; the tag names themselves also encode paths.

  ```
  // Current: only clears by raw tag name (won't match CDN surrogate keys)
  clearKeysInBackground(tags, ...)

  // Needed: also extract and clear paths from _N_T_ tags
  const pathsFromTags = tags
    .filter(t => t.startsWith('_N_T_'))
    .map(t => t.replace('_N_T_', ''));
  clearPathsInBackground([...routePaths, ...pathsFromTags], ...)
  ```

- [ ] Add tests for `revalidateTag('_N_T_/blog/my-post')` → deletes the correct cache entry → triggers edge cache path clearing

**Files:**
- `src/handlers/base.ts`
- `src/handlers/gcs.ts`
- `tests/handlers/gcs.test.ts`

**Note:** The `revalidatepath-cdn-clearing.md` design doc covers `_N_T_` handling for the `use-cache` handlers. This work extends the same pattern to the base ISR cache handler.

### Phase 3: Surrogate-Key header propagation (assessment)

**Goal:** Determine the best approach for Surrogate-Key headers on Pages Router responses.

Pages Router rendering does not use the AsyncLocalStorage contexts that App Router uses. The current `RequestContext`-based tag capture in `captureTagsForResponse()` fires during `get()`, but the middleware may not be able to read those tags because the render pipeline doesn't share the same async context.

**Options to evaluate:**

1. **Path-based edge clearing only (no Surrogate-Key headers)** — Accept that Pages Router ISR pages don't get Surrogate-Key headers. Edge cache clearing works via `onRouteCacheSet()` (path-based) which is already implemented. This is the simplest approach and may be sufficient.

2. **Set Surrogate-Key in `getServerSideProps` / API routes** — Provide a utility function that Pages Router users call manually:
   ```typescript
   // In getServerSideProps
   export async function getServerSideProps(ctx) {
     ctx.res.setHeader('Surrogate-Key', 'my-tag');
     // ...
   }
   ```
   This is manual but straightforward.

3. **Custom `_document.tsx` or response header injection** — Inject Surrogate-Key based on the request path. This would require a Next.js custom server or `_document` integration.

**Recommendation:** Start with option 1 (path-based clearing only). Pages Router ISR already has a working edge cache invalidation path via `onRouteCacheSet()`. Surrogate-Key headers are a nice-to-have for tag-based CDN purging but not required for basic cache clearing to work.

**Tasks:**

- [ ] Document that Pages Router relies on path-based edge cache clearing, not tag-based CDN purging
- [ ] If option 2 is desired: add a `setSurrogateKey(res, tags)` utility export for use in `getServerSideProps`

**Files:**
- `src/utils/index.ts` (new export, if option 2)

### Phase 4: Integration testing

**Goal:** End-to-end validation with a real Pages Router app.

**Tasks:**

- [ ] Create or extend the example app with a Pages Router page using `getStaticProps` + ISR (`revalidate: 10`)
- [ ] Verify: page is served from cache on second request
- [ ] Verify: after `revalidate` period, background regeneration calls `set()` and triggers `onRouteCacheSet()` edge cache clear
- [ ] Verify: `revalidatePath('/pages-router-page')` from an API route clears the cache entry
- [ ] Verify: `clearSharedCache()` clears Pages Router entries but preserves static SSG pages
- [ ] Test with both `FileCacheHandler` and `GcsCacheHandler`

**Files:**
- `example/` directory
- New or extended E2E test suite

## Out of Scope

- **`getServerSideProps` caching** — `getServerSideProps` is not cached by Next.js's incremental cache. It runs on every request. Cache-Control headers can be set manually but that's outside the cache handler's responsibility.
- **`kind: 'IMAGE'` entries** — Image optimization cache is handled separately by Next.js and not relevant to this work.
- **Next.js 16 `cacheHandlers` (plural)** — The `cacheHandlers` config only applies to `'use cache'` directives (App Router). Pages Router uses the `cacheHandler` (singular) config. This is a documentation concern, not a code change.

## Configuration Note

Pages Router users must use the `cacheHandler` (singular) config option:

```javascript
// next.config.js
module.exports = {
  cacheHandler: require.resolve('./cache-handler.js'),
  // NOT cacheHandlers (plural) — that's for 'use cache' only
}
```
