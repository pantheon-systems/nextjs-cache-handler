import { describe, it, expect } from 'vitest';
import type {
  UseCacheEntry,
  UseCacheHandler,
  UseCacheHandlerConfig,
} from '../../src/use-cache/types.js';

describe('UseCacheEntry type', () => {
  it('should have correct structure with ReadableStream value', () => {
    // Create a mock ReadableStream
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3]));
        controller.close();
      },
    });

    const entry: UseCacheEntry = {
      value: stream,
      tags: ['tag1', 'tag2'],
      stale: 60,
      timestamp: Date.now(),
      expire: 3600,
      revalidate: 300,
    };

    expect(entry.value).toBeInstanceOf(ReadableStream);
    expect(entry.tags).toEqual(['tag1', 'tag2']);
    expect(typeof entry.stale).toBe('number');
    expect(typeof entry.timestamp).toBe('number');
    expect(typeof entry.expire).toBe('number');
    expect(typeof entry.revalidate).toBe('number');
  });

  it('should allow empty tags array', () => {
    const stream = new ReadableStream<Uint8Array>();

    const entry: UseCacheEntry = {
      value: stream,
      tags: [],
      stale: 0,
      timestamp: Date.now(),
      expire: 0,
      revalidate: 0,
    };

    expect(entry.tags).toEqual([]);
  });
});

describe('UseCacheHandler interface', () => {
  it('should define get method with correct signature', async () => {
    const mockHandler: UseCacheHandler = {
      async get(cacheKey: string, softTags: string[]) {
        return undefined;
      },
      async set(cacheKey: string, pendingEntry: Promise<UseCacheEntry>) {
        await pendingEntry;
      },
      async refreshTags() {},
      async getExpiration(tags: string[]) {
        return 0;
      },
      async updateTags(tags: string[], durations: number[]) {},
    };

    const result = await mockHandler.get('test-key', ['soft-tag']);
    expect(result).toBeUndefined();
  });

  it('should define set method that accepts Promise<UseCacheEntry>', async () => {
    let receivedEntry: UseCacheEntry | null = null;

    const mockHandler: UseCacheHandler = {
      async get() {
        return undefined;
      },
      async set(cacheKey: string, pendingEntry: Promise<UseCacheEntry>) {
        receivedEntry = await pendingEntry;
      },
      async refreshTags() {},
      async getExpiration() {
        return 0;
      },
      async updateTags() {},
    };

    const stream = new ReadableStream<Uint8Array>();
    const entry: UseCacheEntry = {
      value: stream,
      tags: ['test'],
      stale: 60,
      timestamp: Date.now(),
      expire: 3600,
      revalidate: 300,
    };

    await mockHandler.set('key', Promise.resolve(entry));
    expect(receivedEntry).not.toBeNull();
    expect(receivedEntry!.tags).toEqual(['test']);
  });

  it('should define refreshTags method', async () => {
    let refreshCalled = false;

    const mockHandler: UseCacheHandler = {
      async get() {
        return undefined;
      },
      async set() {},
      async refreshTags() {
        refreshCalled = true;
      },
      async getExpiration() {
        return 0;
      },
      async updateTags() {},
    };

    await mockHandler.refreshTags();
    expect(refreshCalled).toBe(true);
  });

  it('should define getExpiration method returning timestamp', async () => {
    const mockHandler: UseCacheHandler = {
      async get() {
        return undefined;
      },
      async set() {},
      async refreshTags() {},
      async getExpiration(tags: string[]) {
        if (tags.includes('expired-tag')) {
          return Date.now();
        }
        return 0;
      },
      async updateTags() {},
    };

    const noExpiration = await mockHandler.getExpiration(['valid-tag']);
    expect(noExpiration).toBe(0);

    const hasExpiration = await mockHandler.getExpiration(['expired-tag']);
    expect(hasExpiration).toBeGreaterThan(0);
  });

  it('should define updateTags method with tags and durations', async () => {
    let updatedTags: string[] = [];
    let updatedDurations: number[] = [];

    const mockHandler: UseCacheHandler = {
      async get() {
        return undefined;
      },
      async set() {},
      async refreshTags() {},
      async getExpiration() {
        return 0;
      },
      async updateTags(tags: string[], durations: number[]) {
        updatedTags = tags;
        updatedDurations = durations;
      },
    };

    await mockHandler.updateTags(['tag1', 'tag2'], [3600, 7200]);
    expect(updatedTags).toEqual(['tag1', 'tag2']);
    expect(updatedDurations).toEqual([3600, 7200]);
  });
});

describe('UseCacheHandlerConfig', () => {
  it('should allow type selection', () => {
    const autoConfig: UseCacheHandlerConfig = { type: 'auto' };
    const fileConfig: UseCacheHandlerConfig = { type: 'file' };
    const gcsConfig: UseCacheHandlerConfig = { type: 'gcs' };

    expect(autoConfig.type).toBe('auto');
    expect(fileConfig.type).toBe('file');
    expect(gcsConfig.type).toBe('gcs');
  });

  it('should allow empty config', () => {
    const config: UseCacheHandlerConfig = {};
    expect(config.type).toBeUndefined();
  });
});
