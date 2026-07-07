// ============================================================================
// Edge-safe entry point for @pantheon-systems/nextjs-cache-handler
// ============================================================================
//
// The Node cache handlers import `fs` and `@google-cloud/storage`, which the
// Next.js edge runtime cannot bundle (`edge runtime does not support Node.js
// 'fs'` / `Can't resolve 'net'`). When a cache handler is configured globally
// (as the Pantheon build adapter does, zero-touch), Next bundles it into edge
// routes and edge middleware too — so the *entry point* must be importable in
// the edge runtime even though the real handlers can only run under Node.
//
// This module is resolved by Next's edge bundler via the `edge-light` / `worker`
// export conditions (see package.json `exports`). The Node server continues to
// resolve `./index.ts` (the real handlers). Edge routes/middleware never persist
// to the shared cache, so the handlers here are safe no-ops that satisfy the
// Next.js cache interfaces without touching any Node built-in.
//
// Keep this file free of imports that transitively pull in `fs`,
// `@google-cloud/storage`, or other Node-only modules — that is the entire
// point of the file.

import type { CacheHandlerConfig, CacheStats, CacheHandlerValue } from './types.js';
import type { UseCacheHandlerConfig, UseCacheStats, UseCacheEntry } from './handlers/use-cache/types.js';
import type { CacheClearResult } from './edge/edge-cache-clear.js';

// ============================================================================
// No-op handlers (edge runtime)
// ============================================================================

/**
 * Edge-runtime no-op stand-in for the legacy `cacheHandler` (singular).
 * Every read is a miss and every write is dropped — persistence is a Node-only
 * concern handled by the real handlers on the server.
 */
class EdgeNoopCacheHandler {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  constructor(_context?: unknown) {}
  async get(): Promise<CacheHandlerValue | null> {
    return null;
  }
  async set(): Promise<void> {}
  async revalidateTag(): Promise<void> {}
  resetRequestCache(): void {}
}

/**
 * Edge-runtime no-op stand-in for the `'use cache'` handler (`cacheHandlers`,
 * plural). Reads miss, writes drop, tags are inert.
 */
class EdgeNoopUseCacheHandler {
  async get(): Promise<UseCacheEntry | undefined> {
    return undefined;
  }
  async set(): Promise<void> {}
  async refreshTags(): Promise<void> {}
  async getExpiration(): Promise<number> {
    return 0;
  }
  async updateTags(): Promise<void> {}
  async getStats(): Promise<UseCacheStats> {
    return { size: 0, entries: [], keys: [] };
  }
}

// ============================================================================
// Factory functions (mirror ./index.ts, edge-safe)
// ============================================================================

/**
 * Edge-safe {@link createCacheHandler}. Returns a no-op handler class — the real
 * GCS/file handlers are Node-only and resolved for the Node server build.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function createCacheHandler(_config?: CacheHandlerConfig): typeof EdgeNoopCacheHandler {
  return EdgeNoopCacheHandler;
}

/**
 * Edge-safe {@link createUseCacheHandler}. Returns a no-op handler class.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function createUseCacheHandler(_config?: UseCacheHandlerConfig): typeof EdgeNoopUseCacheHandler {
  return EdgeNoopUseCacheHandler;
}

// ============================================================================
// Stats & cache management (edge-safe stubs)
// ============================================================================

export async function getSharedCacheStats(): Promise<CacheStats> {
  return { size: 0, keys: [], entries: [] };
}

export async function getUseCacheStats(): Promise<UseCacheStats> {
  return { size: 0, entries: [], keys: [] };
}

export async function clearSharedCache(): Promise<number> {
  return 0;
}

// ============================================================================
// Edge cache clearing (edge-safe stubs)
// ============================================================================
// The real implementations POST to the Pantheon outbound proxy and are only
// meaningful from the Node server; at the edge they are inert.

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export async function clearEdgeCachePaths(_paths: string[]): Promise<CacheClearResult | null> {
  return null;
}

export async function clearEdgeCache(): Promise<CacheClearResult | null> {
  return null;
}

// ============================================================================
// Type re-exports (erased at runtime — safe to forward verbatim)
// ============================================================================

export type {
  CacheHandlerConfig,
  CacheStats,
  CacheEntryInfo,
  CacheContext,
  CacheEntry,
  CacheData,
  CacheHandlerValue,
  CacheHandlerParametersGet,
  CacheHandlerParametersSet,
  CacheHandlerParametersRevalidateTag,
  FileSystemCacheContext,
  Revalidate,
  SerializedBuffer,
  SerializedMap,
  SerializableValue,
  SerializedCacheData,
} from './types.js';

export type { CacheClearResult } from './edge/edge-cache-clear.js';

export type {
  UseCacheEntry,
  UseCacheHandler,
  UseCacheHandlerConfig,
  SerializedUseCacheEntry,
  UseCacheStats,
  UseCacheEntryInfo,
} from './handlers/use-cache/types.js';
