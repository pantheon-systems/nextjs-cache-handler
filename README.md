# @pantheon-systems/nextjs-cache-handler

Custom cache handler for Next.js with support for Google Cloud Storage and file-based caching. Designed for Pantheon's Next.js hosting platform.

## Features

- **Dual Cache Handlers**: Support for both GCS (production) and file-based (development) caching
- **Next.js 16 `use cache` Support**: Handlers for the new `cacheHandlers` (plural) API
- **Tag-Based Invalidation**: Efficient O(1) cache invalidation using tag mapping
- **Edge Cache Clearing**: Automatic CDN cache invalidation on Pantheon infrastructure
- **Build-Aware Caching**: Automatically invalidates route cache on new builds
- **Static Route Preservation**: Preserves SSG routes during cache clearing
- **Edge-Runtime Safe**: Ships an edge-safe entry (resolved via the `edge-light`/`worker` export conditions) so a globally-configured cache handler doesn't break edge routes or edge middleware

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
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const nextConfig = {
  cacheHandler: path.resolve(__dirname, "./cacheHandler.mjs"),
  cacheMaxMemorySize: 0, // Disable in-memory caching to use custom handler
};

export default nextConfig;
```

## Edge runtime safety

The GCS and file handlers are Node-only — they import `fs` and
`@google-cloud/storage`. When a cache handler is configured **globally** (via
`cacheHandler` / `cacheHandlers` in `next.config`, as Pantheon's build adapter
does zero-touch), Next.js bundles it into **edge routes and edge middleware**
too. If the entry point pulled in `fs`, those edge builds would fail with
`edge runtime does not support Node.js 'fs'` (or `Can't resolve 'net'`).

To avoid that, the package ships a separate **edge-safe entry** exposing the same
API backed by no-op handlers, and maps it through the `edge-light`, `worker`,
`workerd`, and `browser` [export conditions](https://nodejs.org/api/packages.html#conditional-exports).
Next's edge compiler resolves the edge-safe entry; the Node server resolves the
real handlers. No configuration is needed — importing `@pantheon-systems/nextjs-cache-handler`
just works in both runtimes.

> ⚠️ **Do not add this package to `transpilePackages`.** Transpiling a package
> makes Next's edge compiler bundle its source and **ignore the `edge-light`
> export condition**, which drags the Node handlers back into the edge bundle and
> reintroduces the `fs`/`net` build failure. Leave it as a normal (externalized)
> dependency.

Edge routes/middleware never persist to the shared cache, so the edge no-op
handlers are correct: reads miss and writes are dropped at the edge, while the
Node server performs real caching.

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
| `OUTBOUND_PROXY_ENDPOINT` | Edge cache proxy endpoint (Pantheon infrastructure) | Optional (enables edge cache clearing) |
| `CACHE_DEBUG` | Enable debug logging (`true` or `1`) | Optional |
| `CACHE_TAGS_FLUSH_INTERVAL_MS` | How often each server process writes the tag-to-keys mapping to GCS (default `5000`, minimum `1000`). See [Tag-Based Invalidation](#tag-based-invalidation). | Optional |

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

## Next.js 16 `use cache` Handlers

Next.js 16 introduces the `'use cache'` directive with a new `cacheHandlers` (plural) configuration. This package provides handlers for it.

### 1. Create a use-cache handler file

`createUseCacheHandler` returns the handler **class**. Next.js's `cacheHandlers`
(plural) API expects each entry's default export to be an **instance** with
callable `.get/.set/...` methods — Next does not call `new` on it. So you must
instantiate the class with `new` and export the instance:

```typescript
// use-cache-handler.mjs
import { createUseCacheHandler } from '@pantheon-systems/nextjs-cache-handler/use-cache';

const UseCacheHandler = createUseCacheHandler({
  type: 'auto', // Auto-detect: GCS if CACHE_BUCKET exists, else file-based
});

// Note the `new` — Next.js calls methods directly on this exported value
// and will not instantiate the class for you.
export default new UseCacheHandler();
```

> If you forget the `new`, Next.js builds will hang (~60s) and then fail
> because `.get/.set/...` are undefined on the class itself.

### 2. Configure Next.js

```javascript
// next.config.mjs
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const nextConfig = {
  // Existing handler for ISR, routes, fetch cache
  cacheHandler: path.resolve(__dirname, "./cache-handler.mjs"),

  // Handler for 'use cache' directive
  cacheHandlers: {
    default: path.resolve(__dirname, "./use-cache-handler.mjs"),
  },

  cacheMaxMemorySize: 0,
  cacheComponents: true,
};

export default nextConfig;
```

### `createUseCacheHandler(config?)`

Factory function that returns the appropriate use-cache handler. Accepts the same `type` option (`'auto'`, `'file'`, `'gcs'`).

### `getUseCacheStats()`

Returns statistics for `use cache` entries, similar to `getSharedCacheStats()`.

```typescript
import { getUseCacheStats } from '@pantheon-systems/nextjs-cache-handler';

const stats = await getUseCacheStats();
```

### Direct Handler Access

```typescript
import { UseCacheFileHandler, UseCacheGcsHandler } from '@pantheon-systems/nextjs-cache-handler';
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

### How the mapping is written to GCS

GCS allows roughly one write per second per object name, and the mapping is a
single object (`cache/tags/tags.json`) shared by every server process. The GCS
handler therefore:

- keeps one write buffer per process, not per handler instance (Next.js
  constructs a cache handler for every request), and writes the mapping at most
  once per `CACHE_TAGS_FLUSH_INTERVAL_MS`, flushing from inside the request that
  made the interval elapse, so it does not depend on background timers;
- skips the write entirely when the mapping did not change (for example an ISR
  regeneration of an already-mapped page);
- writes with an `ifGenerationMatch` precondition, so concurrent processes merge
  their updates instead of overwriting each other, and re-reads on a conflict;
- never writes on `revalidateTag()`: reads overlay the process's pending updates
  on the stored mapping;
- on a failed write (including `429 rateLimitExceeded`) keeps the updates queued
  and retries with exponential backoff (up to 60s). It logs one warning when a
  failure streak starts and one when it recovers. After 10 consecutive failures
  the batch is dropped with an error.

A freshly cached page can therefore be absent from the mapping for up to the
flush interval. Raise `CACHE_TAGS_FLUSH_INTERVAL_MS` if a site that runs many
instances still logs `429` warnings during cold-cache bursts; lower it (minimum
`1000`) if the mapping lag matters more than write headroom.

Two situations still lose pending updates, and a lost update means a later
`revalidateTag()` will not purge the CDN for that page: 10 consecutive failed
writes (about 6 minutes at the default interval, logged as an error), and a
process exiting with updates still queued. Next.js exits on `SIGTERM` before the
handler can flush. If your app sets `NEXT_MANUAL_SIG_HANDLE` and handles the
signal itself, call `flushSharedTagsMapping()` from this package before exiting.
Call it from process-level code such as a custom `server.js`, which shares the
module instance Next.js loaded the cache handler into. Code that Next.js bundles
(route handlers, `instrumentation.ts`) may get its own copy of the package with
an empty buffer registry, so a call from there flushes nothing. The function
returns the number of buffers it flushed. A `0` from a shutdown hook that should
have had pending updates means it ran in the wrong module instance.

The `use cache` GCS handler writes its tag timestamps (`use-cache/_tags.json`)
synchronously on `updateTags()` so other instances see revalidations promptly,
but serializes concurrent calls, merges with the stored timestamps under the
same generation precondition, and backs off on failure.

## Edge Cache Clearing

When deployed on Pantheon, the cache handlers automatically clear the CDN edge cache when cache entries are invalidated. This is triggered by:

- `revalidateTag()` calls (clears matching surrogate keys and paths)
- `revalidatePath()` calls (clears the specific path from the CDN)

Edge cache clearing is enabled when the `OUTBOUND_PROXY_ENDPOINT` environment variable is set (automatically configured on Pantheon). It runs in the background and does not block cache operations.

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
