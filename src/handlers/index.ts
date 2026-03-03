// ============================================================================
// Legacy Cache Handlers (Next.js 14/15 cacheHandler singular)
// ============================================================================

export { BaseCacheHandler } from './base.js';
export {
  FileCacheHandler,
  getSharedCacheStats as getFileSharedCacheStats,
  clearSharedCache as clearFileSharedCache,
} from './file.js';
export {
  GcsCacheHandler,
  getSharedCacheStats as getGcsSharedCacheStats,
  clearSharedCache as clearGcsSharedCache,
} from './gcs.js';

// ============================================================================
// Use Cache Handlers (Next.js 16 cacheHandlers plural)
// ============================================================================

export { UseCacheFileHandler } from './use-cache/file.js';
export { UseCacheGcsHandler } from './use-cache/gcs.js';

export {
  streamToBytes,
  bytesToStream,
  serializeUseCacheEntry,
  deserializeUseCacheEntry,
} from '../utils/stream-serialization.js';

export type {
  UseCacheEntry,
  UseCacheHandler,
  UseCacheHandlerConfig,
  SerializedUseCacheEntry,
  UseCacheStats,
  UseCacheEntryInfo,
} from './use-cache/types.js';
