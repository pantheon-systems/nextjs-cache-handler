import type { CacheHandlerConfig, CacheStats } from './types.js';
import { FileCacheHandler, getSharedCacheStats as getFileCacheStats, clearSharedCache as clearFileCache } from './handlers/file.js';
import { GcsCacheHandler, getSharedCacheStats as getGcsCacheStats, clearSharedCache as clearGcsCache } from './handlers/gcs.js';

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
 * const nextConfig = {
 *   cacheHandler: require.resolve('./cacheHandler'),
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
// Direct handler exports for advanced users
// ============================================================================

export { FileCacheHandler } from './handlers/file.js';
export { GcsCacheHandler } from './handlers/gcs.js';

// ============================================================================
// Request context for tag tracking
// ============================================================================

export { RequestContext } from './utils/request-context.js';

// ============================================================================
// Surrogate-Key header propagation utilities
// ============================================================================

// Route handler wrapper (recommended approach)
export { withSurrogateKey, type SurrogateKeyOptions } from './utils/with-surrogate-key.js';

// Legacy middleware exports (Note: middleware runs before route, so tags may not be captured)
export {
  createSurrogateKeyMiddleware,
  middleware as surrogateKeyMiddleware,
  config as surrogateKeyMiddlewareConfig,
  type SurrogateKeyMiddlewareConfig,
} from './middleware/index.js';

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
  LifespanParameters,
  SerializedBuffer,
  SerializedMap,
  SerializableValue,
  SerializedCacheData,
} from './types.js';

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
