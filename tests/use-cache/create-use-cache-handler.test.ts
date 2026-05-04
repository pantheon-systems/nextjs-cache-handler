import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { createUseCacheHandler } from '../../src/index.js';
import type { UseCacheEntry } from '../../src/handlers/use-cache/types.js';
import { streamToBytes } from '../../src/utils/stream-serialization.js';

function createTestStream(data: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(data);
      controller.close();
    },
  });
}

function createTestEntry(options: Partial<UseCacheEntry> = {}): UseCacheEntry {
  return {
    value: options.value ?? createTestStream(new Uint8Array([1, 2, 3])),
    tags: options.tags ?? [],
    stale: options.stale ?? 60,
    timestamp: options.timestamp ?? Date.now(),
    expire: options.expire ?? 3600,
    revalidate: options.revalidate ?? 300,
  };
}

describe('createUseCacheHandler', () => {
  const defaultCacheDir = path.join(process.cwd(), '.next', 'cache', 'use-cache');

  beforeEach(() => {
    if (fs.existsSync(defaultCacheDir)) {
      fs.rmSync(defaultCacheDir, { recursive: true, force: true });
    }
  });

  afterEach(() => {
    if (fs.existsSync(defaultCacheDir)) {
      fs.rmSync(defaultCacheDir, { recursive: true, force: true });
    }
  });

  describe('returns an instance with callable methods', () => {
    it('should have a callable get method', () => {
      const handler = createUseCacheHandler({ type: 'file' });
      expect(typeof handler.get).toBe('function');
    });

    it('should have a callable set method', () => {
      const handler = createUseCacheHandler({ type: 'file' });
      expect(typeof handler.set).toBe('function');
    });

    it('should have a callable refreshTags method', () => {
      const handler = createUseCacheHandler({ type: 'file' });
      expect(typeof handler.refreshTags).toBe('function');
    });

    it('should have a callable getExpiration method', () => {
      const handler = createUseCacheHandler({ type: 'file' });
      expect(typeof handler.getExpiration).toBe('function');
    });

    it('should have a callable updateTags method', () => {
      const handler = createUseCacheHandler({ type: 'file' });
      expect(typeof handler.updateTags).toBe('function');
    });
  });

  describe('get → miss → set → get → hit round-trip', () => {
    it('should return undefined on miss, then the entry after set', async () => {
      const handler = createUseCacheHandler({ type: 'file' });

      const miss = await handler.get('factory-round-trip-key', []);
      expect(miss).toBeUndefined();

      const entry = createTestEntry({ tags: ['test-tag'] });
      await handler.set('factory-round-trip-key', Promise.resolve(entry));

      const hit = await handler.get('factory-round-trip-key', []);
      expect(hit).not.toBeUndefined();
      expect(hit!.tags).toEqual(['test-tag']);

      const bytes = await streamToBytes(hit!.value);
      expect(Array.from(bytes)).toEqual([1, 2, 3]);
    });
  });

  describe('updateTags invalidation', () => {
    it('should invalidate cached entries when their tags are updated', async () => {
      const handler = createUseCacheHandler({ type: 'file' });

      const pastTimestamp = Date.now() - 1000;
      const entry = createTestEntry({
        tags: ['factory-blog-post'],
        timestamp: pastTimestamp,
        revalidate: 86400,
      });
      await handler.set('factory-cached-entry', Promise.resolve(entry));

      const before = await handler.get('factory-cached-entry', []);
      expect(before).not.toBeUndefined();

      await handler.updateTags(['factory-blog-post'], [0]);

      const after = await handler.get('factory-cached-entry', []);
      expect(after).toBeUndefined();
    });

    it('should update tag expiration timestamps', async () => {
      const handler = createUseCacheHandler({ type: 'file' });

      const before = await handler.getExpiration(['factory-some-tag']);
      expect(before).toBe(0);

      await handler.updateTags(['factory-some-tag'], [0]);

      const after = await handler.getExpiration(['factory-some-tag']);
      expect(after).toBeGreaterThan(0);
    });
  });
});
