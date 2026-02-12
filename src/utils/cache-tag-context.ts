import { AsyncLocalStorage } from 'async_hooks';
import { createLogger } from './logger.js';

const log = createLogger('CacheTagContext');

/**
 * Symbol used to store the cache tag context accessor on globalThis.
 * Uses Symbol.for() to ensure the same symbol is used across module boundaries,
 * similar to Next.js's @next/request-context pattern.
 */
const CACHE_TAG_CONTEXT_SYMBOL = Symbol.for('@nextjs-cache-handler/tag-context');

interface CacheTagContextData {
  tags: string[];
  requestId: string;
  startTime: number;
}

interface CacheTagContextAccessor {
  get(): CacheTagContextData | undefined;
}

/**
 * AsyncLocalStorage instance for request-scoped context.
 * This is created once and registered globally via Symbol.for().
 */
const cacheTagContextStorage = new AsyncLocalStorage<CacheTagContextData>();

/**
 * The accessor object that will be stored on globalThis.
 * Cache handlers can retrieve this via globalThis[Symbol.for('@nextjs-cache-handler/tag-context')].
 */
const cacheTagContextAccessor: CacheTagContextAccessor = {
  get() {
    return cacheTagContextStorage.getStore();
  },
};

// Register the accessor on globalThis using the well-known symbol
// This allows cache handlers (which run in a different module context) to access it
(globalThis as Record<symbol, unknown>)[CACHE_TAG_CONTEXT_SYMBOL] = cacheTagContextAccessor;

/**
 * Request-scoped context for tracking cache tags using the Symbol.for pattern.
 *
 * This approach mirrors Next.js's @next/request-context pattern, which is known
 * to propagate through Next.js's internal mechanisms (used by `after()`).
 *
 * The key difference from direct AsyncLocalStorage usage is that cache handlers
 * can access this context via `globalThis[Symbol.for('@nextjs-cache-handler/tag-context')]`
 * rather than importing a module directly.
 */
export class CacheTagContext {
  /**
   * Add tags to the current request context.
   * Called by cache handler during cache hits.
   */
  static addTags(tags: string[]): void {
    const context = cacheTagContextStorage.getStore();
    if (context) {
      context.tags.push(...tags);
      log.debug(`Added ${tags.length} tags to CacheTagContext: ${tags.join(', ')}`);
    } else {
      log.debug('No CacheTagContext available - tags will not be captured via Symbol.for');
    }
  }

  /**
   * Get all unique tags accumulated during the current request.
   * Called by middleware before sending response.
   */
  static getTags(): string[] {
    const context = cacheTagContextStorage.getStore();
    if (!context) {
      return [];
    }
    return [...new Set(context.tags)];
  }

  /**
   * Get the current request ID.
   */
  static getRequestId(): string | undefined {
    return cacheTagContextStorage.getStore()?.requestId;
  }

  /**
   * Run a callback within a cache tag context.
   * Must be called by withSurrogateKey to initialize tracking.
   */
  static run<T>(callback: () => T): T {
    const requestId = crypto.randomUUID();
    log.debug(`Starting CacheTagContext with requestId: ${requestId}`);

    return cacheTagContextStorage.run(
      {
        tags: [],
        requestId,
        startTime: Date.now(),
      },
      callback
    );
  }

  /**
   * Check if running within a cache tag context.
   */
  static isActive(): boolean {
    return cacheTagContextStorage.getStore() !== undefined;
  }

  /**
   * Get the well-known symbol for accessing this context from cache handlers.
   * Cache handlers should use: globalThis[CacheTagContext.symbol]?.get()
   */
  static get symbol(): symbol {
    return CACHE_TAG_CONTEXT_SYMBOL;
  }
}

/**
 * Helper function for cache handlers to access the cache tag context.
 * This can be called from any module without importing CacheTagContext directly.
 *
 * @example
 * ```typescript
 * // In cache handler (use-cache-handler.mjs)
 * const context = globalThis[Symbol.for('@nextjs-cache-handler/tag-context')]?.get();
 * if (context) {
 *   context.tags.push(...entry.tags);
 * }
 * ```
 */
export function getCacheTagContextFromGlobal(): CacheTagContextData | undefined {
  const accessor = (globalThis as Record<symbol, unknown>)[CACHE_TAG_CONTEXT_SYMBOL] as
    | CacheTagContextAccessor
    | undefined;
  return accessor?.get();
}

/**
 * Helper function for cache handlers to add tags to the cache tag context.
 * This can be called from any module without importing CacheTagContext directly.
 */
export function addTagsToCacheTagContext(tags: string[]): boolean {
  const context = getCacheTagContextFromGlobal();
  if (context && tags.length > 0) {
    context.tags.push(...tags);
    log.debug(`Added ${tags.length} tags via global accessor: ${tags.join(', ')}`);
    return true;
  }
  return false;
}
