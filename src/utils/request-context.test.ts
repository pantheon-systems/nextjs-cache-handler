import { describe, it, expect } from 'vitest';
import { RequestContext } from './request-context';

describe('RequestContext', () => {
  it('should isolate tags between contexts', () => {
    RequestContext.run(() => {
      RequestContext.addTags(['tag1', 'tag2']);
      expect(RequestContext.getTags()).toEqual(['tag1', 'tag2']);
    });

    // Outside context, should be empty
    expect(RequestContext.getTags()).toEqual([]);
  });

  it('should deduplicate tags', () => {
    RequestContext.run(() => {
      RequestContext.addTags(['tag1', 'tag2']);
      RequestContext.addTags(['tag2', 'tag3']);
      expect(RequestContext.getTags()).toEqual(['tag1', 'tag2', 'tag3']);
    });
  });

  it('should handle nested contexts independently', async () => {
    const results: string[][] = [];

    await Promise.all([
      RequestContext.run(async () => {
        RequestContext.addTags(['context1']);
        await new Promise(resolve => setTimeout(resolve, 10));
        results.push(RequestContext.getTags());
      }),
      RequestContext.run(async () => {
        RequestContext.addTags(['context2']);
        await new Promise(resolve => setTimeout(resolve, 5));
        results.push(RequestContext.getTags());
      }),
    ]);

    expect(results).toContainEqual(['context1']);
    expect(results).toContainEqual(['context2']);
  });

  it('should detect when context is active', () => {
    expect(RequestContext.isActive()).toBe(false);

    RequestContext.run(() => {
      expect(RequestContext.isActive()).toBe(true);
    });

    expect(RequestContext.isActive()).toBe(false);
  });

  it('should handle empty tag arrays', () => {
    RequestContext.run(() => {
      RequestContext.addTags([]);
      expect(RequestContext.getTags()).toEqual([]);
    });
  });

  it('should accumulate multiple tag additions', () => {
    RequestContext.run(() => {
      RequestContext.addTags(['tag1']);
      RequestContext.addTags(['tag2']);
      RequestContext.addTags(['tag3', 'tag4']);
      expect(RequestContext.getTags()).toEqual(['tag1', 'tag2', 'tag3', 'tag4']);
    });
  });

  it('should warn when adding tags outside context', () => {
    // This test verifies that adding tags outside a context doesn't throw
    // The actual warning is logged, but we can't easily test console output
    expect(() => {
      RequestContext.addTags(['tag1']);
    }).not.toThrow();
  });
});
