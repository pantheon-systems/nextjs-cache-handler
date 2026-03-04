// Re-export from main index for subpath import compatibility
// All functions are defined in src/index.ts as the single source of truth

export {
  // Factory function
  createUseCacheHandler,
  // Stats function
  getUseCacheStats,
  // Handlers
  UseCacheFileHandler,
  UseCacheGcsHandler,
  // Stream utilities
  streamToBytes,
  bytesToStream,
  serializeUseCacheEntry,
  deserializeUseCacheEntry,
} from '../../index.js';

export type {
  UseCacheEntry,
  UseCacheHandler,
  UseCacheHandlerConfig,
  SerializedUseCacheEntry,
  UseCacheStats,
  UseCacheEntryInfo,
} from '../../index.js';
