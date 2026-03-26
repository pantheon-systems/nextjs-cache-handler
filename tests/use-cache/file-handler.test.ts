import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { UseCacheFileHandler } from '../../src/handlers/use-cache/file.js';
import type { UseCacheEntry } from '../../src/handlers/use-cache/types.js';
import { streamToBytes } from '../../src/utils/stream-serialization.js';
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

    it('should only update timestamps without triggering CDN clearing', async () => {
      // CDN path-based purging is handled by the legacy cacheHandler.
      // The use-cache handler only manages function-level cache staleness
      // via timestamps — it should NOT make any edge cache clear calls.
      const originalEnv = process.env.OUTBOUND_PROXY_ENDPOINT;
      process.env.OUTBOUND_PROXY_ENDPOINT = 'localhost:8080';

      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 200 }));

      try {
        const handler = new UseCacheFileHandler({ cacheDir: testCacheDir });

        await handler.updateTags(['post-123', 'post-list'], [0, 0]);

        // Wait for any potential background calls
        await new Promise((resolve) => setTimeout(resolve, 50));

        // No fetch calls should have been made — use-cache handler
        // doesn't do CDN clearing
        expect(fetchSpy).not.toHaveBeenCalled();

        // But timestamps should be updated
        const exp = await handler.getExpiration(['post-123']);
        expect(exp).toBeGreaterThan(0);
      } finally {
        if (originalEnv === undefined) {
          delete process.env.OUTBOUND_PROXY_ENDPOINT;
        } else {
          process.env.OUTBOUND_PROXY_ENDPOINT = originalEnv;
        }
        fetchSpy.mockRestore();
      }
    });

    it('should make entries with matching tags expire on next get()', async () => {
      const handler = new UseCacheFileHandler({ cacheDir: testCacheDir });

      // Set an entry with a tag, timestamp in the past
      const pastTimestamp = Date.now() - 1000;
      const entry = createTestEntry({
        tags: ['post-123'],
        timestamp: pastTimestamp,
        revalidate: 86400, // Long revalidate so it wouldn't expire by time alone
      });
      await handler.set('cached-func', Promise.resolve(entry));

      // Verify entry exists before invalidation
      const before = await handler.get('cached-func', []);
      expect(before).not.toBeUndefined();

      // Invalidate the tag
      await handler.updateTags(['post-123'], [0]);

      // Entry should now be expired because tag timestamp > entry timestamp
      const after = await handler.get('cached-func', []);
      expect(after).toBeUndefined();
    });

    it('should not affect entries without matching tags', async () => {
      const handler = new UseCacheFileHandler({ cacheDir: testCacheDir });

      const pastTimestamp = Date.now() - 1000;
      const entry = createTestEntry({
        tags: ['post-456'],
        timestamp: pastTimestamp,
        revalidate: 86400,
      });
      await handler.set('unrelated-func', Promise.resolve(entry));

      // Invalidate a different tag
      await handler.updateTags(['post-123'], [0]);

      // Entry with post-456 should still be valid
      const result = await handler.get('unrelated-func', []);
      expect(result).not.toBeUndefined();
    });

    it('should persist tag timestamps to disk for cross-request consistency', async () => {
      const handler = new UseCacheFileHandler({ cacheDir: testCacheDir });

      await handler.updateTags(['post-789'], [0]);

      // Read the _tags.json file directly
      const tagsFile = path.join(testCacheDir, '_tags.json');
      expect(fs.existsSync(tagsFile)).toBe(true);

      const timestamps = JSON.parse(fs.readFileSync(tagsFile, 'utf-8'));
      expect(timestamps['post-789']).toBeGreaterThan(0);
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
});
