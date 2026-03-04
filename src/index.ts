import type { CacheHandlerConfig, CacheStats } from './types.js';
import type { UseCacheHandlerConfig, UseCacheStats } from './handlers/use-cache/types.js';
import {
  FileCacheHandler,
  GcsCacheHandler,
  getFileSharedCacheStats,
  getGcsSharedCacheStats,
  clearFileSharedCache,
  clearGcsSharedCache,
  UseCacheFileHandler,
  UseCacheGcsHandler,
} from './handlers/index.js';
import { createEdgeCacheClearer } from './edge/edge-cache-clear.js';
import type { CacheClearResult } from './edge/edge-cache-clear.js';

// ============================================================================
// Factory Functions
// ============================================================================

/**
 * Factory function to create a cache handler based on configuration.
 * For Next.js 14/15 cacheHandler (singular) configuration.
 *
 * @param config - Configuration options for the cache handler
 * @returns A cache handler class that can be used with Next.js
 *
 * @example
 * ```typescript
 * In your cacheHandler.ts file:
 * import { createCacheHandler } from '@pantheon-systems/nextjs-cache-handler';
 *
 * const CacheHandler = createCacheHandler({
 *   type: 'auto', // Auto-detect: GCS if CACHE_BUCKET exists, else file-based
 * });
 *
 * export default CacheHandler;
 * ```
 */
export function createCacheHandler(config?: CacheHandlerConfig): typeof FileCacheHandler | typeof GcsCacheHandler {
  if (shouldUseGcs(config?.type ?? 'auto')) {
    return GcsCacheHandler;
  }
  return FileCacheHandler;
}

/**
 * Factory function to create a use cache handler based on configuration.
 * For Next.js 16 cacheHandlers (plural) configuration.
 *
 * @param config - Configuration options for the cache handler
 * @returns A cache handler class that implements the cacheHandlers interface
 *
 * @example
 * ```typescript
 * In your use-cache-handler.ts file:
 * import { createUseCacheHandler } from '@pantheon-systems/nextjs-cache-handler';
 *
 * const UseCacheHandler = createUseCacheHandler({
 *   type: 'auto', // Auto-detect: GCS if CACHE_BUCKET exists, else file-based
 * });
 *
 * export default UseCacheHandler;
 * ```
 */
export function createUseCacheHandler(
  config?: UseCacheHandlerConfig
): typeof UseCacheFileHandler | typeof UseCacheGcsHandler {
  if (shouldUseGcs(config?.type ?? 'auto')) {
    return UseCacheGcsHandler;
  }
  return UseCacheFileHandler;
}

function shouldUseGcs(type: 'auto' | 'file' | 'gcs'): boolean {
  return type === 'gcs' || (type === 'auto' && !!process.env.CACHE_BUCKET);
}

// ============================================================================
// Stats & Cache Management
// ============================================================================

/**
 * Get cache statistics for the current environment.
 * Automatically detects whether to use file-based or GCS cache stats.
 */
export async function getSharedCacheStats(): Promise<CacheStats> {
  if (process.env.CACHE_BUCKET) {
    return getGcsSharedCacheStats();
  }
  return getFileSharedCacheStats();
}

/**
 * Get cache statistics for use-cache entries.
 * Automatically detects whether to use file-based or GCS cache stats.
 */
export async function getUseCacheStats(): Promise<UseCacheStats> {
  if (process.env.CACHE_BUCKET) {
    const handler = new UseCacheGcsHandler();
    return handler.getStats();
  }
  const handler = new UseCacheFileHandler();
  return handler.getStats();
}

/**
 * Clear all cache entries for the current environment.
 * Automatically detects whether to use file-based or GCS cache clearing.
 */
export async function clearSharedCache(): Promise<number> {
  if (process.env.CACHE_BUCKET) {
    return clearGcsSharedCache();
  }
  return clearFileSharedCache();
}

// ============================================================================
// Edge Cache Clearing (for Pages Router SSR sites)
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
// Handler Exports
// ============================================================================

export {
  // Legacy handlers (Next.js 14/15)
  FileCacheHandler,
  GcsCacheHandler,
  // Use cache handlers (Next.js 16)
  UseCacheFileHandler,
  UseCacheGcsHandler,
  // Stream utilities
  streamToBytes,
  bytesToStream,
  serializeUseCacheEntry,
  deserializeUseCacheEntry,
} from './handlers/index.js';

// ============================================================================
// Type Exports
// ============================================================================

export type {
  // Legacy types
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
  // Use cache types (Next.js 16)
  UseCacheEntry,
  UseCacheHandler,
  UseCacheHandlerConfig,
  SerializedUseCacheEntry,
  UseCacheStats,
  UseCacheEntryInfo,
} from './handlers/index.js';
