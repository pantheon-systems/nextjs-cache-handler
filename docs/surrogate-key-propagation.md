# Surrogate-Key Propagation with Next.js 16 Cache Components

## Overview

This document explains the design choices for propagating cache tags to `Surrogate-Key` response headers when using Next.js 16's `'use cache'` directive with Pantheon's cache handler.

## The Problem

Pantheon's CDN uses `Surrogate-Key` headers for targeted cache invalidation. When cached data is served, we need to include the associated cache tags in the response header so the CDN knows which cache entries to purge when `revalidateTag()` is called.

## Key Discovery: Build-Time vs Runtime Caching

Next.js 16 introduced three cache directives:

| Directive | When Cached | Handler Called at Runtime |
|-----------|-------------|---------------------------|
| `'use cache'` | Build time | No - prerendered into static shell |
| `'use cache: remote'` | Runtime | Yes - `get()`/`set()` called per request |
| `'use cache: private'` | Runtime (per-user) | No custom handler support |

**Critical insight**: With `'use cache'` (default), the cache handler is only called during `next build`. At runtime, Next.js serves the prerendered static shell without invoking the custom handler.

For CDN cache invalidation, we need **runtime** tag capture, which requires `'use cache: remote'`.

## What We Tried

### Attempt 1: AsyncLocalStorage (RequestContext)

**Approach**: Use Node.js `AsyncLocalStorage` to create a request-scoped context that tracks cache tags.

```typescript
// withSurrogateKey wrapper
return RequestContext.run(async () => {
  const response = await handler(request);
  const tags = RequestContext.getTags(); // Read captured tags
  // Set Surrogate-Key header...
});

// Cache handler get()
if (result.tags) {
  RequestContext.addTags(result.tags); // Add tags to context
}
```

**Result**: `RequestContext.isActive()` returns `false` in the cache handler.

**Why it failed**: Next.js's internal cache mechanism runs in a different async context chain than the one created by `withSurrogateKey()`. AsyncLocalStorage doesn't propagate across this boundary.

### Attempt 2: Global Store Fallback

**Approach**: Use `globalThis` as a fallback for cross-context tag propagation.

```javascript
// Cache handler
globalThis.__pantheonSurrogateKeyTags.push(...result.tags);

// withSurrogateKey wrapper
const globalTags = globalThis.__pantheonSurrogateKeyTags;
if (capturedTags.length === 0 && globalTags.length > 0) {
  capturedTags = [...new Set(globalTags)];
  globalTags.length = 0; // Clear after reading
}
```

**Result**: Works correctly for single-request scenarios but has theoretical concurrency issues.

### Attempt 3: CacheTagContext with Symbol.for Pattern (Current Solution)

**Approach**: Use `Symbol.for()` to register an AsyncLocalStorage-based context on `globalThis`, similar to Next.js's internal `@next/request-context` pattern used by `after()`.

```typescript
// src/utils/cache-tag-context.ts
const CACHE_TAG_CONTEXT_SYMBOL = Symbol.for('@nextjs-cache-handler/tag-context');

const cacheTagContextStorage = new AsyncLocalStorage<CacheTagContextData>();

const cacheTagContextAccessor = {
  get() {
    return cacheTagContextStorage.getStore();
  },
};

// Register on globalThis for cross-module access
globalThis[CACHE_TAG_CONTEXT_SYMBOL] = cacheTagContextAccessor;
```

```typescript
// Cache handler accesses via Symbol.for (no direct import needed)
const accessor = globalThis[Symbol.for('@nextjs-cache-handler/tag-context')];
const context = accessor?.get();
if (context) {
  context.tags.push(...entry.tags);
}
```

**Result**: Successfully propagates tags through Next.js cache handler async boundaries with request-scoped isolation.

**Why it works**: The `Symbol.for()` pattern ensures the same symbol is used across module boundaries, and registering the AsyncLocalStorage accessor on `globalThis` allows the cache handler to access the request context without direct module imports.

## Final Design

### Architecture

```
Request
  ↓
withSurrogateKey() ─── CacheTagContext.run() creates request-scoped context
  ↓                    (also clears globalThis fallback)
handler()
  ↓
'use cache: remote' function
  ↓
Next.js calls cache handler get()
  ↓
Cache HIT with tags → captureTags():
  │  1. Try CacheTagContext via Symbol.for (primary)
  │  2. Fall back to globalThis store (backup)
  ↓
withSurrogateKey() ─── CacheTagContext.getTags(), sets Surrogate-Key header
  ↓
Response with Surrogate-Key: tag1 tag2 tag3
```

### Components

1. **CacheTagContext** (`src/utils/cache-tag-context.ts`)
   - Uses `Symbol.for('@nextjs-cache-handler/tag-context')` for cross-module access
   - Wraps `AsyncLocalStorage` for request-scoped tag tracking
   - Registered on `globalThis` so cache handlers can access without direct imports

2. **Cache Handlers** (`src/use-cache/file-handler.ts`, `gcs-handler.ts`)
   - Access `CacheTagContext` via `Symbol.for` pattern in `captureTags()`
   - Fall back to `globalThis.__pantheonSurrogateKeyTags` if context not active
   - Tags captured on cache HIT in `get()` method

3. **withSurrogateKey()** (`src/utils/with-surrogate-key.ts`)
   - Wraps handler in `CacheTagContext.run()` to establish request scope
   - Clears global tag store before each request (fallback cleanup)
   - Reads from `CacheTagContext.getTags()` first
   - Falls back to global store if no tags captured
   - Sets `Surrogate-Key` response header

### Configuration

```javascript
// next.config.mjs
cacheHandlers: {
  default: path.resolve(__dirname, './use-cache-handler.mjs'),
  remote: path.resolve(__dirname, './use-cache-handler.mjs'),
},
```

## Tradeoffs

### Pros

1. **Works with Next.js 16 cache mechanism** - Doesn't require modifying Next.js internals
2. **Graceful fallback** - Uses AsyncLocalStorage when available, falls back to global store
3. **Minimal user configuration** - Users just need the handler file and `withSurrogateKey()` wrapper
4. **Runtime tag capture** - Tags are captured during actual request processing

### Cons

1. **Requires `'use cache: remote'`** - Users must use this directive instead of plain `'use cache'` for CDN-invalidatable routes
2. **Global state** - The fallback mechanism uses global state, which has theoretical concurrency issues
3. **First request returns fallback** - On cache MISS, no tags exist yet, so fallback `Surrogate-Key` is used

### Concurrency Considerations

The global store approach could theoretically cause issues with concurrent requests:

1. Request A starts, clears global tags
2. Request B starts, clears global tags (A's tags would be lost if any)
3. Request A's cache hit adds tags
4. Request B's cache hit adds tags
5. Request A reads tags (gets A+B's tags)
6. Request B reads tags (gets empty, already consumed)

**In practice**, this is mitigated by:
- Each request runs largely synchronously between the clear and read
- Tags are cleared at the start and read at the end of each request
- Node.js single-threaded nature means less interleaving than expected

For high-concurrency production use, consider:
- Using a request ID-keyed Map instead of a simple array
- Implementing proper cleanup with timeouts
- Monitoring for tag cross-contamination in logs

## Usage Example

```typescript
// app/api/posts/route.ts
import { withSurrogateKey } from '@pantheon-systems/nextjs-cache-handler';
import { cacheTag, cacheLife } from 'next/cache';

async function fetchPosts() {
  'use cache: remote';  // <-- Required for runtime tag capture
  cacheTag('posts', 'api-data');
  cacheLife({ stale: 60, revalidate: 300, expire: 3600 });

  return await db.posts.findMany();
}

async function handler(request: NextRequest) {
  const posts = await fetchPosts();
  return NextResponse.json(posts);
}

export const GET = withSurrogateKey(handler);
```

Response headers on cache HIT:
```
Surrogate-Key: posts api-data
```

## Debugging Surrogate-Key Headers on Pantheon

### Why Surrogate-Key Isn't Visible in Normal Responses

By design, Pantheon's infrastructure strips the `Surrogate-Key` response header before responses are served to clients. This is intentional behavior - the CDN consumes this header internally for cache management and invalidation.

### Viewing Surrogate-Key-Raw

To inspect the `Surrogate-Key` value, add the `Pantheon-Debug:1` request header. Pantheon will then include the original value as `Surrogate-Key-Raw`:

```bash
# View all headers with debug info
curl -IH "Pantheon-Debug:1" https://your-site.pantheonsite.io/api/posts

# Filter to just Surrogate-Key-Raw
curl -IH "Pantheon-Debug:1" https://your-site.pantheonsite.io/api/posts | grep -i surrogate-key-raw
```

**Example output on cache HIT:**

```
surrogate-key-raw: api-posts-remote external-data-remote
```

### Validation Results

We confirmed this behavior works correctly with the cache handler:

```bash
# First request (cache MISS) - returns fallback key
$ curl -IH "Pantheon-Debug:1" .../api/posts/with-tags-remote | grep surrogate-key-raw
surrogate-key-raw: page-content

# Second request (cache HIT) - returns actual tags
$ curl -IH "Pantheon-Debug:1" .../api/posts/with-tags-remote | grep surrogate-key-raw
surrogate-key-raw: api-posts-remote external-data-remote
```

### E2E Test Considerations

Automated tests cannot easily use the `Pantheon-Debug:1` header since Playwright's `request.get()` doesn't expose the ability to see `Surrogate-Key-Raw`. For E2E testing, we use temporary debug headers:

- `x-cache-tags-count` - Number of tags captured
- `x-cache-tags-source` - Where tags came from (`CacheTagContext` or `globalStore`)
- `x-surrogate-key-debug` - Mirror of the `Surrogate-Key` value

These debug headers are enabled with `withSurrogateKey(handler, { debug: true })` and should be removed before production release.

## Edge Cache Invalidation

### Current Status: Blocked on Infrastructure

**TL;DR**: Tag-based CDN cache invalidation is implemented in the cache handler but blocked by missing infrastructure work. The outbound proxy needs Surrogate-Key hashing support before purges will work.

### What Works

1. **Surrogate-Key headers are correctly set** - When content is served from cache, the `Surrogate-Key` response header contains the correct tags (e.g., `api-posts-remote external-data-remote`)

2. **Server-side cache invalidation works** - When `revalidateTag()` is called, the cache handler's `updateTags()` method is invoked

3. **Edge cache clear requests are sent** - The `EdgeCacheClear` class successfully calls the outbound proxy:
   ```
   DELETE http://{OUTBOUND_PROXY_ENDPOINT}/rest/v0alpha1/cache/keys/api-posts-remote
   ```

4. **Outbound proxy receives and forwards requests** - Logs show:
   ```
   [outbound-proxy] proxying cache key delete request
   [EdgeCacheClear] Cleared 1/1 keys in 849ms
   ```

### What Doesn't Work

**CDN cache is NOT actually purged.** After calling `revalidateTag()`:
- Pre-revalidation CDN Age: 25s
- Post-revalidation CDN Age: 30s (continues incrementing, not reset)

### Root Cause

The outbound proxy (Cloud Run glue proxy) is missing **Surrogate-Key hashing logic**.

From the infrastructure ticket:
> "The hashing for Styx in Surrogate-Key needs is ported into our Cloud Run glue proxy (the one Fastly uses to connect to tenants). Hashing behavior should be identical for site + env to the behavior Styx uses."

**Translation:**
- Styx (HTTP proxy) uses a hashing mechanism: `hash(site + env + tag)` → CDN cache key
- The Cloud Run outbound proxy doesn't have this hashing yet
- So when we purge `api-posts-remote`, it doesn't translate to the actual CDN cache key
- The CDN never receives a valid purge request

### Validation Steps

To reproduce this issue:

```bash
# 1. Clear CDN completely (via Pantheon API)
terminus env:clear-cache <site>.<env>

# 2. Warm server cache
curl https://<site>.pantheonsite.io/api/posts/with-tags-remote

# 3. Clear CDN again (so it caches with correct Surrogate-Key)
terminus env:clear-cache <site>.<env>

# 4. Verify Surrogate-Key is correct
curl -IH "Pantheon-Debug:1" https://<site>.pantheonsite.io/api/posts/with-tags-remote
# Should show: surrogate-key-raw: api-posts-remote external-data-remote

# 5. Wait 15 seconds, record CDN Age
curl -IH "Pantheon-Debug:1" ... | grep age
# age: 15

# 6. Trigger revalidation
curl https://<site>.pantheonsite.io/api/revalidate?tag=api-posts-remote

# 7. Check logs - should show EdgeCacheClear success

# 8. Check CDN Age again
curl -IH "Pantheon-Debug:1" ... | grep age
# EXPECTED (if working): age: 0-5
# ACTUAL (broken): age: 20+ (continues from step 5)
```

### Dependency

This feature is blocked until the infrastructure team completes:
- **Ticket**: "Forklift hashing from styx to Cloud Run proxy"
- **Requirement**: Port Surrogate-Key hashing logic from Styx to the Cloud Run glue proxy

### Temporary Workaround

For now, use the Pantheon Public API to clear the entire CDN cache:

```typescript
// Full cache clear (nuclear option)
await fetch(`https://api.pantheon.io/v0/sites/${siteId}/environments/${envId}/cache/clear`, {
  method: 'POST',
  headers: { 'Authorization': `Bearer ${session}` },
  body: JSON.stringify({ framework_cache: true })
});
```

This clears ALL cached content, not just the specific tag. Use sparingly.

## Future Improvements

1. **Request ID-based tracking** - Replace simple global array with a Map keyed by unique request IDs
2. **Next.js integration** - Work with Vercel to expose cache tags through official APIs
3. **Middleware support** - Extend to work with Next.js middleware for page routes
4. **Build-time manifest** - Extract tags from build output for `'use cache'` routes
5. **Remove debug headers** - Once E2E test infrastructure can use `Pantheon-Debug:1` to read `Surrogate-Key-Raw`, remove the temporary `x-surrogate-key-debug` and related headers
6. **Tag-based CDN purge** - Enable granular CDN invalidation once infrastructure hashing work is complete
