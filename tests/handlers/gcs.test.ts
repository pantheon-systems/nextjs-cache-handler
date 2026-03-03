import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock file and bucket stored in globalThis for access
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
  // Create mock Storage class inside factory
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
import { GcsCacheHandler, getSharedCacheStats, clearSharedCache } from '../../src/handlers/gcs.js';

// Mock fetch for edge cache
vi.stubGlobal('fetch', vi.fn());

describe('GcsCacheHandler', () => {
  let originalCacheBucket: string | undefined;
  let originalProxyEndpoint: string | undefined;

  beforeEach(() => {
    originalCacheBucket = process.env.CACHE_BUCKET;
    originalProxyEndpoint = process.env.OUTBOUND_PROXY_ENDPOINT;

    process.env.CACHE_BUCKET = 'test-bucket';
    delete process.env.OUTBOUND_PROXY_ENDPOINT; // Disable edge cache for most tests

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
      expect(() => new GcsCacheHandler({} as any)).toThrow('CACHE_BUCKET environment variable is required');
    });

    it('should create handler when CACHE_BUCKET is set', () => {
      process.env.CACHE_BUCKET = 'my-bucket';
      const handler = new GcsCacheHandler({} as any);
      expect(handler).toBeInstanceOf(GcsCacheHandler);
    });

    it('should initialize tags mapping', async () => {
      mockFile.exists.mockResolvedValue([false]);

      new GcsCacheHandler({} as any);

      // Wait for async initialization
      await new Promise((r) => setTimeout(r, 10));

      expect(mockBucket.file).toHaveBeenCalledWith('cache/tags/tags.json');
    });
  });

  describe('get', () => {
    it('should return null for non-existent cache entry', async () => {
      mockFile.exists.mockResolvedValue([false]);

      const handler = new GcsCacheHandler({} as any);
      const result = await handler.get('non-existent-key');

      expect(result).toBeNull();
    });

    it('should return cached entry when it exists', async () => {
      const cachedData = {
        value: { kind: 'FETCH', data: 'test' },
        lastModified: 1234567890,
        tags: ['tag1'],
      };

      mockFile.exists.mockResolvedValue([true]);
      mockFile.download.mockResolvedValue([Buffer.from(JSON.stringify(cachedData))]);

      const handler = new GcsCacheHandler({} as any);
      const result = await handler.get('test-key', { fetchIdx: 0 } as any);

      expect(result).not.toBeNull();
      expect(result?.value).toEqual(cachedData.value);
      expect(result?.tags).toEqual(['tag1']);
    });

    it('should use fetch-cache prefix for fetch cache entries', async () => {
      mockFile.exists.mockResolvedValue([false]);

      const handler = new GcsCacheHandler({} as any);
      await handler.get('key', { fetchIdx: 0 } as any);

      expect(mockBucket.file).toHaveBeenCalledWith('fetch-cache/key.json');
    });

    it('should use route-cache prefix for route cache entries', async () => {
      mockFile.exists.mockResolvedValue([false]);

      const handler = new GcsCacheHandler({} as any);
      await handler.get('key');

      expect(mockBucket.file).toHaveBeenCalledWith('route-cache/key.json');
    });
  });

  describe('set', () => {
    it('should save cache entry to GCS', async () => {
      mockFile.exists.mockResolvedValue([true]);
      mockFile.download.mockResolvedValue([Buffer.from('{}')]);

      const handler = new GcsCacheHandler({} as any);
      await handler.set('key', { kind: 'FETCH' as const } as any, { tags: ['tag1'] });

      expect(mockFile.save).toHaveBeenCalled();
      const savedData = JSON.parse(mockFile.save.mock.calls[0][0]);
      expect(savedData.value).toEqual({ kind: 'FETCH' });
      expect(savedData.tags).toEqual(['tag1']);
    });

    it('should use fetch-cache prefix for FETCH kind', async () => {
      mockFile.exists.mockResolvedValue([true]);
      mockFile.download.mockResolvedValue([Buffer.from('{}')]);

      const handler = new GcsCacheHandler({} as any);
      await handler.set('key', { kind: 'FETCH' as const } as any, { tags: [] });

      expect(mockBucket.file).toHaveBeenCalledWith('fetch-cache/key.json');
    });

    it('should use route-cache prefix for non-FETCH kind', async () => {
      mockFile.exists.mockResolvedValue([true]);
      mockFile.download.mockResolvedValue([Buffer.from('{}')]);

      const handler = new GcsCacheHandler({} as any);
      await handler.set('key', { kind: 'APP_PAGE' as const } as any, { tags: [] });

      expect(mockBucket.file).toHaveBeenCalledWith('route-cache/key.json');
    });

    it('should clear edge cache when setting route cache entry (ISR update)', async () => {
      process.env.OUTBOUND_PROXY_ENDPOINT = 'proxy.example.com:8080';

      mockFile.exists.mockResolvedValue([true]);
      mockFile.download.mockResolvedValue([Buffer.from('{}')]);
      vi.mocked(fetch).mockResolvedValue({ ok: true, status: 200 } as Response);

      const handler = new GcsCacheHandler({} as any);
      await handler.set('/blogs/my-post', { kind: 'APP_PAGE' as const } as any, { tags: [] });

      // Wait for background edge cache clear
      await new Promise((r) => setTimeout(r, 50));

      // Verify edge cache was cleared for the route path (double-encoded)
      expect(fetch).toHaveBeenCalledWith(
        expect.stringContaining(`/paths/${encodeURIComponent(encodeURIComponent('blogs/my-post'))}`),
        expect.objectContaining({ method: 'DELETE' })
      );
    });

    it('should not clear edge cache when setting fetch cache entry', async () => {
      process.env.OUTBOUND_PROXY_ENDPOINT = 'proxy.example.com:8080';

      mockFile.exists.mockResolvedValue([true]);
      mockFile.download.mockResolvedValue([Buffer.from('{}')]);
      vi.mocked(fetch).mockResolvedValue({ ok: true, status: 200 } as Response);

      const handler = new GcsCacheHandler({} as any);
      await handler.set('fetch-key', { kind: 'FETCH' as const } as any, { tags: [] });

      // Wait to ensure no background edge cache clear happens
      await new Promise((r) => setTimeout(r, 50));

      // Fetch cache entries should not trigger edge cache clearing
      expect(fetch).not.toHaveBeenCalledWith(expect.stringContaining('/paths/'), expect.anything());
    });

    it('should handle route cache keys with underscores (encoded paths)', async () => {
      process.env.OUTBOUND_PROXY_ENDPOINT = 'proxy.example.com:8080';

      mockFile.exists.mockResolvedValue([true]);
      mockFile.download.mockResolvedValue([Buffer.from('{}')]);
      vi.mocked(fetch).mockResolvedValue({ ok: true, status: 200 } as Response);

      const handler = new GcsCacheHandler({} as any);
      // Some cache keys use underscores to encode path separators
      await handler.set('_blogs_my-post', { kind: 'APP_PAGE' as const } as any, { tags: [] });

      // Wait for background edge cache clear
      await new Promise((r) => setTimeout(r, 50));

      // Should convert underscores to slashes and double-encode
      expect(fetch).toHaveBeenCalledWith(
        expect.stringContaining(`/paths/${encodeURIComponent(encodeURIComponent('blogs/my-post'))}`),
        expect.objectContaining({ method: 'DELETE' })
      );
    });

    it('should not clear edge cache when edge clearer is not configured', async () => {
      // OUTBOUND_PROXY_ENDPOINT is not set (default in beforeEach)
      mockFile.exists.mockResolvedValue([true]);
      mockFile.download.mockResolvedValue([Buffer.from('{}')]);

      const handler = new GcsCacheHandler({} as any);
      await handler.set('/blogs/my-post', { kind: 'APP_PAGE' as const } as any, { tags: [] });

      // Wait to ensure no edge cache clear happens
      await new Promise((r) => setTimeout(r, 50));

      // No fetch calls for edge cache clearing
      expect(fetch).not.toHaveBeenCalled();
    });
  });

  describe('revalidateTag', () => {
    it('should delete cache entries with matching tag', async () => {
      // Setup: tags mapping with entries
      const tagsMapping = { posts: ['key1', 'key2'] };
      mockFile.exists.mockResolvedValue([true]);
      mockFile.download.mockResolvedValue([Buffer.from(JSON.stringify(tagsMapping))]);

      const handler = new GcsCacheHandler({} as any);
      await handler.revalidateTag('posts');

      // Verify delete was called
      expect(mockFile.delete).toHaveBeenCalled();
    });

    it('should handle non-existent tag gracefully', async () => {
      mockFile.exists.mockResolvedValue([true]);
      mockFile.download.mockResolvedValue([Buffer.from('{}')]);

      const handler = new GcsCacheHandler({} as any);
      await expect(handler.revalidateTag('non-existent')).resolves.not.toThrow();
    });

    it('should trigger edge cache clear when configured', async () => {
      process.env.OUTBOUND_PROXY_ENDPOINT = 'proxy.example.com:8080';

      const tagsMapping = { posts: ['key1'] };
      mockFile.exists.mockResolvedValue([true]);
      mockFile.download.mockResolvedValue([Buffer.from(JSON.stringify(tagsMapping))]);

      vi.mocked(fetch).mockResolvedValue({ ok: true, status: 200 } as Response);

      const handler = new GcsCacheHandler({} as any);
      await handler.revalidateTag('posts');

      // Wait for background edge cache clear
      await new Promise((r) => setTimeout(r, 50));

      expect(fetch).toHaveBeenCalled();
    });
  });

  describe('resetRequestCache', () => {
    it('should not throw', () => {
      const handler = new GcsCacheHandler({} as any);
      expect(() => handler.resetRequestCache()).not.toThrow();
    });
  });
});

describe('GCS getSharedCacheStats', () => {
  let originalCacheBucket: string | undefined;

  beforeEach(() => {
    originalCacheBucket = process.env.CACHE_BUCKET;
    process.env.CACHE_BUCKET = 'test-bucket';
    vi.clearAllMocks();
    mockBucket.file.mockReturnValue(mockFile);
  });

  afterEach(() => {
    if (originalCacheBucket !== undefined) {
      process.env.CACHE_BUCKET = originalCacheBucket;
    } else {
      delete process.env.CACHE_BUCKET;
    }
  });

  it('should return empty stats when CACHE_BUCKET is not set', async () => {
    delete process.env.CACHE_BUCKET;
    const stats = await getSharedCacheStats();
    expect(stats.size).toBe(0);
  });

  it('should return stats for cache entries', async () => {
    const fetchFile = {
      name: 'fetch-cache/key1.json',
      download: vi.fn().mockResolvedValue([Buffer.from(JSON.stringify({ tags: ['tag1'], lastModified: 123 }))]),
    };
    const routeFile = {
      name: 'route-cache/key2.json',
      download: vi.fn().mockResolvedValue([Buffer.from(JSON.stringify({ tags: ['tag2'], lastModified: 456 }))]),
    };

    mockBucket.getFiles.mockResolvedValueOnce([[fetchFile]]).mockResolvedValueOnce([[routeFile]]);

    const stats = await getSharedCacheStats();

    expect(stats.size).toBe(2);
    expect(stats.keys).toContain('fetch:key1');
    expect(stats.keys).toContain('route:key2');
  });
});

describe('GCS clearSharedCache', () => {
  let originalCacheBucket: string | undefined;
  let originalProxyEndpoint: string | undefined;

  beforeEach(() => {
    originalCacheBucket = process.env.CACHE_BUCKET;
    originalProxyEndpoint = process.env.OUTBOUND_PROXY_ENDPOINT;

    process.env.CACHE_BUCKET = 'test-bucket';
    delete process.env.OUTBOUND_PROXY_ENDPOINT;

    vi.clearAllMocks();
    mockFile.exists.mockResolvedValue([false]);
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

  it('should return 0 when CACHE_BUCKET is not set', async () => {
    delete process.env.CACHE_BUCKET;
    const cleared = await clearSharedCache();
    expect(cleared).toBe(0);
  });

  it('should delete all cache entries', async () => {
    const file1 = { name: 'fetch-cache/key1.json', delete: vi.fn().mockResolvedValue(undefined) };
    const file2 = { name: 'route-cache/key2.json', delete: vi.fn().mockResolvedValue(undefined) };

    mockBucket.getFiles
      .mockResolvedValueOnce([[file1]]) // fetch cache
      .mockResolvedValueOnce([[file2]]); // route cache

    const cleared = await clearSharedCache();

    expect(cleared).toBe(2);
    expect(file1.delete).toHaveBeenCalled();
    expect(file2.delete).toHaveBeenCalled();
  });

  it('should clear edge cache when entries are cleared', async () => {
    process.env.OUTBOUND_PROXY_ENDPOINT = 'proxy.example.com:8080';

    const file1 = { name: 'fetch-cache/key1.json', delete: vi.fn().mockResolvedValue(undefined) };
    mockBucket.getFiles.mockResolvedValueOnce([[file1]]).mockResolvedValueOnce([[]]);

    vi.mocked(fetch).mockResolvedValue({ ok: true, status: 200 } as Response);

    await clearSharedCache();

    // Wait for background edge cache clear
    await new Promise((r) => setTimeout(r, 50));

    expect(fetch).toHaveBeenCalled();
  });
});
