import type { CacheHandlerConfig, CacheStats } from './types.js';
import { FileCacheHandler, getSharedCacheStats as getFileCacheStats, clearSharedCache as clearFileCache } from './handlers/file.js';
import { GcsCacheHandler, getSharedCacheStats as getGcsCacheStats, clearSharedCache as clearGcsCache } from './handlers/gcs.js';
import { createEdgeCacheClearer } from './edge/edge-cache-clear.js';
import type { CacheClearResult } from './edge/edge-cache-clear.js';

/**
 * Factory function to create a cache handler based on configuration.
 *
 * @param config - Configuration options for the cache handler
 * @returns A cache handler class that can be used with Next.js
 *
 * @example
 * ```typescript
 * // In your cacheHandler.ts file:
 * import { createCacheHandler } from '@pantheon-systems/nextjs-cache-handler';
 *
 * const CacheHandler = createCacheHandler({
 *   type: 'auto', // Auto-detect: GCS if CACHE_BUCKET exists, else file-based
 * });
 *
 * export default CacheHandler;
 * ```
 *
 * @example
 * ```javascript
 * // In your next.config.mjs:
 * import path from "path";
 * import { fileURLToPath } from "url";
 *
 * const __dirname = path.dirname(fileURLToPath(import.meta.url));
 *
 * const nextConfig = {
 *   cacheHandler: path.resolve(__dirname, "./cacheHandler.mjs"),
 *   cacheMaxMemorySize: 0,
 * };
 *
 * export default nextConfig;
 * ```
 */
export function createCacheHandler(config?: CacheHandlerConfig): typeof FileCacheHandler | typeof GcsCacheHandler {
  const type = config?.type ?? 'auto';

  if (shouldUseGcs(type)) {
    return GcsCacheHandler;
  }

  return FileCacheHandler;
}

function shouldUseGcs(type: 'auto' | 'file' | 'gcs'): boolean {
  if (type === 'gcs') {
    return true;
  }

  if (type === 'auto') {
    return !!process.env.CACHE_BUCKET;
  }

  return false;
}

/**
 * Get cache statistics for the current environment.
 * Automatically detects whether to use file-based or GCS cache stats.
 */
export async function getSharedCacheStats(): Promise<CacheStats> {
  if (process.env.CACHE_BUCKET) {
    return getGcsCacheStats();
  }
  return getFileCacheStats();
}

/**
 * Clear all cache entries for the current environment.
 * Automatically detects whether to use file-based or GCS cache clearing.
 */
export async function clearSharedCache(): Promise<number> {
  if (process.env.CACHE_BUCKET) {
    return clearGcsCache();
  }
  return clearFileCache();
}

// ============================================================================
// Edge cache clearing for Pages Router SSR sites
// ============================================================================

/**
 * Clear specific paths from Pantheon's edge cache.
 * Use this for Pages Router SSR sites where routes aren't cached by Next.js
 * internally but are cached at the CDN layer.
 *
 * Returns null if OUTBOUND_PROXY_ENDPOINT is not configured (local dev).
 */
export async function clearEdgeCachePaths(paths: string[]): Promise<CacheClearResult | null> {
  const clearer = createEdgeCacheClearer();
  if (!clearer) return null;
  return clearer.clearPaths(paths);
}

/**
 * Clear the entire Pantheon edge cache.
 * Use sparingly — prefer clearEdgeCachePaths() for targeted invalidation.
 *
 * Returns null if OUTBOUND_PROXY_ENDPOINT is not configured (local dev).
 */
export async function clearEdgeCache(): Promise<CacheClearResult | null> {
  const clearer = createEdgeCacheClearer();
  if (!clearer) return null;
  return clearer.nukeCache();
}

// ============================================================================
// Direct handler exports for advanced users
// ============================================================================

export { FileCacheHandler } from './handlers/file.js';
export { GcsCacheHandler } from './handlers/gcs.js';

// ============================================================================
// Type exports
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

// ============================================================================
// Next.js 16 'use cache' Handler Exports
// ============================================================================

export {
  createUseCacheHandler,
  UseCacheFileHandler,
  UseCacheGcsHandler,
  streamToBytes,
  bytesToStream,
  serializeUseCacheEntry,
  deserializeUseCacheEntry,
  getUseCacheStats,
} from './use-cache/index.js';

export type {
  UseCacheEntry,
  UseCacheHandler,
  UseCacheHandlerConfig,
  SerializedUseCacheEntry,
  UseCacheStats,
  UseCacheEntryInfo,
} from './use-cache/index.js';
