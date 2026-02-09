import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { UseCacheEntry } from '../../src/use-cache/types.js';

// Mock file and bucket stored for access
const mockFile = {
  exists: vi.fn(),
  download: vi.fn(),
  save: vi.fn(),
  delete: vi.fn(),
};

const mockBucket = {
  file: vi.fn(() => mockFile),
  getFiles: vi.fn(),
};

// Mock must be defined with factory - hoisted to top
vi.mock('@google-cloud/storage', () => {
  return {
    Storage: function Storage() {
      return {
        bucket: () => mockBucket,
      };
    },
    Bucket: vi.fn(),
  };
});

// Import after mock is set up
import { UseCacheGcsHandler } from '../../src/use-cache/gcs-handler.js';
import { streamToBytes } from '../../src/use-cache/stream-serialization.js';

// Mock fetch for edge cache
vi.stubGlobal('fetch', vi.fn());

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

describe('UseCacheGcsHandler', () => {
  let originalCacheBucket: string | undefined;
  let originalProxyEndpoint: string | undefined;

  beforeEach(() => {
    originalCacheBucket = process.env.CACHE_BUCKET;
    originalProxyEndpoint = process.env.OUTBOUND_PROXY_ENDPOINT;

    process.env.CACHE_BUCKET = 'test-bucket';
    delete process.env.OUTBOUND_PROXY_ENDPOINT;

    vi.clearAllMocks();

    // Reset mock implementations
    mockFile.exists.mockResolvedValue([false]);
    mockFile.save.mockResolvedValue(undefined);
    mockFile.download.mockResolvedValue([Buffer.from('{}')]);
    mockFile.delete.mockResolvedValue(undefined);
    mockBucket.getFiles.mockResolvedValue([[]]);
    mockBucket.file.mockReturnValue(mockFile);
  });

  afterEach(() => {
    if (originalCacheBucket !== undefined) {
      process.env.CACHE_BUCKET = originalCacheBucket;
    } else {
      delete process.env.CACHE_BUCKET;
    }

    if (originalProxyEndpoint !== undefined) {
      process.env.OUTBOUND_PROXY_ENDPOINT = originalProxyEndpoint;
    } else {
      delete process.env.OUTBOUND_PROXY_ENDPOINT;
    }
  });

  describe('constructor', () => {
    it('should throw if CACHE_BUCKET is not set', () => {
      delete process.env.CACHE_BUCKET;
      expect(() => new UseCacheGcsHandler()).toThrow('CACHE_BUCKET environment variable is required');
    });

    it('should create handler when CACHE_BUCKET is set', () => {
      process.env.CACHE_BUCKET = 'my-bucket';
      const handler = new UseCacheGcsHandler();
      expect(handler).toBeInstanceOf(UseCacheGcsHandler);
    });

    it('should initialize tags file', async () => {
      mockFile.exists.mockResolvedValue([false]);

      new UseCacheGcsHandler();

      // Wait for async initialization
      await new Promise((r) => setTimeout(r, 10));

      expect(mockBucket.file).toHaveBeenCalledWith('use-cache/_tags.json');
    });
  });

  describe('get', () => {
    it('should return undefined for non-existent cache entry', async () => {
      mockFile.exists.mockResolvedValue([false]);

      const handler = new UseCacheGcsHandler();
      const result = await handler.get('non-existent-key', []);

      expect(result).toBeUndefined();
    });

    it('should return cached entry when it exists', async () => {
      const storedData = {
        value: Buffer.from([1, 2, 3]).toString('base64'),
        tags: ['tag1'],
        stale: 60,
        timestamp: Date.now(),
        expire: 3600,
        revalidate: 300,
      };

      mockFile.exists.mockResolvedValue([true]);
      mockFile.download.mockResolvedValue([Buffer.from(JSON.stringify(storedData))]);

      const handler = new UseCacheGcsHandler();
      const result = await handler.get('test-key', []);

      expect(result).not.toBeUndefined();
      expect(result?.tags).toEqual(['tag1']);
      expect(result?.stale).toBe(60);
    });

    it('should use use-cache prefix for entries', async () => {
      mockFile.exists.mockResolvedValue([false]);

      const handler = new UseCacheGcsHandler();
      await handler.get('key', []);

      expect(mockBucket.file).toHaveBeenCalledWith('use-cache/key.json');
    });

    it('should return undefined for expired entries', async () => {
      const storedData = {
        value: Buffer.from([1, 2, 3]).toString('base64'),
        tags: [],
        stale: 60,
        timestamp: Date.now() - 10000, // 10 seconds ago
        expire: 3600,
        revalidate: 5, // 5 second revalidation (expired)
      };

      mockFile.exists.mockResolvedValue([true]);
      mockFile.download.mockResolvedValue([Buffer.from(JSON.stringify(storedData))]);

      const handler = new UseCacheGcsHandler();
      const result = await handler.get('expired-key', []);

      expect(result).toBeUndefined();
    });

    it('should preserve stream content through get', async () => {
      const originalData = new Uint8Array([10, 20, 30, 40, 50]);
      const storedData = {
        value: Buffer.from(originalData).toString('base64'),
        tags: [],
        stale: 60,
        timestamp: Date.now(),
        expire: 3600,
        revalidate: 300,
      };

      mockFile.exists.mockResolvedValue([true]);
      mockFile.download.mockResolvedValue([Buffer.from(JSON.stringify(storedData))]);

      const handler = new UseCacheGcsHandler();
      const result = await handler.get('stream-key', []);

      expect(result).not.toBeUndefined();

      const bytes = await streamToBytes(result!.value);
      expect(Array.from(bytes)).toEqual([10, 20, 30, 40, 50]);
    });
  });

  describe('set', () => {
    it('should await the pending entry before storing', async () => {
      mockFile.exists.mockResolvedValue([true]);
      mockFile.download.mockResolvedValue([Buffer.from('{}')]);

      const handler = new UseCacheGcsHandler();

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

    it('should save cache entry to GCS', async () => {
      mockFile.exists.mockResolvedValue([true]);
      mockFile.download.mockResolvedValue([Buffer.from('{}')]);

      const handler = new UseCacheGcsHandler();

      const entry = createTestEntry({ tags: ['stored'] });
      await handler.set('stored-key', Promise.resolve(entry));

      expect(mockFile.save).toHaveBeenCalled();
      const savedData = JSON.parse(mockFile.save.mock.calls[0][0]);
      expect(savedData.tags).toEqual(['stored']);
    });

    it('should use use-cache prefix', async () => {
      mockFile.exists.mockResolvedValue([true]);
      mockFile.download.mockResolvedValue([Buffer.from('{}')]);

      const handler = new UseCacheGcsHandler();

      const entry = createTestEntry();
      await handler.set('my-key', Promise.resolve(entry));

      expect(mockBucket.file).toHaveBeenCalledWith('use-cache/my-key.json');
    });

    it('should store stream as base64', async () => {
      mockFile.exists.mockResolvedValue([true]);
      mockFile.download.mockResolvedValue([Buffer.from('{}')]);

      const handler = new UseCacheGcsHandler();

      const data = new Uint8Array([1, 2, 3, 4, 5]);
      const entry = createTestEntry({ value: createTestStream(data) });
      await handler.set('stream-key', Promise.resolve(entry));

      expect(mockFile.save).toHaveBeenCalled();
      const savedData = JSON.parse(mockFile.save.mock.calls[0][0]);
      expect(typeof savedData.value).toBe('string');
      expect(Buffer.from(savedData.value, 'base64')).toEqual(Buffer.from(data));
    });
  });

  describe('refreshTags', () => {
    it('should not throw', async () => {
      mockFile.exists.mockResolvedValue([true]);
      mockFile.download.mockResolvedValue([Buffer.from('{}')]);

      const handler = new UseCacheGcsHandler();
      await expect(handler.refreshTags()).resolves.not.toThrow();
    });

    it('should reload tag timestamps from GCS', async () => {
      const tagsData = { 'tag1': 1234567890 };
      mockFile.exists.mockResolvedValue([true]);
      mockFile.download.mockResolvedValue([Buffer.from(JSON.stringify(tagsData))]);

      const handler = new UseCacheGcsHandler();
      await handler.refreshTags();

      const expiration = await handler.getExpiration(['tag1']);
      expect(expiration).toBe(1234567890);
    });
  });

  describe('getExpiration', () => {
    it('should return 0 when no tags have been invalidated', async () => {
      mockFile.exists.mockResolvedValue([false]);

      const handler = new UseCacheGcsHandler();
      const result = await handler.getExpiration(['tag1', 'tag2']);
      expect(result).toBe(0);
    });

    it('should return invalidation timestamp after updateTags', async () => {
      mockFile.exists.mockResolvedValue([true]);
      mockFile.download.mockResolvedValue([Buffer.from('{}')]);

      const handler = new UseCacheGcsHandler();

      const beforeUpdate = Date.now();
      await handler.updateTags(['expired-tag'], [0]);
      const afterUpdate = Date.now();

      const expiration = await handler.getExpiration(['expired-tag']);
      expect(expiration).toBeGreaterThanOrEqual(beforeUpdate);
      expect(expiration).toBeLessThanOrEqual(afterUpdate);
    });

    it('should return max timestamp when multiple tags requested', async () => {
      mockFile.exists.mockResolvedValue([true]);
      mockFile.download.mockResolvedValue([Buffer.from('{}')]);

      const handler = new UseCacheGcsHandler();

      await handler.updateTags(['tag1'], [0]);
      const firstTimestamp = await handler.getExpiration(['tag1']);

      await new Promise((r) => setTimeout(r, 10));

      await handler.updateTags(['tag2'], [0]);
      const secondTimestamp = await handler.getExpiration(['tag2']);

      const bothExpiration = await handler.getExpiration(['tag1', 'tag2']);
      expect(bothExpiration).toBe(secondTimestamp);
      expect(bothExpiration).toBeGreaterThan(firstTimestamp);
    });
  });

  describe('updateTags', () => {
    it('should save tag timestamps to GCS', async () => {
      mockFile.exists.mockResolvedValue([true]);
      mockFile.download.mockResolvedValue([Buffer.from('{}')]);

      const handler = new UseCacheGcsHandler();

      await handler.updateTags(['blog'], [0]);

      // Verify save was called with tag timestamps
      expect(mockFile.save).toHaveBeenCalled();
      const savedData = JSON.parse(mockFile.save.mock.calls[0][0]);
      expect(savedData).toHaveProperty('blog');
      expect(typeof savedData.blog).toBe('number');
    });

    it('should handle empty tags array', async () => {
      mockFile.exists.mockResolvedValue([true]);
      mockFile.download.mockResolvedValue([Buffer.from('{}')]);

      const handler = new UseCacheGcsHandler();
      await expect(handler.updateTags([], [])).resolves.not.toThrow();
    });

    it('should handle multiple tags in single call', async () => {
      mockFile.exists.mockResolvedValue([true]);
      mockFile.download.mockResolvedValue([Buffer.from('{}')]);

      const handler = new UseCacheGcsHandler();

      await handler.updateTags(['tag1', 'tag2', 'tag3'], [0, 0, 0]);

      const exp1 = await handler.getExpiration(['tag1']);
      const exp2 = await handler.getExpiration(['tag2']);
      const exp3 = await handler.getExpiration(['tag3']);

      expect(exp1).toBeGreaterThan(0);
      expect(exp2).toBeGreaterThan(0);
      expect(exp3).toBeGreaterThan(0);
    });

    it('should clear edge cache when configured', async () => {
      process.env.OUTBOUND_PROXY_ENDPOINT = 'proxy.example.com:8080';

      mockFile.exists.mockResolvedValue([true]);
      mockFile.download.mockResolvedValue([Buffer.from('{}')]);
      vi.mocked(fetch).mockResolvedValue({ ok: true, status: 200 } as Response);

      const handler = new UseCacheGcsHandler();
      await handler.updateTags(['posts'], [0]);

      // Wait for background edge cache clear
      await new Promise((r) => setTimeout(r, 50));

      expect(fetch).toHaveBeenCalled();
    });
  });

  describe('cache key sanitization', () => {
    it('should handle keys with special characters', async () => {
      mockFile.exists.mockResolvedValue([false]);

      const handler = new UseCacheGcsHandler();
      await handler.get('/api/cache/test?param=value', []);

      // Key should be sanitized
      expect(mockBucket.file).toHaveBeenCalledWith('use-cache/_api_cache_test_param_value.json');
    });
  });
});
