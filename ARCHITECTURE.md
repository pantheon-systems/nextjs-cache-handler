# How the cache is stored and invalidated (Next.js origin and CDN)

**Scope:** the GCS handlers (`src/handlers/gcs.ts`, `src/handlers/use-cache/gcs.ts`) and the edge
purge client (`src/edge/edge-cache-clear.ts`). The file handlers are not covered.

---

## 1. The pieces and where state lives

```mermaid
flowchart LR
  visitor([Visitor]) --> cdn[(CDN edge cache)]
  cdn -- "miss" --> router[Pantheon tenant router]
  router --> inst1["Cloud Run instance A<br/>Next.js + GcsCacheHandler"]
  router --> inst2["Cloud Run instance B<br/>Next.js + GcsCacheHandler"]

  subgraph proc["Per process (in memory)"]
    manifest["Next tagsManifest<br/>(stale / expired per tag)"]
    buffer["TagsBuffer<br/>pending tag → key adds"]
    delayed["DelayedPurges<br/>second purges on a timer"]
    tagts["use cache tag timestamps<br/>(reloaded in the background)"]
    served["servedAt<br/>route path → last time served from cache"]
    ucmem["use cache memory entries<br/>LRU, CACHE_USE_CACHE_MEMORY_MB"]
  end
  inst1 -.-> proc

  subgraph gcs["GCS bucket (prefix: '' for live, environments/ENV/ otherwise)"]
    route["route-cache/KEY.json<br/>pages, route handlers"]
    fetchc["fetch-cache/KEY.json<br/>fetch, unstable_cache"]
    image["image-cache/KEY.json"]
    tags["cache/tags/tags.json<br/>tag → cache keys"]
    reval["cache/tags/revalidations.json<br/>tag → stale/expired/at"]
    meta["build-meta.json<br/>generation = BUILD_ID[:deploymentId]"]
    uc["use-cache/KEY.json"]
    ucTags["use-cache/_tags.json<br/>tag → timestamp"]
    ucMeta["use-cache/_build-meta.json"]
  end
  inst1 --> gcs
  inst2 --> gcs

  build[".next/server (build output)<br/>prerendered .html/.body/.meta,<br/>prerender-manifest.json"]
  inst1 -. "read-through on miss" .-> build

  inst1 -- "DELETE purges" --> proxy[tenant-outbound-proxy]
  proxy --> gw[API Gateway edrt-api-gw]
  gw --> clearer[edge-cache-clearer]
  clearer --> policy[policy-docs lookup]
  clearer --> cdn
```

- `servedAt` records the public paths this process served from the cache (capped at 5000, oldest
  forgotten first). It is used only to decide which pages to purge after learning of another
  instance's revalidation (section 3).
- The `use cache` handler keeps recently read or written entries in memory (default 32 MB, LRU).
  A memory hit skips the GCS round trip but is checked against the same tag and revalidate expiry.
- Build-time prerendered pages are **not** in GCS. They are served from `.next/server` when GCS
  misses (`base.ts:385`), and their tags are indexed per process from the build output
  (`loadBuildPrerenderTags`), never written to `tags.json`.
- The CDN caches whatever `Cache-Control` Next sends (for a static page, `s-maxage=31536000`). It
  is told to drop entries only by purges; nothing ties a CDN entry to the GCS entry it came from.

## 2. Serving and storing a page

```mermaid
sequenceDiagram
  autonumber
  participant V as Visitor
  participant CDN
  participant B as Instance (Next + handler)
  participant G as GCS
  participant FS as .next/server

  V->>CDN: GET /blog/x
  alt CDN hit
    CDN-->>V: cached page
  else CDN miss
    CDN->>B: GET /blog/x
    B->>B: ensureInitialized() (build check once per process, see 5)
    B->>G: re-read revalidations.json if older than 1 s (wait ≤ 2 s, shared deadline)
    B->>B: apply revalidations to tagsManifest
    B->>G: read route-cache/KEY.json
    alt GCS hit, tags not expired
      G-->>B: entry (served even if stale, while it regenerates)
      B->>B: onServed: remember the path in servedAt
    else GCS miss
      B->>FS: build prerender read-through
      FS-->>B: prerendered page, or nothing
    end
    opt nothing usable: render
      B->>B: render page
      B->>G: write route-cache/KEY.json (set)
      B->>B: TagsBuffer.addTags(key, tags)
      Note over B,G: tags.json is written every 5 s (CACHE_TAGS_FLUSH_INTERVAL_MS): by an unref'd timer, or inline by the next set() once due. One conditional write per flush, merged with other instances' writes.
      B->>CDN: ISR path purge for the page, plus /_next/data route for Pages, in the background
    end
    B-->>CDN: page + Cache-Control
    CDN-->>V: page (now cached at the CDN)
  end
```

## 3. `revalidateTag()` / `revalidatePath()` and the two CDN purges

Called from a server action, a route handler (for example a site's `/api/revalidate`), or
Next's `revalidatePath` (which revalidates the implicit `_N_T_<path>` tags).

```mermaid
sequenceDiagram
  autonumber
  participant Caller as Server action / route handler
  participant A as Instance A (revalidating)
  participant G as GCS
  participant B as Instance B (not refreshed yet)
  participant P as Purge path (proxy → gateway → clearer)
  participant CDN

  Caller->>A: revalidateTag('posts')
  A->>A: tagsManifest: posts stale (or expired)
  A->>G: write revalidations.json (batched 250 ms, retried ≤ 5 s)
  A->>G: read tags.json, overlay this process's unflushed keys
  A->>A: + build-prerender keys for the tag, + implicit _N_T_ paths
  A->>A: keys → public paths (basePath, trailingSlash, data routes)
  A->>P: FIRST PURGE: DELETE /keys/TAG per tag + DELETE /paths/PATH per path, all at once (or one full purge for revalidatePath('/', 'layout'))
  P->>CDN: purge
  A-->>Caller: response (awaits the first purge only)

  Note over B,CDN: Race window: B re-reads revalidations.json at most once per second
  CDN->>B: miss for /blog/x
  B-->>CDN: OLD page (B still thinks it is fresh) → CDN caches it again

  B->>G: re-read revalidations.json (≤ 1 s later)
  B->>B: posts stale → next read of /blog/x regenerates

  Note over B,CDN: Instance B's own purge: when B reads the revalidation, it purges the paths it served after it
  B->>P: PURGE paths in servedAt newer than the revalidation (started inside the request that read it, not awaited)
  P->>CDN: purge (drops the old copy B put back)

  Note over A: DelayedPurges: due = stored + 2 refresh intervals (2 s), fired ≤ 1 s later so purges due close together go as one
  A->>P: SECOND PURGE (backstop): same keys and paths, merged with other second purges in the window
  P->>CDN: purge
```

An instance that learns of a revalidation another instance made (`SharedRevalidations.setOnLearned` →
`purgeServedAfterRevalidation`) purges only the paths it served from its cache after that
revalidation (1 s clock skew allowed), so an instance that served none sends no purge, and a
`revalidatePath('/', 'layout')` does not purge the whole site from every instance. It starts inside
the request whose cache read refreshed `revalidations.json`, which has CPU, and that read does not wait
for it. Revalidations already stored when an instance first reads the object are skipped, since it had
served nothing before then. This does not depend on a timer, unlike the second purge.

What each step depends on:

| Step | Code | If it fails or is late |
|---|---|---|
| Store revalidation | `shared-revalidations.ts`, `base.ts:562` | Retried on later reads and at `flushSharedTagsMapping()`; the second purge waits for the store (`gcs.ts:527-540`). Other instances keep serving the old page until it lands. |
| Read tags map | `gcs.ts:303` | Logged; only this process's own keys and build prerenders are purged. |
| First purge | `gcs.ts:527` (`purgeTags`), `edge-cache-clear.ts:114` | One request per path, no retry. Inside the request, so it has CPU. |
| Purge by an instance that learned of it | `shared-revalidations.ts` (`notifyLearned`), `gcs.ts:545` | Logged, never rejects; one request per path, no retry. Skipped for revalidations found on the instance's first read. |
| Second purge | `gcs.ts:527-540`, `delayed-purges.ts` | On a timer: with request-based CPU it fires at the instance's next request; lost if the process stops first, unless the app calls `flushSharedTagsMapping()` (needs `NEXT_MANUAL_SIG_HANDLE`). |

`use cache` entries are invalidated separately: Next calls the `use cache` handler's `updateTags`,
which writes `use-cache/_tags.json` timestamps (`use-cache/gcs.ts:581`). That handler sends no
CDN purges for tags; the route handler's purge above covers the pages.

Other instances' `use cache` reads see the invalidation two ways:

- `refreshTags()` reloads `_tags.json` in the background, at most once per
  `CACHE_TAGS_REFRESH_INTERVAL_MS`. It does not wait for GCS: Next awaits it inside a staged render
  whose static stage ends after one task, and a GCS wait would push every cached result out of that
  stage so the client could not reuse it.
- `invalidatedAt(tag)` also consults Next's `tagsManifest`, which the route handler fills from
  `revalidations.json`, so a render cannot reuse a value older than a revalidation the process
  already knows of, without waiting for the background reload.

## 4. Everything that sends a CDN purge

```mermaid
flowchart TB
  subgraph triggers["Triggers"]
    t1["revalidateTag / revalidatePath<br/>gcs.ts:506"]
    t2["ISR regeneration stores a route<br/>onRouteCacheSet, gcs.ts:616"]
    t3["tags.json flush finds keys whose tag<br/>was revalidated before they landed<br/>purgeMissedRevalidations, gcs.ts:111"]
    t4["New generation on first request<br/>route handler: base.ts:220 → gcs.ts:460"]
    t5["New generation on first request<br/>use cache handler: use-cache/gcs.ts:123"]
    t6["clearSharedCache()<br/>gcs.ts:733"]
    t8["Another instance's revalidation is read<br/>purgeServedAfterRevalidation, gcs.ts:545"]
    t7["Public API: clearEdgeCachePaths()<br/>clearEdgeCache(), index.ts"]
  end

  t1 -- "first purge, awaited" --> keysPaths["clearKeys(tags) + clearPaths(paths)<br/>or nukeCache()"]
  t1 -- "second purge, timer" --> dp[DelayedPurges]
  t3 -- "background" --> paths1["clearPaths(paths)"]
  t3 -- "re-purge, timer" --> dp
  dp --> keysPaths
  t2 -- "background" --> paths1
  t4 -- "awaited before serving" --> nuke["nukeCache()"]
  t5 -- "awaited before serving" --> nuke
  t6 -- "background" --> nuke
  t7 --> keysPaths
  t8 -- "background, only paths this process served" --> paths1

  keysPaths --> fan["One DELETE per path / key,<br/>all at once (Promise.all),<br/>5 s timeout each, no retry"]
  paths1 --> fan
  nuke --> one["One DELETE /cache,<br/>10 s timeout, no retry"]
  fan --> proxy[OUTBOUND_PROXY_ENDPOINT /rest/v0alpha1/cache]
  one --> proxy
```

Request shapes (`edge-cache-clear.ts`):

| Purge | Request | Encoding |
|---|---|---|
| Path | `DELETE /rest/v0alpha1/cache/paths/<seg>` | path without its leading `/`, `encodeURIComponent` twice (`node/998` → `node%252F998`; `/` → `%252F`) |
| Key (tag) | `DELETE /rest/v0alpha1/cache/keys/<seg>` | `encodeURIComponent` twice |
| Full | `DELETE /rest/v0alpha1/cache` | – |

Grouping that exists today: paths are a set per revalidation (`gcs.ts:576`) and per
`clearPaths` call; second purges due within 1 s are merged per target
(`delayed-purges.ts`). Nothing else is merged across calls, and nothing limits requests in
flight or per second; per-tenant limits are left to the platform.

## 5. Deploys (new generation)

```mermaid
sequenceDiagram
  autonumber
  participant N as First instance of new revision
  participant G as GCS
  participant P as Purge path
  participant CDN

  N->>N: generation = BUILD_ID[:deploymentId]<br/>(fallback-NOW if BUILD_ID and build-manifest are unreadable)
  N->>G: read build-meta.json
  alt generation differs
    N->>G: delete route-cache/*
    N->>P: full purge (awaited, before serving)
    P->>CDN: purge everything
    N->>G: prune revalidations.json to those since the previous build (background)
    N->>G: write build-meta.json
  end
  Note over N,G: The use cache handler does the same check against use-cache/_build-meta.json and sends its own full purge.
```

A process that falls back to `fallback-<Date.now()>` has a generation no other process shares,
so each such cold start would wipe `route-cache/` and fully purge the CDN.

## 6. Known gaps

| Gap | Effect | Where it is tracked |
|---|---|---|
| Second and background purges run on timers | Late under request-based CPU; lost on shutdown without `flushSharedTagsMapping()` | README "Revalidations across processes" |
| Revalidation first seen on an instance's first read of `revalidations.json` | That instance sends no purge for pages it may have served before the read | – |
| `use cache` tag reload is background | A tag revalidated elsewhere reaches this instance's `use cache` reads within about one refresh interval (route handler revalidations apply at once via `tagsManifest`) | README `CACHE_TAGS_REFRESH_INTERVAL_MS` |
| GCS stall longer than the second-purge delay | An instance still serving without the revalidation can re-cache the old page after the last purge | – |
