// Edge-safe variant of the `./use-cache` subpath entry.
// Resolved by Next's edge bundler via the `edge-light` / `worker` export
// conditions (see package.json `exports`). Mirrors ./index.ts but sources the
// no-op factory from the edge-safe root so nothing here pulls in `fs` or
// `@google-cloud/storage`.

export { createUseCacheHandler, getUseCacheStats } from '../../index.edge.js';

export type {
  UseCacheEntry,
  UseCacheHandler,
  UseCacheHandlerConfig,
  SerializedUseCacheEntry,
  UseCacheStats,
  UseCacheEntryInfo,
} from '../../index.edge.js';
