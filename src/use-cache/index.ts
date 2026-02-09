/**
 * Next.js 16 'use cache' Handler Module
 *
 * This module provides cache handlers for the new `cacheHandlers` (plural)
 * configuration in Next.js 16, which supports the `'use cache'` directive.
 *
 * @example
 * ```javascript
 * // next.config.mjs
 * import { createUseCacheHandler } from '@pantheon-systems/nextjs-cache-handler/use-cache';
 *
 * const nextConfig = {
 *   // Existing handler for ISR, routes, fetch cache
 *   cacheHandler: require.resolve('./cache-handler.mjs'),
 *
 *   // NEW handler for 'use cache' directive
 *   cacheHandlers: {
 *     default: require.resolve('./use-cache-handler.mjs'),
 *   },
 *
 *   cacheComponents: true,
 * };
 *
 * export default nextConfig;
 * ```
 */

import type { UseCacheHandlerConfig } from './types.js';
import { UseCacheFileHandler } from './file-handler.js';
import { UseCacheGcsHandler } from './gcs-handler.js';

/**
 * Factory function to create a use cache handler based on configuration.
 *
 * @param config - Configuration options for the cache handler
 * @returns A cache handler class that implements the cacheHandlers interface
 *
 * @example
 * ```typescript
 * // In your use-cache-handler.ts file:
 * import { createUseCacheHandler } from '@pantheon-systems/nextjs-cache-handler/use-cache';
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
  const type = config?.type ?? 'auto';

  if (shouldUseGcs(type)) {
    return UseCacheGcsHandler;
  }

  return UseCacheFileHandler;
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

// ============================================================================
// Handler exports
// ============================================================================

export { UseCacheFileHandler } from './file-handler.js';
export { UseCacheGcsHandler } from './gcs-handler.js';

// ============================================================================
// Type exports
// ============================================================================

export type {
  UseCacheEntry,
  UseCacheHandler,
  UseCacheHandlerConfig,
  SerializedUseCacheEntry,
  UseCacheStats,
  UseCacheEntryInfo,
} from './types.js';

// ============================================================================
// Stats function
// ============================================================================

/**
 * Get cache statistics for use-cache entries.
 * Automatically detects whether to use file-based or GCS cache stats.
 */
export async function getUseCacheStats(): Promise<import('./types.js').UseCacheStats> {
  if (process.env.CACHE_BUCKET) {
    const handler = new UseCacheGcsHandler();
    return handler.getStats();
  }
  const handler = new UseCacheFileHandler();
  return handler.getStats();
}

// ============================================================================
// Utility exports
// ============================================================================

export {
  streamToBytes,
  bytesToStream,
  serializeUseCacheEntry,
  deserializeUseCacheEntry,
} from './stream-serialization.js';
