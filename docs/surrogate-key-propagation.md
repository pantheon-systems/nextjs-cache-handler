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

**Result**: Works correctly for single-request scenarios.

## Final Design

### Architecture

```
Request
  ↓
withSurrogateKey() ─── clears globalThis.__pantheonSurrogateKeyTags
  ↓
handler()
  ↓
'use cache: remote' function
  ↓
Next.js calls cache handler get()
  ↓
Cache HIT with tags → push to globalThis store
  ↓
withSurrogateKey() ─── reads globalThis, sets Surrogate-Key header
  ↓
Response with Surrogate-Key: tag1 tag2 tag3
```

### Components

1. **use-cache-handler.mjs** (user's project)
   - Wraps cache handler's `get()` method
   - On cache HIT with tags, pushes to `globalThis.__pantheonSurrogateKeyTags`
   - Tries `RequestContext.addTags()` first (for future compatibility)

2. **withSurrogateKey()** (library)
   - Clears global tag store before each request
   - Reads from `RequestContext` first (AsyncLocalStorage)
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

## Future Improvements

1. **Request ID-based tracking** - Replace simple global array with a Map keyed by unique request IDs
2. **Next.js integration** - Work with Vercel to expose cache tags through official APIs
3. **Middleware support** - Extend to work with Next.js middleware for page routes
4. **Build-time manifest** - Extract tags from build output for `'use cache'` routes
