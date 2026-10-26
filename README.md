# @pantheon-systems/nextjs-cache-handler

Custom cache handler for Next.js with support for Google Cloud Storage and file-based caching. Designed for Pantheon's Next.js hosting platform.

## Supported versions

[![Next.js 15](https://github.com/pantheon-systems/nextjs-cache-handler/actions/workflows/next-15.yml/badge.svg?branch=main&event=push)](https://github.com/pantheon-systems/nextjs-cache-handler/actions/workflows/next-15.yml?query=branch%3Amain)
[![Next.js 16](https://github.com/pantheon-systems/nextjs-cache-handler/actions/workflows/next-16.yml/badge.svg?branch=main&event=push)](https://github.com/pantheon-systems/nextjs-cache-handler/actions/workflows/next-16.yml?query=branch%3Amain)

Each badge shows whether the tests on `main` pass against the newest Next.js 15 and 16 releases.

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
  cacheMaxMemorySize: 0, // Turns off Next's built-in in-memory cache so this handler is the source of truth
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
| `CACHE_USE_CACHE_MEMORY_MB` | Memory each server process keeps for `'use cache'` entries (the `memoryMb` option of `createUseCacheHandler` takes precedence) it has read or written, least recently used first out (default `32`, `0` disables). A hit from memory resolves without a GCS round trip, which keeps it in the static part of a cached navigation; tag and revalidate expiry apply as for GCS hits. | Optional |
| `CACHE_INVALIDATION_DELETE_CONCURRENCY` | Deletes in flight at once when a new build deletes the earlier builds' entries in `route-cache/` (in the background), and when `clearSharedCache()` runs (default `50`, clamped to `1`–`200`). Raising it shortens the background delete; lowering it eases GCS throttling. See [Build Invalidation](#build-invalidation). | Optional |
| `CACHE_BUILD_INVALIDATION` | `off` stops a new build from deleting `route-cache/` (it still records the build, purges the CDN and removes earlier builds' keys from the tags map), for when the delete itself is the problem. Entries from earlier builds are still never served; they only take up storage until a deploy runs without `off`. Any other value, or unset, deletes as usual. | Optional |
| `CACHE_TAGS_REFRESH_INTERVAL_MS` | How often each server process reads revalidations made by other processes (default `1000`, minimum `100`). `revalidateTag()` schedules a second CDN purge for one interval plus up to 1 s (the interval again, capped at 1 s) after the first, 2 s by default. The `use cache` handler also reloads tag timestamps at most once per interval, in the background. See [Revalidations across processes](#revalidations-across-processes). | Optional |

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

### `getSharedCacheStats(options?)`

Returns cache statistics for the current environment. Every entry is read, so on a large cache pass `{ limit }` to read at most that many entries per cache type (fetch, route, image).

```typescript
import { getSharedCacheStats } from '@pantheon-systems/nextjs-cache-handler';

const stats = await getSharedCacheStats(); // or getSharedCacheStats({ limit: 100 })
console.log(stats);
// {
//   size: 10,
//   keys: ['fetch:abc123', 'route:_index'],
//   entries: [
//     { key: 'fetch:abc123', tags: ['posts'], type: 'fetch', lastModified: 1234567890 }
//   ]
// }
```

### `getSharedCacheCounts()`

Counts the objects in each cache and reads the size of the tag-to-keys mapping and the recorded
build, without reading any entry. On GCS that is one list request per 1,000 objects plus two small
reads, so it suits a large cache where `getSharedCacheStats()` would download every object. Route
objects are also counted by the build that wrote them (GCS only): any key other than
`buildMeta.buildId` is left over from an earlier build and never served, and `unstamped` counts
entries written before 0.13.4. Rejects when the cache can't be read, rather than reporting zeros.

```typescript
import { getSharedCacheCounts } from '@pantheon-systems/nextjs-cache-handler';

const counts = await getSharedCacheCounts();
// {
//   route: { objects: 1912, byGeneration: { 'a1B2c3:dpl-9': 1890, unstamped: 22 } },
//   fetch: { objects: 340 },
//   image: { objects: 57 },
//   tagsMap: { bytes: 48211 },
//   buildMeta: { buildId: 'a1B2c3:dpl-9', timestamp: 1791201540000, builtAt: 1791201480000 }
// }
```

Each call lists the whole cache. If you expose it through a route, require authentication: it
reveals how the cache is structured, and unauthenticated callers could run up list requests.

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
  memoryMb: 32, // Per-process in-memory entries for the GCS handler (default 32, 0 disables)
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

  // Only affects Next's built-in cache for the `cacheHandler` above. The
  // `'use cache'` handler's own memory is set with `memoryMb` in its handler file.
  cacheMaxMemorySize: 0,
  cacheComponents: true,
};

export default nextConfig;
```

### `createUseCacheHandler(config?)`

Factory function that returns the appropriate use-cache handler. Accepts the same `type` option (`'auto'`, `'file'`, `'gcs'`), plus `memoryMb` for the GCS handler's per-process memory (overrides `CACHE_USE_CACHE_MEMORY_MB`).

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
  once per `CACHE_TAGS_FLUSH_INTERVAL_MS` (plus up to 25% random jitter, so
  instances that start together spread out), flushing from inside the request
  that made the interval elapse, so it does not depend on background timers;
- skips the write entirely when the mapping did not change (for example an ISR
  regeneration of an already-mapped page);
- writes with an `ifGenerationMatch` precondition, so concurrent processes merge
  their updates instead of overwriting each other, and re-reads on a conflict;
- never writes on `revalidateTag()`: reads overlay the process's pending updates
  on the stored mapping;
- on a failed write (including `429 rateLimitExceeded`) keeps the updates queued
  and retries with exponential backoff (up to 60s). It logs one warning when a
  failure streak starts and one when it recovers. If updates have been pending
  for more than 10 minutes of failed writes, the batch is dropped with an error.

A freshly cached page can therefore be absent from the mapping for up to the
flush interval. A `revalidateTag()` on another process in that window cannot
purge it, so the process that flushes the key does: after each flush it purges
the keys whose tags were revalidated after they were cached. The CDN can then
serve such a page stale for up to one flush interval. Raise `CACHE_TAGS_FLUSH_INTERVAL_MS` if a site that runs many
instances still logs `429` warnings during cold-cache bursts; lower it (minimum
`1000`) if the mapping lag matters more than write headroom.

Two situations still lose pending updates, and a lost update means a later
`revalidateTag()` will not purge the CDN for that page: writes failing for
more than 10 minutes (the pending batch is then dropped, logged as an error), and a
process exiting with updates still queued. The shared object accepts one write per
second in total, so a service that runs more than about 10 instances through a
cold-cache event will see updates lag and, if many instances stop within the same
few seconds, some of them exit with updates pending. Raise the flush interval, or
keep max instances near that figure, for such sites. Next.js exits on `SIGTERM` before the
handler can flush. If your app sets `NEXT_MANUAL_SIG_HANDLE` and handles the
signal itself, call `flushSharedTagsMapping()` from this package before exiting.
It retries a failed write until a deadline (`{ timeoutMs }`, default 8000 ms, inside
Cloud Run's 10 s grace period), since several instances shutting down together take
turns on the shared object.
Call it from process-level code such as a custom `server.js`, which shares the
module instance Next.js loaded the cache handler into. Code that Next.js bundles
(route handlers, `instrumentation.ts`) may get its own copy of the package with
an empty buffer registry, so a call from there flushes nothing. The function
returns the number of buffers it flushed. A `0` from a shutdown hook that should
have had pending updates means it ran in the wrong module instance.

### Revalidations across processes

Next.js records a revalidation in a per-process manifest, and checks cached
pages, route handlers and `fetch` entries against it. The GCS handler also
stores each revalidation in `cache/tags/revalidations.json`, and every process
applies the stored ones to its own manifest before serving from the cache,
reading the object at most once per `CACHE_TAGS_REFRESH_INTERVAL_MS`. Cache
reads wait for that read until 2 s after it started, then serve with what the
process already knows, so a read that arrives during a slow one waits only for
the time left. A slow read logs one warning per streak, and the recovery
message reports how many cache reads were served without it.

`revalidateTag()` and `revalidatePath()` therefore:

1. store the revalidation (waiting up to 250 ms so revalidations from the same
   moment share one write, then retrying a failed write for up to 5 s);
2. purge the CDN;
3. purge the CDN again once every process has applied it (two refresh
   intervals, 2 s by default), so a process that had not refreshed yet cannot
   put the old page back in the CDN.

A process that had not refreshed yet can put the old page back in the CDN
between steps 2 and 3. So each process, when it reads a revalidation that
another process made, purges the CDN for the pages it served from its cache
after that revalidation. The purge starts inside the request that read it
(which has CPU) without holding up its cache reads. A process that served none
of those pages purges nothing, and never purges the whole site. (Revalidations
it finds on its first read are skipped, because it had served nothing before
then.) The second purge in step 3 is a backstop, for a process that served the
old page and then received no further requests.

A server action that revalidates responds after step 2; step 3 runs on a timer.
Second purges that come due within 1 s of each other are sent together, each
path and key once, so a burst of revalidations sends about one purge per second
per process. A process that gets no CPU between requests (Cloud Run with
request-based CPU allocation) sends an overdue second purge at its next
request; one that stops before then loses it unless the app calls
`flushSharedTagsMapping()` at shutdown, which sends it (waiting until it is due,
within its deadline). A route handler responds first; Next.js finishes the
revalidation after the response. If the revalidation could not be stored within
5 s, it is retried on later cache reads and the second purge is scheduled once
it is stored; `flushSharedTagsMapping()` also stores such revalidations at
shutdown.

### How long revalidations are kept

`revalidations.json` holds one entry per revalidated tag. At each deploy, the
first process of the new build removes the entries older than the previous
build: by then only `fetch()` and `unstable_cache` entries can be older than
those revalidations (the route cache is cleared on a deploy, and `use cache`
entries belong to their build), so it first deletes the fetch entries the tags
mapping lists under those tags. The object therefore holds roughly the
revalidations made since the previous deploy. Each build records when its
prerenders were written (`builtAt` in `build-meta.json`, less a minute's
margin), so the first deploy after upgrading prunes nothing; pruning starts at
the one after. A fetch entry missing from the tags mapping (one whose mapping
update was lost) is not deleted and is served again once its revalidation is
pruned.

### Batching revalidations

The revalidations object accepts about one write per second across all
processes. Next.js gathers every `revalidateTag()` and `revalidatePath()` call
made while handling one request and passes them to the handler together, one
call per cacheLife profile, so they share a write. Revalidations that reach a
process within 250 ms of each other share one too. A CMS that sends one webhook
per changed item, many per second, makes processes take turns on the object
and delays each revalidation; send the changed items in one request instead:

```ts
// app/api/revalidate/route.ts
import { revalidateTag } from 'next/cache';

export async function POST(request: Request) {
  // Verify the webhook's signature or shared secret first.
  const { tags } = (await request.json()) as { tags: string[] };
  for (const tag of tags) {
    revalidateTag(tag, 'max');
  }
  return Response.json({ revalidated: tags.length });
}
```

### File handler

The file handler (local development, or `type: 'file'`) keeps revalidations in
its own process: it does not share them through `.next/cache`, and it does not
purge the CDN. Several processes sharing one `.next/cache` directory can each 
serve an entry another process revalidated until they regenerate it. Use the 
GCS handler for more than one process.

### CDN purge paths

Path purges use the URL the page is served at: with `basePath`, with the slash
`trailingSlash: true` adds, and, for a Pages Router page, also its
`/_next/data/<buildId>/…json` data route and, under a default locale (`i18n`),
its URL without the locale prefix. These settings are read from the build
output (`required-server-files.json` and `BUILD_ID`).
`clearEdgeCachePaths()` gives the paths you pass the trailing slash the site
serves them with: added with `trailingSlash: true`, removed without it, and
drops any query string or fragment, since the CDN keys a page by its path alone.
`clearEdgeCachePaths()` purges only the paths you pass. To purge a Pages Router
page yourself, also pass its data route (`/_next/data/<buildId>/blog.json`) and,
for a default-locale page, both URLs (`/en/blog` as well as `/blog`).

The `use cache` GCS handler writes its tag timestamps (`use-cache/_tags.json`)
synchronously on `updateTags()` so other instances see revalidations promptly,
but serializes concurrent calls, merges with the stored timestamps under the
same generation precondition, and backs off on failure.

## Edge Cache Clearing

When deployed on Pantheon, the cache handlers automatically clear the CDN edge cache when cache entries are invalidated. This is triggered by:

- `revalidateTag()` calls (clears matching surrogate keys and paths)
- `revalidatePath()` calls (clears the specific path from the CDN)
- ISR regeneration storing a page (clears that page's paths)
- A new build, when a starting process detects it (clears the whole CDN)
- Another instance's revalidation, once this process reads it (clears the paths this process served from cache since)

Edge cache clearing is enabled when the `OUTBOUND_PROXY_ENDPOINT` environment variable is set (automatically configured on Pantheon). `revalidateTag()` and `revalidatePath()` wait for the first purge, and a new build's full purge finishes before the process serves its first request; the other purges run in the background. A failed purge never fails the cache operation.

## Build Invalidation

On each new build, the handler automatically:

1. Detects the new build ID
2. Invalidates the route cache (Full Route Cache)
3. Preserves the data cache (Fetch Cache)

This matches Next.js's expected behavior where route cache is invalidated on each deploy but data cache persists.

On the GCS handler, requests wait only for a full CDN purge and two small writes: the
clean-up job (`route-cache-cleanup.json`, next to `build-meta.json`) and then the new build ID in
`build-meta.json`. Deleting the earlier builds' entries runs in the background, so the first
request after a deploy is answered in normal time however large `route-cache/` is.

The background delete lists `route-cache/` one page (1,000 objects) at a time, with at most
`CACHE_INVALIDATION_DELETE_CONCURRENCY` deletes in flight, so memory stays flat. It deletes every
entry not written by the running build, and leaves the running build's entries alone, including
ones its instances cached since the deploy. An entry rewritten between the listing and its delete
is kept as well (each delete is conditional on the object being the version listed).

Only one instance at a time deletes the earlier builds' route entries. The job object is also a lock: an instance takes it with a
conditional write, renews it while it works (every 15 s, recording the last object name it reached),
and other instances leave it alone. If that instance stops, its lock lapses after 60 s and a later
instance resumes from the recorded name instead of from the start. Every instance checks for a
pending job when it starts, and again at most once a minute on route-cache reads, so a job left by
an instance that stopped is picked up by one that is still running. A newer deploy replaces the
job, and the instance still working on the older one stops at its next page.

When the delete finishes, the job lists `route-cache/` once more and removes from the tags map
(`cache/tags/tags.json`) the route keys whose entries are not the running build's; fetch keys stay.
Then it deletes the job and logs a warning such as
`Route cache clean-up for build <id> finished: deleted <n> objects of earlier builds (<listed> listed, <kept> of this build kept, <changed> rewritten during the delete kept), <failed> failed, in <ms>ms over <runs> runs`.
The counts cover every run that worked on the job; a run that stopped without releasing the lock
is counted up to its last renewal.

If the full CDN purge fails when the build is recorded, it is logged as an error and retried in
the background by every run of the job until it succeeds.

On Cloud Run with request-based billing an instance gets almost no CPU between requests, so the
background delete moves forward while requests arrive and pauses in between. A paused instance's
lock lapses and another instance can take over; the paused one notices at its next page and stops.

The GCS handler also stamps each route entry with the build that wrote it, and a route entry from
any other build is a cache miss (the build's prerender is used if there is one, otherwise the page is rendered again).
Entries a failed delete leaves behind, or that an instance of another revision writes during a
rollout, are therefore never served: they only take up storage until a later deploy deletes them.
Fetch and image entries are not tied to a build and are kept across deploys. Entries written
before 0.13.4 carry no build and miss once.

A listing that fails with throttling, a timeout, a server error or a network error is retried
twice (after 1 s, then 2 s); deletes that fail that way are retried once per page. What still
fails is logged with the failure counts by status (`503 x8, 403 x2`) and what to change: delete
permission on the bucket (logged as an error, since every deploy fails the same way until it is
fixed), or a lower `CACHE_INVALIDATION_DELETE_CONCURRENCY` for throttling. A listing that still
fails stops the run; it releases the lock with its progress, and a later instance resumes.

If the build ID can't be read (no `.next/BUILD_ID` or build manifest in the working directory),
the process gets a generation of its own, so the check is skipped with a warning instead of wiping
the cache and purging the CDN on every cold start. Such a process can't tell builds apart: a deploy
neither deletes the route cache nor purges the CDN, and it serves route entries from any build.
Start the server from the directory that contains `.next`.

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
