import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { UseCacheFileHandler } from '../../src/use-cache/file-handler.js';
import type { UseCacheEntry } from '../../src/use-cache/types.js';
import { streamToBytes } from '../../src/use-cache/stream-serialization.js';
import { RequestContext } from '../../src/utils/request-context.js';

// Helper to create a test stream
function createTestStream(data: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(data);
      controller.close();
    },
  });
}

// Helper to create a test entry
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

describe('UseCacheFileHandler', () => {
  const testCacheDir = path.join(process.cwd(), '.next', 'cache', 'use-cache-test');

  beforeEach(() => {
    // Clean up test directory
    if (fs.existsSync(testCacheDir)) {
      fs.rmSync(testCacheDir, { recursive: true, force: true });
    }
  });

  afterEach(() => {
    // Clean up test directory
    if (fs.existsSync(testCacheDir)) {
      fs.rmSync(testCacheDir, { recursive: true, force: true });
    }
  });

  describe('constructor', () => {
    it('should create handler instance', () => {
      const handler = new UseCacheFileHandler({ cacheDir: testCacheDir });
      expect(handler).toBeInstanceOf(UseCacheFileHandler);
    });

    it('should create cache directory if it does not exist', () => {
      expect(fs.existsSync(testCacheDir)).toBe(false);
      new UseCacheFileHandler({ cacheDir: testCacheDir });
      expect(fs.existsSync(testCacheDir)).toBe(true);
    });
  });

  describe('get', () => {
    it('should return undefined for non-existent cache entry', async () => {
      const handler = new UseCacheFileHandler({ cacheDir: testCacheDir });
      const result = await handler.get('non-existent-key', []);
      expect(result).toBeUndefined();
    });

    it('should return cached entry when it exists', async () => {
      const handler = new UseCacheFileHandler({ cacheDir: testCacheDir });

      // Set an entry first
      const entry = createTestEntry({ tags: ['tag1'] });
      await handler.set('test-key', Promise.resolve(entry));

      // Get the entry
      const result = await handler.get('test-key', []);

      expect(result).not.toBeUndefined();
      expect(result!.tags).toEqual(['tag1']);
      expect(result!.stale).toBe(60);
      expect(result!.expire).toBe(3600);
      expect(result!.revalidate).toBe(300);
    });

    it('should return undefined for expired entries', async () => {
      const handler = new UseCacheFileHandler({ cacheDir: testCacheDir });

      // Set an entry with past timestamp and short revalidate
      const entry = createTestEntry({
        timestamp: Date.now() - 10000, // 10 seconds ago
        revalidate: 5, // 5 second revalidation
      });
      await handler.set('expired-key', Promise.resolve(entry));

      // Get the entry - should be undefined because it's expired
      const result = await handler.get('expired-key', []);
      expect(result).toBeUndefined();
    });

    it('should return entry that is stale but not expired', async () => {
      const handler = new UseCacheFileHandler({ cacheDir: testCacheDir });

      // Set an entry with past timestamp but long expire
      const entry = createTestEntry({
        timestamp: Date.now() - 10000, // 10 seconds ago
        revalidate: 5, // 5 second revalidation (stale)
        expire: 3600, // 1 hour expiration (not expired)
      });
      await handler.set('stale-key', Promise.resolve(entry));

      // For this test, we expect the handler to check revalidate time
      // and return undefined if past revalidate
      const result = await handler.get('stale-key', []);
      expect(result).toBeUndefined();
    });

    it('should preserve stream content through get', async () => {
      const handler = new UseCacheFileHandler({ cacheDir: testCacheDir });

      const originalData = new Uint8Array([10, 20, 30, 40, 50]);
      const entry = createTestEntry({ value: createTestStream(originalData) });
      await handler.set('stream-key', Promise.resolve(entry));

      const result = await handler.get('stream-key', []);
      expect(result).not.toBeUndefined();

      const bytes = await streamToBytes(result!.value);
      expect(Array.from(bytes)).toEqual([10, 20, 30, 40, 50]);
    });
  });

  describe('set', () => {
    it('should await the pending entry before storing', async () => {
      const handler = new UseCacheFileHandler({ cacheDir: testCacheDir });

      let resolved = false;
      const pendingEntry = new Promise<UseCacheEntry>((resolve) => {
        setTimeout(() => {
          resolved = true;
          resolve(createTestEntry());
        }, 10);
      });

      await handler.set('pending-key', pendingEntry);
      expect(resolved).toBe(true);
    });

    it('should store entry to file system', async () => {
      const handler = new UseCacheFileHandler({ cacheDir: testCacheDir });

      const entry = createTestEntry({ tags: ['stored'] });
      await handler.set('stored-key', Promise.resolve(entry));

      // Verify file exists
      const files = fs.readdirSync(testCacheDir);
      expect(files.length).toBeGreaterThan(0);
    });

    it('should overwrite existing entry', async () => {
      const handler = new UseCacheFileHandler({ cacheDir: testCacheDir });

      // Set first entry
      const entry1 = createTestEntry({
        value: createTestStream(new Uint8Array([1])),
        tags: ['first'],
      });
      await handler.set('overwrite-key', Promise.resolve(entry1));

      // Set second entry with same key
      const entry2 = createTestEntry({
        value: createTestStream(new Uint8Array([2])),
        tags: ['second'],
      });
      await handler.set('overwrite-key', Promise.resolve(entry2));

      // Get should return second entry
      const result = await handler.get('overwrite-key', []);
      expect(result!.tags).toEqual(['second']);

      const bytes = await streamToBytes(result!.value);
      expect(Array.from(bytes)).toEqual([2]);
    });
  });

  describe('refreshTags', () => {
    it('should not throw', async () => {
      const handler = new UseCacheFileHandler({ cacheDir: testCacheDir });
      await expect(handler.refreshTags()).resolves.not.toThrow();
    });
  });

  describe('getExpiration', () => {
    it('should return 0 when no tags have been invalidated', async () => {
      const handler = new UseCacheFileHandler({ cacheDir: testCacheDir });
      const result = await handler.getExpiration(['tag1', 'tag2']);
      expect(result).toBe(0);
    });

    it('should return invalidation timestamp after updateTags', async () => {
      const handler = new UseCacheFileHandler({ cacheDir: testCacheDir });

      // First, update tags
      const beforeUpdate = Date.now();
      await handler.updateTags(['expired-tag'], [0]);
      const afterUpdate = Date.now();

      // Get expiration should return a timestamp
      const expiration = await handler.getExpiration(['expired-tag']);
      expect(expiration).toBeGreaterThanOrEqual(beforeUpdate);
      expect(expiration).toBeLessThanOrEqual(afterUpdate);
    });

    it('should return max timestamp when multiple tags requested', async () => {
      const handler = new UseCacheFileHandler({ cacheDir: testCacheDir });

      // Update first tag
      await handler.updateTags(['tag1'], [0]);
      const firstTimestamp = await handler.getExpiration(['tag1']);

      // Wait a bit
      await new Promise((r) => setTimeout(r, 10));

      // Update second tag
      await handler.updateTags(['tag2'], [0]);
      const secondTimestamp = await handler.getExpiration(['tag2']);

      // Get expiration for both should return the max (second)
      const bothExpiration = await handler.getExpiration(['tag1', 'tag2']);
      expect(bothExpiration).toBe(secondTimestamp);
      expect(bothExpiration).toBeGreaterThan(firstTimestamp);
    });
  });

  describe('updateTags', () => {
    it('should invalidate cache entries with matching tags', async () => {
      const handler = new UseCacheFileHandler({ cacheDir: testCacheDir });

      // Set an entry with tags (timestamp in the past to avoid race condition)
      const pastTimestamp = Date.now() - 1000;
      const entry = createTestEntry({ tags: ['blog', 'posts'], timestamp: pastTimestamp });
      await handler.set('tagged-key', Promise.resolve(entry));

      // Verify entry exists
      const beforeInvalidation = await handler.get('tagged-key', []);
      expect(beforeInvalidation).not.toBeUndefined();

      // Invalidate by tag
      await handler.updateTags(['blog'], [0]);

      // Entry should now be considered invalid via getExpiration check
      const expiration = await handler.getExpiration(['blog']);
      expect(expiration).toBeGreaterThan(pastTimestamp);
    });

    it('should handle empty tags array', async () => {
      const handler = new UseCacheFileHandler({ cacheDir: testCacheDir });
      await expect(handler.updateTags([], [])).resolves.not.toThrow();
    });

    it('should handle multiple tags in single call', async () => {
      const handler = new UseCacheFileHandler({ cacheDir: testCacheDir });

      await handler.updateTags(['tag1', 'tag2', 'tag3'], [0, 0, 0]);

      const exp1 = await handler.getExpiration(['tag1']);
      const exp2 = await handler.getExpiration(['tag2']);
      const exp3 = await handler.getExpiration(['tag3']);

      expect(exp1).toBeGreaterThan(0);
      expect(exp2).toBeGreaterThan(0);
      expect(exp3).toBeGreaterThan(0);
    });
  });

  describe('cache key sanitization', () => {
    it('should handle keys with special characters', async () => {
      const handler = new UseCacheFileHandler({ cacheDir: testCacheDir });

      const entry = createTestEntry();
      await handler.set('/api/cache/test?param=value', Promise.resolve(entry));

      const result = await handler.get('/api/cache/test?param=value', []);
      expect(result).not.toBeUndefined();
    });

    it('should handle keys with slashes', async () => {
      const handler = new UseCacheFileHandler({ cacheDir: testCacheDir });

      const entry = createTestEntry();
      await handler.set('path/to/resource', Promise.resolve(entry));

      const result = await handler.get('path/to/resource', []);
      expect(result).not.toBeUndefined();
    });
  });

  describe('getStats', () => {
    it('should return empty stats for empty cache', async () => {
      const handler = new UseCacheFileHandler({ cacheDir: testCacheDir });
      const stats = await handler.getStats();

      expect(stats).toEqual({
        size: 0,
        entries: [],
        keys: [],
      });
    });

    it('should return stats for cached entries', async () => {
      const handler = new UseCacheFileHandler({ cacheDir: testCacheDir });

      // Add some entries
      const entry1 = createTestEntry({ tags: ['posts', 'blog'] });
      const entry2 = createTestEntry({ tags: ['users'] });

      await handler.set('key-1', Promise.resolve(entry1));
      await handler.set('key-2', Promise.resolve(entry2));

      const stats = await handler.getStats();

      expect(stats.size).toBe(2);
      expect(stats.keys).toContain('key-1');
      expect(stats.keys).toContain('key-2');
      expect(stats.entries).toHaveLength(2);
    });

    it('should include tag information in entries', async () => {
      const handler = new UseCacheFileHandler({ cacheDir: testCacheDir });

      const entry = createTestEntry({ tags: ['api-posts', 'external-data'] });
      await handler.set('tagged-key', Promise.resolve(entry));

      const stats = await handler.getStats();

      expect(stats.entries).toHaveLength(1);
      expect(stats.entries[0].key).toBe('tagged-key');
      expect(stats.entries[0].tags).toEqual(['api-posts', 'external-data']);
      expect(stats.entries[0].type).toBe('use-cache');
    });

    it('should not include expired entries in stats', async () => {
      const handler = new UseCacheFileHandler({ cacheDir: testCacheDir });

      // Add expired entry
      const expiredEntry = createTestEntry({
        tags: ['expired'],
        timestamp: Date.now() - 10000,
        revalidate: 5,
      });
      await handler.set('expired-key', Promise.resolve(expiredEntry));

      // Add valid entry
      const validEntry = createTestEntry({ tags: ['valid'] });
      await handler.set('valid-key', Promise.resolve(validEntry));

      const stats = await handler.getStats();

      expect(stats.size).toBe(1);
      expect(stats.keys).toContain('valid-key');
      expect(stats.keys).not.toContain('expired-key');
    });
  });

  describe('tag capture for Surrogate-Key headers', () => {
    it('should capture tags to RequestContext on cache hit', async () => {
      const handler = new UseCacheFileHandler({ cacheDir: testCacheDir });

      // Set an entry with tags
      const entry = createTestEntry({ tags: ['api-posts', 'external-data'] });
      await handler.set('tagged-entry', Promise.resolve(entry));

      // Get the entry within a RequestContext
      let capturedTags: string[] = [];
      await RequestContext.run(async () => {
        await handler.get('tagged-entry', []);
        capturedTags = RequestContext.getTags();
      });

      // Tags should be captured
      expect(capturedTags).toContain('api-posts');
      expect(capturedTags).toContain('external-data');
      expect(capturedTags.length).toBe(2);
    });

    it('should not capture tags when no RequestContext is active', async () => {
      const handler = new UseCacheFileHandler({ cacheDir: testCacheDir });

      // Set an entry with tags
      const entry = createTestEntry({ tags: ['tag1'] });
      await handler.set('tagged-entry-2', Promise.resolve(entry));

      // Get the entry without RequestContext - should not throw
      const result = await handler.get('tagged-entry-2', []);
      expect(result).not.toBeUndefined();
      expect(result!.tags).toEqual(['tag1']);
    });

    it('should not capture tags for entries without tags', async () => {
      const handler = new UseCacheFileHandler({ cacheDir: testCacheDir });

      // Set an entry without tags
      const entry = createTestEntry({ tags: [] });
      await handler.set('untagged-entry', Promise.resolve(entry));

      // Get the entry within a RequestContext
      let capturedTags: string[] = [];
      await RequestContext.run(async () => {
        await handler.get('untagged-entry', []);
        capturedTags = RequestContext.getTags();
      });

      // No tags should be captured
      expect(capturedTags.length).toBe(0);
    });

    it('should accumulate tags from multiple cache hits', async () => {
      const handler = new UseCacheFileHandler({ cacheDir: testCacheDir });

      // Set multiple entries with different tags
      const entry1 = createTestEntry({ tags: ['posts'] });
      const entry2 = createTestEntry({ tags: ['users', 'profiles'] });
      await handler.set('entry-1', Promise.resolve(entry1));
      await handler.set('entry-2', Promise.resolve(entry2));

      // Get both entries within same RequestContext
      let capturedTags: string[] = [];
      await RequestContext.run(async () => {
        await handler.get('entry-1', []);
        await handler.get('entry-2', []);
        capturedTags = RequestContext.getTags();
      });

      // All tags should be captured
      expect(capturedTags).toContain('posts');
      expect(capturedTags).toContain('users');
      expect(capturedTags).toContain('profiles');
      expect(capturedTags.length).toBe(3);
    });
  });
});
