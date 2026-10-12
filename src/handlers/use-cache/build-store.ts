import { createDefaultCacheHandler } from 'next/dist/server/lib/cache-handlers/default.js';
import type { UseCacheEntry } from './types.js';

// Next's own default size (cacheMaxMemorySize).
const BUILD_STORE_MAX_SIZE = 50 * 1024 * 1024;

export interface BuildStore {
  get(cacheKey: string, softTags: string[]): Promise<UseCacheEntry | undefined>;
  set(cacheKey: string, pendingEntry: Promise<UseCacheEntry>): Promise<void>;
}

let store: BuildStore | null = null;

// Next skips storing an `expire: 0` entry, so a failed render stores nothing.
const NOTHING_TO_STORE: UseCacheEntry = {
  value: new ReadableStream({ start: (controller) => controller.close() }),
  tags: [],
  stale: 0,
  timestamp: 0,
  expire: 0,
  revalidate: 0,
};

/**
 * Where `use cache` entries live during `next build`: Next's in-memory default
 * handler, per process. Prerendering relies on reading back what it just set,
 * and nothing here reaches the shared store the runtime reads.
 */
export function getBuildStore(): BuildStore {
  if (!store) {
    const next = createDefaultCacheHandler(BUILD_STORE_MAX_SIZE) as unknown as BuildStore;
    store = {
      get: (cacheKey, softTags) => next.get(cacheKey, softTags),
      // Next's set() awaits the entry outside its try, so a rejected render
      // would throw and leave later get()s for the key waiting forever.
      set: (cacheKey, pendingEntry) =>
        next.set(
          cacheKey,
          pendingEntry.catch(() => NOTHING_TO_STORE)
        ),
    };
  }
  return store;
}

/** @internal Test hook. */
export function resetBuildStoreForTests(): void {
  store = null;
}
