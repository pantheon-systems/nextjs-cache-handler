import { describe, it, expect, beforeEach } from 'vitest';
import { CacheTagContext, getCacheTagContextFromGlobal, addTagsToCacheTagContext } from '../../src/utils/cache-tag-context.js';

/**
 * Symbol used to access CacheTagContext from globalThis.
 * This matches the Symbol.for pattern - using the same string
 * ensures we get the same symbol across module boundaries.
 */
const CACHE_TAG_CONTEXT_SYMBOL = Symbol.for('@nextjs-cache-handler/tag-context');

describe('CacheTagContext', () => {
  beforeEach(() => {
    // Clear any global state between tests
    const globalTags = (globalThis as Record<string, unknown>).__pantheonSurrogateKeyTags as string[] | undefined;
    if (globalTags) {
      globalTags.length = 0;
    }
  });

  describe('Symbol.for pattern', () => {
    it('should register accessor on globalThis via Symbol.for', () => {
      // The accessor should be registered when the module loads
      const accessor = (globalThis as Record<symbol, unknown>)[CACHE_TAG_CONTEXT_SYMBOL];

      expect(accessor).toBeDefined();
      expect(typeof accessor).toBe('object');
      expect(typeof (accessor as { get: () => unknown }).get).toBe('function');
    });

    it('should return undefined when not in a context', () => {
      const accessor = (globalThis as Record<symbol, unknown>)[CACHE_TAG_CONTEXT_SYMBOL] as { get: () => unknown };
      const context = accessor.get();

      expect(context).toBeUndefined();
    });

    it('should return context data when run() is active', () => {
      CacheTagContext.run(() => {
        const accessor = (globalThis as Record<symbol, unknown>)[CACHE_TAG_CONTEXT_SYMBOL] as { get: () => unknown };
        const context = accessor.get() as { tags: string[]; requestId: string };

        expect(context).toBeDefined();
        expect(Array.isArray(context.tags)).toBe(true);
        expect(typeof context.requestId).toBe('string');
      });
    });

    it('should allow direct mutation of tags via Symbol.for accessor', () => {
      CacheTagContext.run(() => {
        // Simulate what cache handler does - access via Symbol.for
        const accessor = (globalThis as Record<symbol, unknown>)[CACHE_TAG_CONTEXT_SYMBOL] as { get: () => unknown };
        const context = accessor.get() as { tags: string[] };

        // Directly push tags (this is how cache handler adds tags)
        context.tags.push('tag1', 'tag2');

        // Verify via CacheTagContext.getTags()
        const retrievedTags = CacheTagContext.getTags();
        expect(retrievedTags).toContain('tag1');
        expect(retrievedTags).toContain('tag2');
      });
    });

    it('should maintain separate contexts for nested runs', () => {
      CacheTagContext.run(() => {
        CacheTagContext.addTags(['outer']);

        // Nested run should have its own context
        CacheTagContext.run(() => {
          CacheTagContext.addTags(['inner']);

          const innerTags = CacheTagContext.getTags();
          expect(innerTags).toContain('inner');
          expect(innerTags).not.toContain('outer');
        });

        const outerTags = CacheTagContext.getTags();
        expect(outerTags).toContain('outer');
        expect(outerTags).not.toContain('inner');
      });
    });
  });

  describe('helper functions', () => {
    it('getCacheTagContextFromGlobal should return context when active', () => {
      // Outside context
      expect(getCacheTagContextFromGlobal()).toBeUndefined();

      // Inside context
      CacheTagContext.run(() => {
        const context = getCacheTagContextFromGlobal();
        expect(context).toBeDefined();
        expect(Array.isArray(context!.tags)).toBe(true);
      });
    });

    it('addTagsToCacheTagContext should add tags when context is active', () => {
      CacheTagContext.run(() => {
        const result = addTagsToCacheTagContext(['tag1', 'tag2']);

        expect(result).toBe(true);

        const tags = CacheTagContext.getTags();
        expect(tags).toContain('tag1');
        expect(tags).toContain('tag2');
      });
    });

    it('addTagsToCacheTagContext should return false when context is not active', () => {
      const result = addTagsToCacheTagContext(['tag1']);
      expect(result).toBe(false);
    });
  });

  describe('basic functionality', () => {
    it('should generate unique request IDs', () => {
      const requestIds: string[] = [];

      CacheTagContext.run(() => {
        requestIds.push(CacheTagContext.getRequestId()!);
      });

      CacheTagContext.run(() => {
        requestIds.push(CacheTagContext.getRequestId()!);
      });

      expect(requestIds[0]).not.toBe(requestIds[1]);
    });

    it('should deduplicate tags in getTags()', () => {
      CacheTagContext.run(() => {
        CacheTagContext.addTags(['tag1', 'tag2', 'tag1', 'tag2', 'tag1']);

        const tags = CacheTagContext.getTags();
        expect(tags).toEqual(['tag1', 'tag2']);
      });
    });

    it('isActive should return correct state', () => {
      expect(CacheTagContext.isActive()).toBe(false);

      CacheTagContext.run(() => {
        expect(CacheTagContext.isActive()).toBe(true);
      });

      expect(CacheTagContext.isActive()).toBe(false);
    });
  });

  describe('async context propagation', () => {
    it('should propagate context through async operations', async () => {
      await CacheTagContext.run(async () => {
        CacheTagContext.addTags(['before-await']);

        // Simulate async operation
        await new Promise(resolve => setTimeout(resolve, 10));

        CacheTagContext.addTags(['after-await']);

        const tags = CacheTagContext.getTags();
        expect(tags).toContain('before-await');
        expect(tags).toContain('after-await');
      });
    });

    it('should propagate context through Promise chains', async () => {
      await CacheTagContext.run(async () => {
        await Promise.resolve()
          .then(() => CacheTagContext.addTags(['step1']))
          .then(() => CacheTagContext.addTags(['step2']))
          .then(() => CacheTagContext.addTags(['step3']));

        const tags = CacheTagContext.getTags();
        expect(tags).toContain('step1');
        expect(tags).toContain('step2');
        expect(tags).toContain('step3');
      });
    });

    it('Symbol.for accessor should work in async callbacks', async () => {
      await CacheTagContext.run(async () => {
        // First check - immediate
        let accessor = (globalThis as Record<symbol, unknown>)[CACHE_TAG_CONTEXT_SYMBOL] as { get: () => unknown };
        let context = accessor.get() as { tags: string[] };
        expect(context).toBeDefined();

        // After await
        await new Promise(resolve => setTimeout(resolve, 10));

        // Check again - should still have context
        accessor = (globalThis as Record<symbol, unknown>)[CACHE_TAG_CONTEXT_SYMBOL] as { get: () => unknown };
        context = accessor.get() as { tags: string[] };
        expect(context).toBeDefined();

        // Add tags via Symbol.for accessor
        context.tags.push('async-tag');

        // Verify
        expect(CacheTagContext.getTags()).toContain('async-tag');
      });
    });
  });
});

describe('Cross-module context access simulation', () => {
  /**
   * This test simulates what happens when a cache handler (in a different module)
   * tries to access the context via Symbol.for.
   */
  it('should allow context access from "different module" via Symbol.for', () => {
    // Simulate being in the withSurrogateKey wrapper
    CacheTagContext.run(() => {
      // Simulate being in cache handler (different module)
      // Access via Symbol.for (same as cache handler does)
      const symbol = Symbol.for('@nextjs-cache-handler/tag-context');
      const accessor = (globalThis as Record<symbol, unknown>)[symbol] as { get: () => unknown };
      const context = accessor.get() as { tags: string[] } | undefined;

      expect(context).toBeDefined();

      // Add tags like cache handler would
      context!.tags.push('cache-handler-tag');

      // Back in "withSurrogateKey" - verify tags were captured
      const tags = CacheTagContext.getTags();
      expect(tags).toContain('cache-handler-tag');
    });
  });
});
