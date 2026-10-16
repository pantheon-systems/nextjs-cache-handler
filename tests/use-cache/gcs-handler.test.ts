import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { tagsManifest } from 'next/dist/server/lib/incremental-cache/tags-manifest.external.js';
import { setTagRevalidation } from '../../src/utils/tags-manifest.js';
import { hasStaleTags } from '../helpers/next-version.js';
import type { UseCacheEntry } from '../../src/handlers/use-cache/types.js';

// Mock file and bucket stored for access
const mockFile = {
  exists: vi.fn(),
  download: vi.fn(),
  getMetadata: vi.fn(),
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
    RETRYABLE_ERR_FN_DEFAULT: () => true,
  };
});

// Import after mock is set up
import { UseCacheGcsHandler, resolveUseCacheMemoryBytes } from '../../src/handlers/use-cache/gcs.js';
import { createUseCacheHandler } from '../../src/index.js';
import { streamToBytes } from '../../src/utils/stream-serialization.js';

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
    mockFile.getMetadata.mockResolvedValue([{ generation: '1' }]);
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
      // calls[0] is checkBuildInvalidation()'s own build-meta write (init is
      // awaited via ensureInitialized() before set() proceeds); calls[1] is
      // the actual cache entry write under test.
      const savedData = JSON.parse(mockFile.save.mock.calls[1][0]);
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
      // calls[0] is checkBuildInvalidation()'s own build-meta write; see the
      // matching comment in the "should save cache entry to GCS" test above.
      const savedData = JSON.parse(mockFile.save.mock.calls[1][0]);
      expect(typeof savedData.value).toBe('string');
      expect(Buffer.from(savedData.value, 'base64')).toEqual(Buffer.from(data));
    });
  });

  describe('memory', () => {
    const storedJson = (overrides: Record<string, unknown> = {}) =>
      JSON.stringify({
        value: Buffer.from([7, 8, 9]).toString('base64'),
        tags: ['tag1'],
        stale: 60,
        timestamp: Date.now() - 1000,
        expire: 3600,
        revalidate: 300,
        ...overrides,
      });

    it('serves a repeated hit from memory without reading GCS', async () => {
      mockFile.exists.mockResolvedValue([true]);
      mockFile.download.mockResolvedValue([Buffer.from(storedJson())]);
      const handler = new UseCacheGcsHandler();
      await handler.get('k', []);

      mockFile.exists.mockRejectedValue(new Error('GCS must not be read'));
      const result = await handler.get('k', []);

      expect(Array.from(await streamToBytes(result!.value))).toEqual([7, 8, 9]);
    });

    it('resolves a memory hit within the same task', async () => {
      mockFile.exists.mockResolvedValue([true]);
      mockFile.download.mockResolvedValue([Buffer.from(storedJson())]);
      const handler = new UseCacheGcsHandler();
      await handler.get('k', []);
      // A real GCS read takes at least a task.
      mockFile.exists.mockImplementation(() => new Promise((r) => setTimeout(() => r([true]), 0)));

      let result: UseCacheEntry | undefined;
      void handler.get('k', []).then((entry) => (result = entry));
      // Microtasks only: Next's cached-navigations render ends the static stage after one task.
      for (let i = 0; i < 10; i++) {
        await Promise.resolve();
      }

      expect(result).toBeDefined();
    });

    it('serves its own set() from memory', async () => {
      const handler = new UseCacheGcsHandler();
      await handler.set('own', Promise.resolve(createTestEntry({ value: createTestStream(new Uint8Array([4, 5])) })));

      mockFile.exists.mockResolvedValue([false]);
      const result = await handler.get('own', []);

      expect(Array.from(await streamToBytes(result!.value))).toEqual([4, 5]);
    });

    describe('revalidations the route cache handler learned from other instances', () => {
      afterEach(() => tagsManifest.clear());

      it('stops serving a memory hit for a tag in tagsManifest, before any reload', async () => {
        mockFile.exists.mockResolvedValue([true]);
        mockFile.download.mockResolvedValue([Buffer.from(storedJson())]);
        const handler = new UseCacheGcsHandler();
        await handler.get('k', []);

        setTagRevalidation('tag1', { expired: Date.now() });
        mockFile.exists.mockResolvedValue([false]);

        expect(await handler.get('k', [])).toBeUndefined();
      });

      it.skipIf(!hasStaleTags)(
        'reports the revalidation from getExpiration, using the moment of a soft one',
        async () => {
          const handler = new UseCacheGcsHandler();
          const at = Date.now() - 500;
          setTagRevalidation('soft', { stale: at, expired: Date.now() + 60_000 });

          expect(await handler.getExpiration(['soft'])).toBe(at);
        }
      );

      it('ignores a revalidation older than the entry', async () => {
        mockFile.exists.mockResolvedValue([true]);
        mockFile.download.mockResolvedValue([Buffer.from(storedJson())]);
        const handler = new UseCacheGcsHandler();
        setTagRevalidation('tag1', { expired: Date.now() - 10_000 });

        expect(await handler.get('k', [])).toBeDefined();
      });
    });

    it('stops serving its own set() from memory when the GCS save fails', async () => {
      const handler = new UseCacheGcsHandler();
      // Another save (the tag timestamps) may run first, so fail only the entry's.
      mockFile.save.mockImplementation(async (json: string) => {
        if (JSON.parse(json).value !== undefined) {
          throw new Error('save failed');
        }
      });
      await handler.set('own', Promise.resolve(createTestEntry({ value: createTestStream(new Uint8Array([4, 5])) })));

      mockFile.exists.mockResolvedValue([false]);

      expect(await handler.get('own', [])).toBeUndefined();
    });

    it('stops serving an entry from memory once one of its tags is invalidated', async () => {
      mockFile.exists.mockResolvedValue([true]);
      mockFile.download.mockResolvedValue([Buffer.from(storedJson())]);
      const handler = new UseCacheGcsHandler();
      await handler.get('k', []);

      await handler.updateTags(['tag1'], []);
      mockFile.exists.mockResolvedValue([false]);

      expect(await handler.get('k', [])).toBeUndefined();
    });

    it('stops serving an entry from memory once it is past its revalidate time', async () => {
      const handler = new UseCacheGcsHandler();
      await handler.set('old', Promise.resolve(createTestEntry({ timestamp: Date.now() - 10_000, revalidate: 5 })));

      mockFile.exists.mockResolvedValue([false]);

      expect(await handler.get('old', [])).toBeUndefined();
    });

    it('evicts the least recently used entry past CACHE_USE_CACHE_MEMORY_MB', async () => {
      // About two stored entries' worth (each ~150 bytes of JSON).
      process.env.CACHE_USE_CACHE_MEMORY_MB = String(330 / 1024 / 1024);
      try {
        const handler = new UseCacheGcsHandler();
        await handler.set('a', Promise.resolve(createTestEntry()));
        await handler.set('b', Promise.resolve(createTestEntry()));
        mockFile.exists.mockResolvedValue([false]);
        expect(await handler.get('a', [])).toBeDefined(); // a is now the most recent
        await handler.set('c', Promise.resolve(createTestEntry()));

        expect(await handler.get('b', [])).toBeUndefined();
        expect(await handler.get('a', [])).toBeDefined();
        expect(await handler.get('c', [])).toBeDefined();
      } finally {
        delete process.env.CACHE_USE_CACHE_MEMORY_MB;
      }
    });

    it('keeps nothing in memory with CACHE_USE_CACHE_MEMORY_MB=0', async () => {
      process.env.CACHE_USE_CACHE_MEMORY_MB = '0';
      try {
        const handler = new UseCacheGcsHandler();
        await handler.set('k', Promise.resolve(createTestEntry()));
        mockFile.exists.mockResolvedValue([false]);

        expect(await handler.get('k', [])).toBeUndefined();
      } finally {
        delete process.env.CACHE_USE_CACHE_MEMORY_MB;
      }
    });

    it('memoryMb overrides CACHE_USE_CACHE_MEMORY_MB', async () => {
      process.env.CACHE_USE_CACHE_MEMORY_MB = '8';
      try {
        const handler = new UseCacheGcsHandler({ memoryMb: 0 });
        await handler.set('k', Promise.resolve(createTestEntry()));
        mockFile.exists.mockResolvedValue([false]);

        expect(await handler.get('k', [])).toBeUndefined();
      } finally {
        delete process.env.CACHE_USE_CACHE_MEMORY_MB;
      }
    });

    it('createUseCacheHandler binds memoryMb into a no-argument constructor', async () => {
      process.env.CACHE_USE_CACHE_MEMORY_MB = '8';
      try {
        const Handler = createUseCacheHandler({ type: 'gcs', memoryMb: 0 });
        const handler = new Handler();
        await handler.set('k', Promise.resolve(createTestEntry()));
        mockFile.exists.mockResolvedValue([false]);

        expect(handler).toBeInstanceOf(UseCacheGcsHandler);
        expect(await handler.get('k', [])).toBeUndefined();
      } finally {
        delete process.env.CACHE_USE_CACHE_MEMORY_MB;
      }
    });

    it('reads CACHE_USE_CACHE_MEMORY_MB', () => {
      expect(resolveUseCacheMemoryBytes(undefined)).toBe(32 * 1024 * 1024);
      expect(resolveUseCacheMemoryBytes('8')).toBe(8 * 1024 * 1024);
      expect(resolveUseCacheMemoryBytes('0')).toBe(0);
      expect(resolveUseCacheMemoryBytes('nope')).toBe(32 * 1024 * 1024);
      expect(resolveUseCacheMemoryBytes('-1')).toBe(32 * 1024 * 1024);
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
      const tagsData = { tag1: 1234567890 };
      mockFile.exists.mockResolvedValue([true]);
      mockFile.download.mockResolvedValue([Buffer.from(JSON.stringify(tagsData))]);

      const handler = new UseCacheGcsHandler();
      await handler.refreshTags();
      await new Promise((r) => setTimeout(r, 20)); // the reload runs in the background

      const expiration = await handler.getExpiration(['tag1']);
      expect(expiration).toBe(1234567890);
    });

    it('returns without waiting for GCS, so a cached read stays in the static stage', async () => {
      const handler = new UseCacheGcsHandler();
      await handler.get('warm-up', []); // initialization
      mockFile.exists.mockImplementation(() => new Promise(() => {})); // GCS never answers

      let done = false;
      void handler.refreshTags().then(() => (done = true));
      for (let i = 0; i < 10; i++) {
        await Promise.resolve();
      }

      expect(done).toBe(true);
    });

    it('picks up a tag another instance revalidated on the next reload', async () => {
      mockFile.exists.mockResolvedValue([true]);
      mockFile.download.mockResolvedValue([
        Buffer.from(
          JSON.stringify({
            value: '',
            tags: ['tag1'],
            stale: 60,
            timestamp: Date.now() - 1000,
            expire: 3600,
            revalidate: 300,
          })
        ),
      ]);
      const handler = new UseCacheGcsHandler();
      expect(await handler.get('k', [])).toBeDefined(); // now in memory

      mockFile.download.mockResolvedValue([Buffer.from(JSON.stringify({ tag1: Date.now() }))]);
      await new Promise((r) => setTimeout(r, 150)); // past the 100 ms test refresh interval
      await handler.refreshTags();
      await new Promise((r) => setTimeout(r, 20));
      mockFile.exists.mockResolvedValue([false]);

      expect(await handler.get('k', [])).toBeUndefined();
    });

    it('reloads at most once per refresh interval', async () => {
      mockFile.exists.mockResolvedValue([true]);
      mockFile.download.mockResolvedValue([Buffer.from('{}')]);
      const handler = new UseCacheGcsHandler();
      await handler.get('warm-up', []);
      mockFile.download.mockClear();

      await handler.refreshTags();
      await handler.refreshTags();
      await handler.refreshTags();
      await new Promise((r) => setTimeout(r, 20));

      expect(mockFile.download).toHaveBeenCalledTimes(1);
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

  describe('Next.js 15 calling convention', () => {
    it('getExpiration accepts tags spread as arguments', async () => {
      mockFile.exists.mockResolvedValue([true]);
      mockFile.download.mockResolvedValue([Buffer.from('{}')]);
      const handler = new UseCacheGcsHandler();
      await handler.updateTags(['tag1'], [0]);

      const spread = await handler.getExpiration('tag1', 'tag2');
      expect(spread).toBeGreaterThan(0);
      expect(spread).toBe(await handler.getExpiration(['tag1', 'tag2']));
    });

    it('expireTags invalidates like updateTags', async () => {
      mockFile.exists.mockResolvedValue([true]);
      mockFile.download.mockResolvedValue([Buffer.from('{}')]);
      const handler = new UseCacheGcsHandler();

      const before = Date.now();
      await handler.expireTags('blog', 'posts');

      expect(await handler.getExpiration('blog')).toBeGreaterThanOrEqual(before);
      expect(await handler.getExpiration('posts')).toBeGreaterThanOrEqual(before);
    });
  });

  describe('updateTags', () => {
    it('should save tag timestamps to GCS', async () => {
      mockFile.exists.mockResolvedValue([true]);
      mockFile.download.mockResolvedValue([Buffer.from('{}')]);

      const handler = new UseCacheGcsHandler();

      await handler.updateTags(['blog'], [0]);

      // Verify save was called with tag timestamps (build meta may be saved concurrently)
      const saved = mockFile.save.mock.calls.map(([data]) => JSON.parse(data as string)).find((d) => 'blog' in d);
      expect(saved).toBeDefined();
      expect(typeof saved.blog).toBe('number');
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

    it('should not trigger edge cache clearing (handled by legacy handler)', async () => {
      process.env.OUTBOUND_PROXY_ENDPOINT = 'proxy.example.com:8080';

      mockFile.exists.mockResolvedValue([true]);
      mockFile.download.mockResolvedValue([Buffer.from('{}')]);
      vi.mocked(fetch).mockResolvedValue({ ok: true, status: 200 } as Response);

      const handler = new UseCacheGcsHandler();
      await handler.updateTags(['posts'], [0]);

      await new Promise((r) => setTimeout(r, 50));

      // Use-cache handler should NOT call fetch for CDN clearing.
      // CDN purging is handled by the legacy cacheHandler.
      expect(fetch).not.toHaveBeenCalled();

      // But timestamps should be updated
      const exp = await handler.getExpiration(['posts']);
      expect(exp).toBeGreaterThan(0);
    });
  });

  describe('updateTags with _N_T_ path tags', () => {
    it('should still invalidate tag timestamps for _N_T_ tags', async () => {
      mockFile.exists.mockResolvedValue([true]);
      mockFile.download.mockResolvedValue([Buffer.from('{}')]);

      const handler = new UseCacheGcsHandler();

      await handler.updateTags(['_N_T_/api/cdnprobe'], [0]);

      // The _N_T_ tag should still be recorded in tagTimestamps for server-side expiration
      const expiration = await handler.getExpiration(['_N_T_/api/cdnprobe']);
      expect(expiration).toBeGreaterThan(0);
    });

    it('should handle mixed explicit and _N_T_ tags (timestamps only)', async () => {
      mockFile.exists.mockResolvedValue([true]);
      mockFile.download.mockResolvedValue([Buffer.from('{}')]);

      const handler = new UseCacheGcsHandler();

      // Mixed: explicit tag + path tag — both should update timestamps
      await handler.updateTags(['posts', '_N_T_/api/cdnprobe'], [0, 0]);

      const exp1 = await handler.getExpiration(['posts']);
      const exp2 = await handler.getExpiration(['_N_T_/api/cdnprobe']);
      expect(exp1).toBeGreaterThan(0);
      expect(exp2).toBeGreaterThan(0);
    });

    it('should not trigger CDN clearing (handled by legacy handler)', async () => {
      process.env.OUTBOUND_PROXY_ENDPOINT = 'proxy.example.com:8080';

      mockFile.exists.mockResolvedValue([true]);
      mockFile.download.mockResolvedValue([Buffer.from('{}')]);

      const handler = new UseCacheGcsHandler();

      await handler.updateTags(['_N_T_/blogs', 'post-123'], [0, 0]);

      await new Promise((r) => setTimeout(r, 50));

      // No fetch calls — use-cache handler doesn't do CDN clearing
      // CDN purging is handled by the legacy cacheHandler which has
      // the tag-to-path mapping
      expect(fetch).not.toHaveBeenCalled();
    });
  });

  describe('environment prefix', () => {
    let originalPantheonEnv: string | undefined;

    beforeEach(() => {
      originalPantheonEnv = process.env.PANTHEON_ENVIRONMENT;
    });

    afterEach(() => {
      if (originalPantheonEnv !== undefined) {
        process.env.PANTHEON_ENVIRONMENT = originalPantheonEnv;
      } else {
        delete process.env.PANTHEON_ENVIRONMENT;
      }
    });

    it('should prefix cache keys for multidev environment', async () => {
      process.env.PANTHEON_ENVIRONMENT = 'pr-77';
      mockFile.exists.mockResolvedValue([false]);

      const handler = new UseCacheGcsHandler();
      await handler.get('my-key', []);

      expect(mockBucket.file).toHaveBeenCalledWith('environments/pr-77/use-cache/my-key.json');
    });

    it('should prefix tags file for multidev environment', async () => {
      process.env.PANTHEON_ENVIRONMENT = 'pr-77';
      mockFile.exists.mockResolvedValue([false]);

      new UseCacheGcsHandler();
      await new Promise((r) => setTimeout(r, 10));

      expect(mockBucket.file).toHaveBeenCalledWith('environments/pr-77/use-cache/_tags.json');
    });

    it('should save tag timestamps to prefixed path for multidev', async () => {
      process.env.PANTHEON_ENVIRONMENT = 'pr-77';
      mockFile.exists.mockResolvedValue([true]);
      mockFile.download.mockResolvedValue([Buffer.from('{}')]);

      const handler = new UseCacheGcsHandler();
      await handler.updateTags(['blog'], [0]);

      expect(mockBucket.file).toHaveBeenCalledWith('environments/pr-77/use-cache/_tags.json');
    });

    it('should use no prefix for live environment', async () => {
      process.env.PANTHEON_ENVIRONMENT = 'live';
      mockFile.exists.mockResolvedValue([false]);

      const handler = new UseCacheGcsHandler();
      await handler.get('my-key', []);

      expect(mockBucket.file).toHaveBeenCalledWith('use-cache/my-key.json');
    });

    it('should use no prefix when PANTHEON_ENVIRONMENT is not set', async () => {
      delete process.env.PANTHEON_ENVIRONMENT;
      mockFile.exists.mockResolvedValue([false]);

      const handler = new UseCacheGcsHandler();
      await handler.get('my-key', []);

      expect(mockBucket.file).toHaveBeenCalledWith('use-cache/my-key.json');
    });

    it('should list files under prefixed path for multidev getStats', async () => {
      process.env.PANTHEON_ENVIRONMENT = 'pr-77';
      mockFile.exists.mockResolvedValue([false]);
      mockBucket.getFiles.mockResolvedValue([[]]);

      const handler = new UseCacheGcsHandler();
      await handler.getStats();

      expect(mockBucket.getFiles).toHaveBeenCalledWith({ prefix: 'environments/pr-77/use-cache/' });
    });
  });

  describe('build check', () => {
    const buildMetaSaves = () =>
      mockFile.save.mock.calls.filter(([json]) => {
        const parsed = JSON.parse(json as string);
        return 'buildId' in parsed && !('value' in parsed);
      });

    it('retries the build check when _build-meta.json cannot be read, without recording the generation', async () => {
      process.env.OUTBOUND_PROXY_ENDPOINT = 'proxy.example.com:8080';
      vi.mocked(fetch).mockResolvedValue({ ok: true, status: 200 } as Response);
      mockFile.download.mockRejectedValue(Object.assign(new Error('Service unavailable'), { code: 503 }));

      const handler = new UseCacheGcsHandler();
      await handler.get('k', []);

      expect(buildMetaSaves()).toHaveLength(0);
      expect(fetch).not.toHaveBeenCalled();

      // GCS recovers and holds another build's metadata: the next read runs the check.
      mockFile.download.mockResolvedValue([Buffer.from(JSON.stringify({ buildId: 'old-build', timestamp: 1 }))]);
      await handler.get('k', []);

      expect(fetch).toHaveBeenCalledWith(
        'http://proxy.example.com:8080/rest/v0alpha1/cache',
        expect.objectContaining({ method: 'DELETE' })
      );
      expect(buildMetaSaves()).toHaveLength(1);
    });

    it('treats _build-meta.json that is not valid JSON as a different build', async () => {
      process.env.OUTBOUND_PROXY_ENDPOINT = 'proxy.example.com:8080';
      vi.mocked(fetch).mockResolvedValue({ ok: true, status: 200 } as Response);
      mockFile.download.mockResolvedValue([Buffer.from('not json')]);

      await new UseCacheGcsHandler().get('k', []);

      expect(fetch).toHaveBeenCalledWith(
        'http://proxy.example.com:8080/rest/v0alpha1/cache',
        expect.objectContaining({ method: 'DELETE' })
      );
      expect(buildMetaSaves()).toHaveLength(1);
    });
  });

  describe('cache key sanitization', () => {
    it('should handle keys with special characters', async () => {
      mockFile.exists.mockResolvedValue([false]);

      const handler = new UseCacheGcsHandler();
      await handler.get('/api/cache/test?param=value', []);

      // Sanitized, plus a hash of the full key so similar keys don't share an object
      expect(mockBucket.file).toHaveBeenCalledWith(
        expect.stringMatching(/^use-cache\/_api_cache_test_param_value_[0-9a-f]{16}\.json$/)
      );
    });
  });
});

describe('UseCacheGcsHandler tag timestamp persistence', () => {
  let originalCacheBucket: string | undefined;

  /** save() calls that wrote the tag timestamps (not an entry or build meta). */
  function timestampSaves() {
    return mockFile.save.mock.calls.filter(([data]) => {
      const parsed = JSON.parse(data as string);
      return !('buildId' in parsed) && !('value' in parsed);
    });
  }

  beforeEach(() => {
    originalCacheBucket = process.env.CACHE_BUCKET;
    process.env.CACHE_BUCKET = 'test-bucket';
    delete process.env.OUTBOUND_PROXY_ENDPOINT;

    vi.clearAllMocks();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});

    mockFile.exists.mockResolvedValue([true]);
    mockFile.save.mockResolvedValue(undefined);
    mockFile.getMetadata.mockResolvedValue([{ generation: '1' }]);
    mockFile.download.mockResolvedValue([Buffer.from('{}')]);
    mockFile.delete.mockResolvedValue(undefined);
    mockBucket.getFiles.mockResolvedValue([[]]);
    mockBucket.file.mockReturnValue(mockFile);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    if (originalCacheBucket !== undefined) {
      process.env.CACHE_BUCKET = originalCacheBucket;
    } else {
      delete process.env.CACHE_BUCKET;
    }
  });

  it('writes with the generation it read as a precondition', async () => {
    mockFile.getMetadata.mockResolvedValue([{ generation: '9' }]);

    const handler = new UseCacheGcsHandler();
    await handler.updateTags(['blog'], [0]);

    expect(mockBucket.file).toHaveBeenCalledWith('use-cache/_tags.json', { generation: '9' });
    const [, options] = timestampSaves()[0];
    expect(options).toMatchObject({ resumable: false, preconditionOpts: { ifGenerationMatch: '9' } });
  });

  it('merges newer stored timestamps instead of overwriting them', async () => {
    const future = Date.now() + 100_000;
    mockFile.download.mockResolvedValue([Buffer.from(JSON.stringify({ other: future, blog: 5 }))]);

    const handler = new UseCacheGcsHandler();
    await handler.updateTags(['blog'], [0]);

    const saved = JSON.parse(timestampSaves()[0][0] as string);
    expect(saved.other).toBe(future);
    expect(saved.blog).toBeGreaterThan(5);
    expect(await handler.getExpiration(['other'])).toBe(future);
  });

  it('re-reads and retries after a 412', async () => {
    mockFile.getMetadata.mockResolvedValueOnce([{ generation: '1' }]).mockResolvedValueOnce([{ generation: '2' }]);
    let attempts = 0;
    mockFile.save.mockImplementation(async (data: string) => {
      const parsed = JSON.parse(data);
      if ('buildId' in parsed || 'value' in parsed) return;
      if (attempts++ === 0) {
        throw Object.assign(new Error('Precondition Failed'), { code: 412 });
      }
    });

    const handler = new UseCacheGcsHandler();
    await handler.updateTags(['blog'], [0]);

    const saves = timestampSaves();
    expect(saves).toHaveLength(2);
    expect(saves[1][1]).toMatchObject({ preconditionOpts: { ifGenerationMatch: '2' } });
  });

  it('coalesces concurrent updateTags calls into serialized writes', async () => {
    const handler = new UseCacheGcsHandler();
    await Promise.all([handler.updateTags(['a'], [0]), handler.updateTags(['b'], [0]), handler.updateTags(['c'], [0])]);

    const saves = timestampSaves();
    expect(saves.length).toBeGreaterThanOrEqual(1);
    expect(saves.length).toBeLessThanOrEqual(2);
    const last = JSON.parse(saves[saves.length - 1][0] as string);
    expect(Object.keys(last).sort()).toEqual(['a', 'b', 'c']);
  });

  it('backs off after a failed write and retries in the background', async () => {
    vi.useFakeTimers();
    let attempts = 0;
    mockFile.save.mockImplementation(async (data: string) => {
      const parsed = JSON.parse(data);
      if ('buildId' in parsed || 'value' in parsed) return;
      if (attempts++ === 0) {
        throw Object.assign(new Error('rateLimitExceeded'), { code: 429 });
      }
    });

    const handler = new UseCacheGcsHandler();
    await handler.updateTags(['blog'], [0]);
    expect(timestampSaves()).toHaveLength(1);
    expect(console.warn).toHaveBeenCalledTimes(1);

    // Still backing off: the next update stays in memory, no write.
    await handler.updateTags(['news'], [0]);
    expect(timestampSaves()).toHaveLength(1);
    expect(await handler.getExpiration(['news'])).toBeGreaterThan(0);

    // Backoff after one failure is at most 2s.
    await vi.advanceTimersByTimeAsync(2100);

    const saves = timestampSaves();
    expect(saves).toHaveLength(2);
    expect(Object.keys(JSON.parse(saves[1][0] as string)).sort()).toEqual(['blog', 'news']);
  });
});
