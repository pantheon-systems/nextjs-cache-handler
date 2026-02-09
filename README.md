# @pantheon-systems/nextjs-cache-handler

Custom cache handler for Next.js with support for Google Cloud Storage and file-based caching. Designed for Pantheon's Next.js hosting platform.

## Features

- **Dual Cache Handlers**: Support for both GCS (production) and file-based (development) caching
- **Tag-Based Invalidation**: Efficient O(1) cache invalidation using tag mapping
- **Buffer Serialization**: Handles Next.js 15 buffer compatibility issues
- **Build-Aware Caching**: Automatically invalidates route cache on new builds
- **Static Route Preservation**: Preserves SSG routes during cache clearing

## Installation

```bash
npm install @pantheon-systems/nextjs-cache-handler
```

## Quick Start

### 1. Create a cache handler file

```typescript
// cacheHandler.ts
import { createCacheHandler } from '@pantheon-systems/nextjs-cache-handler';

const CacheHandler = createCacheHandler({
  type: 'auto', // Auto-detect: GCS if CACHE_BUCKET exists, else file-based
});

export default CacheHandler;
```

### 2. Configure Next.js

```javascript
// next.config.mjs
const nextConfig = {
  cacheHandler: require.resolve('./cacheHandler'),
  cacheMaxMemorySize: 0, // Disable in-memory caching to use custom handler
};

export default nextConfig;
```

## Configuration

### `createCacheHandler(config?)`

Creates a cache handler based on the provided configuration.

```typescript
interface CacheHandlerConfig {
  /**
   * Handler type selection:
   * - 'auto': Automatically detect based on environment (GCS if CACHE_BUCKET is set, otherwise file)
   * - 'file': Use file-based caching (local development)
   * - 'gcs': Use Google Cloud Storage (production/Pantheon)
   */
  type?: 'auto' | 'file' | 'gcs';
}
```

> **Note:** Debug logging is controlled via the `CACHE_DEBUG` environment variable. See the [Debugging](#debugging) section for details.

## Environment Variables

| Variable | Description | Required |
|----------|-------------|----------|
| `CACHE_BUCKET` | GCS bucket name for storing cache | Required for GCS handler |
| `OUTBOUND_PROXY_ENDPOINT` | Edge cache proxy endpoint | Optional (enables edge cache clearing) |
| `CACHE_DEBUG` | Enable debug logging (`true` or `1`) | Optional |

## API Reference

### `createCacheHandler(config?)`

Factory function that returns the appropriate cache handler class based on configuration.

```typescript
import { createCacheHandler } from '@pantheon-systems/nextjs-cache-handler';

// Auto-detect based on environment
const CacheHandler = createCacheHandler();

// Force file-based caching
const FileCacheHandler = createCacheHandler({ type: 'file' });

// Force GCS caching
const GcsCacheHandler = createCacheHandler({ type: 'gcs' });
```

### `getSharedCacheStats()`

Returns cache statistics for the current environment.

```typescript
import { getSharedCacheStats } from '@pantheon-systems/nextjs-cache-handler';

const stats = await getSharedCacheStats();
console.log(stats);
// {
//   size: 10,
//   keys: ['fetch:abc123', 'route:_index'],
//   entries: [
//     { key: 'fetch:abc123', tags: ['posts'], type: 'fetch', lastModified: 1234567890 }
//   ]
// }
```

### `clearSharedCache()`

Clears all cache entries (preserving static SSG routes).

```typescript
import { clearSharedCache } from '@pantheon-systems/nextjs-cache-handler';

const clearedCount = await clearSharedCache();
console.log(`Cleared ${clearedCount} cache entries`);
```

### Direct Handler Access

For advanced use cases, you can import the handlers directly:

```typescript
import { FileCacheHandler, GcsCacheHandler } from '@pantheon-systems/nextjs-cache-handler';

// Use directly in your configuration
export default FileCacheHandler;
```

## Cache Types

The handler distinguishes between two cache types:

- **Fetch Cache**: Stores data from `fetch()` calls with caching enabled
- **Route Cache**: Stores rendered pages and route data

## Tag-Based Invalidation

The handler maintains a tag-to-keys mapping for efficient O(1) cache invalidation:

```typescript
// When setting cache with tags
await cacheHandler.set('post-1', data, { tags: ['posts', 'blog'] });

// When invalidating by tag
await cacheHandler.revalidateTag('posts');
// All entries tagged with 'posts' are invalidated
```

## Surrogate-Key Header Propagation

The cache handler automatically propagates cache tags to `Surrogate-Key` HTTP response headers, enabling standard CDN cache invalidation workflows.

### Quick Setup

1. Create or update `middleware.ts` in your app root:

```typescript
export { middleware, config } from '@pantheon-systems/nextjs-cache-handler/middleware';
```

2. That's it! Cache tags now appear in response headers:

```bash
# Request a cached page
curl -I https://your-app.com/blog/my-post

# Response includes:
# Surrogate-Key: blog-posts featured-content api-data
```

### How It Works

When you use `cacheTag()` in your Next.js code:

```typescript
import { cacheTag, cacheLife } from 'next/cache';

async function getBlogPost(slug: string) {
  'use cache';
  cacheLife('blog'); // 5min revalidation
  cacheTag('blog-posts', `post-${slug}`);

  return await fetchPost(slug);
}
```

The middleware automatically:
1. Captures tags from cache hits during page rendering
2. Aggregates all tags from multiple cache entries
3. Sets the `Surrogate-Key` header with space-separated tags
4. Merges with any existing Surrogate-Key headers

### Benefits

- **Standard CDN Integration**: Works with any CDN that supports Surrogate-Key headers
- **Redundant Purging**: Complements API-based cache clearing for reliability
- **Debugging**: Easily see which tags apply to each response
- **Zero Config**: Just re-export the middleware

### Advanced Configuration

Customize the middleware behavior:

```typescript
import { createSurrogateKeyMiddleware } from '@pantheon-systems/nextjs-cache-handler/middleware';

export const middleware = createSurrogateKeyMiddleware({
  debug: true,              // Enable debug logging
  fallbackKey: 'my-app',    // Custom fallback when no tags
});

export const config = {
  matcher: ['/app/*'],      // Custom route matching
};
```

### Integration with Edge Cache

The Surrogate-Key headers work alongside the existing API-based edge cache clearing:

**When you call `revalidateTag('blog-posts')`:**

1. ✅ Origin cache entries deleted
2. ✅ Edge cache purged via API: `DELETE /cache/keys/blog-posts`
3. ✅ Edge cache validates via Surrogate-Key headers

This provides **dual-layer invalidation** for maximum reliability.

### Verification

Check that Surrogate-Key headers are being set:

```bash
# Development
curl -I http://localhost:3000/your-page

# Production
curl -I https://your-app.com/your-page
```

Look for the `Surrogate-Key` header in the response.

### Troubleshooting

**No Surrogate-Key header appearing?**

1. Verify middleware is set up: Check `middleware.ts` exists and exports correctly
2. Check if page is using cache: Only cached pages have tags
3. Enable debug mode: Use `createSurrogateKeyMiddleware({ debug: true })`
4. Check logs: Look for tag capture messages in server logs

**Tags not matching expectations?**

- Tags are captured from **cache hits**, not cache misses
- First request to a page (cache miss) won't have tags
- Subsequent requests (cache hits) will include tags
- Use `cacheTag()` in 'use cache' blocks to ensure tags are stored

## Build Invalidation

On each new build, the handler automatically:

1. Detects the new build ID
2. Invalidates the route cache (Full Route Cache)
3. Preserves the data cache (Fetch Cache)

This matches Next.js's expected behavior where route cache is invalidated on each deploy but data cache persists.

## Debugging

Enable debug logging to see detailed cache operations by setting the `CACHE_DEBUG` environment variable:

```bash
# Enable debug logging
CACHE_DEBUG=true npm run start

# Or
CACHE_DEBUG=1 npm run start
```

### Log Levels

The cache handler uses four log levels:

| Level | When Shown | Use Case |
|-------|------------|----------|
| `debug` | Only when `CACHE_DEBUG=true` | Verbose operational logs (GET, SET, HIT, MISS) |
| `info` | Only when `CACHE_DEBUG=true` | Important events (initialization, cache cleared) |
| `warn` | Always | Recoverable issues that might need attention |
| `error` | Always | Errors that affect cache operations |

### Example Output

When debug logging is enabled, you'll see output like:

```
[GcsCacheHandler] Initializing cache handler
[GcsCacheHandler] GET: /api/posts
[GcsCacheHandler] HIT: /api/posts (route)
[GcsCacheHandler] SET: /api/users (fetch)
[EdgeCacheClear] Cleared 3 paths in 45ms
[GcsCacheHandler] Revalidated 5 entries for tags: posts, blog
```

This helps diagnose cache behavior, verify cache hits/misses, and troubleshoot invalidation issues.

## Publishing

### Prerequisites

1. Ensure you're logged into npm with access to the `@pantheon-systems` scope:
   ```bash
   npm login --scope=@pantheon-systems
   ```

2. Verify your login:
   ```bash
   npm whoami
   ```

### Publishing Steps

1. **Update the version** in `package.json`:
   ```bash
   # Patch release (0.1.0 -> 0.1.1)
   npm version patch

   # Minor release (0.1.0 -> 0.2.0)
   npm version minor

   # Major release (0.1.0 -> 1.0.0)
   npm version major
   ```

2. **Build and test**:
   ```bash
   npm run build
   npm test
   ```

3. **Publish to npm**:
   ```bash
   npm publish --access public
   ```

   The `--access public` flag is required for scoped packages to be publicly accessible.

### Verify Publication

After publishing, verify the package is available:
```bash
npm view @pantheon-systems/nextjs-cache-handler
```

Or install it in a test project:
```bash
npm install @pantheon-systems/nextjs-cache-handler
```

## License

MIT
