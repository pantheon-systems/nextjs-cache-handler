# revalidatePath CDN Clearing via Path→Surrogate-Key Mapping

## Problem

When `revalidatePath('/api/cdnprobe')` is called, Next.js internally converts it to `revalidateTag('_N_T_/api/cdnprobe')`. The cache handler's `updateTags()` method receives `['_N_T_/api/cdnprobe']` and must clear the CDN.

However, the CDN uses **explicit `cacheTag()` values** as surrogate keys (e.g., `cdnprobe`), not Next.js internal path tags. Sending `_N_T_/api/cdnprobe` to the CDN purge API doesn't match any surrogate key, so the CDN is never cleared.

```
revalidatePath('/api/cdnprobe')
  → Next.js: revalidateTag('_N_T_/api/cdnprobe')
  → updateTags(['_N_T_/api/cdnprobe'])
  → clearKeys(['_N_T_/api/cdnprobe'])  ← no surrogate key match
  → CDN NOT cleared ✗
```

## Solution: Path→Surrogate-Key Registry

A runtime mapping from request paths to their surrogate keys, populated automatically by `withSurrogateKey()` on every cache HIT.

### How it works

1. **Registration** — When `withSurrogateKey()` handles a request and captures tags from a cache HIT, it registers the mapping:

   ```
   GET /api/cdnprobe → cache HIT → tags captured: ['cdnprobe']
   → registerPathTags('/api/cdnprobe', ['cdnprobe'])
   ```

2. **Resolution** — When `updateTags()` receives `_N_T_` prefixed tags, it resolves them:

   ```
   revalidatePath('/api/cdnprobe')
     → updateTags(['_N_T_/api/cdnprobe'])
     → extract path: '/api/cdnprobe'
     → lookup mapping: ['cdnprobe']
     → clearKeys(['cdnprobe'])  ← matches surrogate key
     → CDN cleared ✓
   ```

3. **Fallback** — If no mapping exists (path was never served with `withSurrogateKey`), falls back to path-based CDN purge.

### Architecture

```
                    ┌─────────────────────────────────────────┐
                    │           withSurrogateKey()             │
                    │                                         │
                    │  1. Runs handler within CacheTagContext  │
                    │  2. Captures tags from cache HITs        │
                    │  3. Sets Surrogate-Key response header   │
                    │  4. Calls registerPathTags() via Symbol  │
                    └────────────────┬────────────────────────┘
                                     │
                          globalThis[Symbol.for(
                    '@nextjs-cache-handler/path-tags-registry')]
                                     │
                    ┌────────────────▼────────────────────────┐
                    │       UseCacheGcsHandler                 │
                    │                                         │
                    │  pathToSurrogateKeys: Map<string, str[]> │
                    │                                         │
                    │  registerPathTags(path, tags)            │
                    │    → stores path → surrogate keys       │
                    │                                         │
                    │  updateTags(tags, durations)             │
                    │    → separates _N_T_ from explicit tags │
                    │    → resolves _N_T_ via mapping         │
                    │    → purges CDN by surrogate key        │
                    └─────────────────────────────────────────┘
```

### Cross-module communication

The handler instance and `withSurrogateKey` are in separate modules with no direct import path. Communication uses `Symbol.for('@nextjs-cache-handler/path-tags-registry')` on `globalThis` — the same pattern already used for `CacheTagContext`.

The handler registers a callback on `globalThis` during construction:

```typescript
(globalThis as Record<symbol, unknown>)[PATH_TAGS_REGISTRY_SYMBOL] =
  (path: string, tags: string[]) => this.registerPathTags(path, tags);
```

`withSurrogateKey` looks it up after capturing tags:

```typescript
const registerFn = (globalThis as Record<symbol, unknown>)[PATH_TAGS_REGISTRY_SYMBOL];
if (registerFn) {
  registerFn(requestPath, capturedTags);
}
```

## Files changed

| File | Change |
|------|--------|
| `src/use-cache/gcs-handler.ts` | Added `pathToSurrogateKeys` map, `registerPathTags()`, `_N_T_` resolution in `updateTags()`, Symbol registration in constructor |
| `src/use-cache/file-handler.ts` | Same changes for parity with GCS handler |
| `src/utils/with-surrogate-key.ts` | Calls `registerPathTags()` via Symbol after capturing tags |
| `src/handlers/gcs.ts` | Reverted incorrect `_N_T_` handling in `onRevalidateComplete()` (that code path is for the base ISR handler, not `'use cache'` entries) |
| `tests/use-cache/gcs-handler.test.ts` | 7 new tests covering `_N_T_` resolution, fallback, mixed tags, and edge cases |

## Limitations

- **Mapping is in-memory and per-instance.** If the handler restarts, the mapping is lost until paths are served again. This is acceptable because:
  - The mapping rebuilds naturally as requests flow through `withSurrogateKey`
  - Paths that haven't been served recently don't need CDN invalidation
  - The fallback to path-based purge handles the cold-start case

- **Requires `withSurrogateKey` wrapper.** Routes that don't use the wrapper won't register mappings. This is by design — only routes that set surrogate keys need CDN invalidation by key.

- **Next.js `_N_T_` prefix is an implementation detail.** If Next.js changes this prefix, the constant `NEXTJS_PATH_TAG_PREFIX` needs updating. The prefix has been stable across Next.js versions.

## Testing

Unit tests validate:
- `_N_T_` path tags resolve to surrogate keys when mapping is registered
- Tag timestamps are still recorded for `_N_T_` tags (server-side expiration)
- Mixed explicit and `_N_T_` tags purge correctly
- Unmapped paths fall back to path-based purge
- Multiple path tags with different mappings resolve independently
- No fetch calls when edge cache clearer isn't configured

E2E tests (Suite 12 — `edge-cache-path-purge.spec.ts`) validate the full flow:
- `revalidatePath('/api/cdnprobe')` causes CDN to serve new content
- `revalidateTag('cdnprobe')` causes CDN to serve new content
- Unrelated tag revalidation does NOT evict cached content
- Server cache regenerates valid content after revalidation
