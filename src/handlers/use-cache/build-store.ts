// default.external.js exists in Next.js 15 and 16; default.js and its
// createDefaultCacheHandler factory are 16+ only.
import defaultCacheHandlerModule from 'next/dist/server/lib/cache-handlers/default.external.js';
import type { UseCacheEntry } from './types.js';

export interface BuildStore {
  get(cacheKey: string, softTags: string[]): Promise<UseCacheEntry | undefined>;
  set(cacheKey: string, pendingEntry: Promise<UseCacheEntry>): Promise<void>;
}

let store: BuildStore | null = null;
// Next's handler is a process-wide singleton, so a test reset starts a new
// key namespace instead of a new store.
let generation = 0;

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
    // CJS module: imported from ESM the handler surfaces as `.default`, from a
    // bundler with __esModule interop as the import itself. Either way it is
    // Next's 50 MB in-memory handler (its cacheMaxMemorySize default).
    const mod = defaultCacheHandlerModule as unknown as BuildStore & { default?: BuildStore };
    const next = mod.default ?? mod;
    const prefix = generation === 0 ? '' : `${generation}:`;
    store = {
      get: (cacheKey, softTags) => next.get(prefix + cacheKey, softTags),
      // Next's set() awaits the entry outside its try, so a rejected render
      // would throw and leave later get()s for the key waiting forever.
      set: (cacheKey, pendingEntry) =>
        next.set(
          prefix + cacheKey,
          pendingEntry.catch(() => NOTHING_TO_STORE)
        ),
    };
  }
  return store;
}

/** @internal Test hook. */
export function resetBuildStoreForTests(): void {
  store = null;
  generation++;
}
