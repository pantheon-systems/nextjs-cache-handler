import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock file and bucket stored in globalThis for access
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

/** Options passed to each `new Storage(...)`, in construction order. */
const storageConstructorOptions: unknown[] = [];

// Mock must be defined with factory - hoisted to top
vi.mock('@google-cloud/storage', () => {
  // Create mock Storage class inside factory
  return {
    Storage: function Storage(options?: unknown) {
      storageConstructorOptions.push(options);
      return {
        bucket: () => mockBucket,
      };
    },
    Bucket: vi.fn(),
    RETRYABLE_ERR_FN_DEFAULT: (err: { code?: number }) =>
      err.code === 429 || err.code === 408 || (err.code ?? 0) >= 500,
  };
});

// Import after mock is set up
import {
  GcsCacheHandler,
  getSharedCacheStats,
  clearSharedCache,
  resetGcsSharedState,
  flushGcsTagsMapping,
} from '../../src/handlers/gcs.js';
import { resetBuildInvalidationCheck } from '../../src/handlers/base.js';
import { DEFAULT_TAGS_FLUSH_INTERVAL_MS } from '../../src/utils/tags-buffer.js';

/** save() calls that wrote the tags mapping (not a cache entry or build meta). */
function tagsMappingSaves() {
  return mockFile.save.mock.calls.filter(([data]) => {
    const parsed = JSON.parse(data as string);
    return !('lastModified' in parsed) && !('buildId' in parsed);
  });
}

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
    resetGcsSharedState();

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
      expect(() => new GcsCacheHandler({} as any)).toThrow('CACHE_BUCKET environment variable is required');
    });

    it('should create handler when CACHE_BUCKET is set', () => {
      process.env.CACHE_BUCKET = 'my-bucket';
      const handler = new GcsCacheHandler({} as any);
      expect(handler).toBeInstanceOf(GcsCacheHandler);
    });

    it('should not touch the tags mapping on construction', async () => {
      new GcsCacheHandler({} as any);

      // Wait for async initialization
      await new Promise((r) => setTimeout(r, 10));

      // The first flush creates the object with an ifGenerationMatch: 0 precondition instead.
      expect(mockBucket.file).not.toHaveBeenCalledWith('cache/tags/tags.json');
      expect(mockFile.save).not.toHaveBeenCalled();
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

    it('should use image-cache prefix for image optimizer requests (kind: IMAGE ctx)', async () => {
      mockFile.exists.mockResolvedValue([false]);

      const handler = new GcsCacheHandler({} as any);
      await handler.get('key', { kind: 'IMAGE', isFallback: false } as any);

      expect(mockBucket.file).toHaveBeenCalledWith('image-cache/key.json');
    });

    it('should round-trip the image buffer through base64 storage', async () => {
      const buffer = Buffer.from('fake-jpeg-bytes');
      const cachedData = {
        value: { kind: 'IMAGE', etag: 'abc', upstreamEtag: 'def', extension: 'jpg', buffer },
        lastModified: 1234567890,
        tags: [],
      };

      mockFile.exists.mockResolvedValue([true]);
      mockFile.download.mockResolvedValue([
        Buffer.from(
          JSON.stringify({
            ...cachedData,
            value: { ...cachedData.value, buffer: { type: 'Buffer', data: buffer.toString('base64') } },
          })
        ),
      ]);

      const handler = new GcsCacheHandler({} as any);
      const result = await handler.get('key', { kind: 'IMAGE', isFallback: false } as any);

      expect(mockBucket.file).toHaveBeenCalledWith('image-cache/key.json');
      expect(Buffer.isBuffer((result?.value as any).buffer)).toBe(true);
      expect((result?.value as any).buffer.toString()).toBe('fake-jpeg-bytes');
    });

    it('does not fall through to the build-prerender fallback on an image miss', async () => {
      mockFile.exists.mockResolvedValue([false]);

      const handler = new GcsCacheHandler({} as any);
      const result = await handler.get('missing-image', { kind: 'IMAGE', isFallback: false } as any);

      expect(result).toBeNull();
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

    it('should use image-cache prefix for IMAGE kind and base64-encode the buffer', async () => {
      mockFile.exists.mockResolvedValue([true]);
      mockFile.download.mockResolvedValue([Buffer.from('{}')]);

      const handler = new GcsCacheHandler({} as any);
      const buffer = Buffer.from('fake-jpeg-bytes');
      await handler.set(
        'key',
        { kind: 'IMAGE' as const, etag: 'abc', upstreamEtag: 'def', extension: 'jpg', buffer } as any,
        { cacheControl: { revalidate: 60 } } as any
      );

      expect(mockBucket.file).toHaveBeenCalledWith('image-cache/key.json');
      const savedData = JSON.parse(mockFile.save.mock.calls[0][0]);
      expect(savedData.value.buffer).toEqual({ type: 'Buffer', data: buffer.toString('base64') });
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

    it('should purge / when the root page regenerates (cache key /index)', async () => {
      process.env.OUTBOUND_PROXY_ENDPOINT = 'proxy.example.com:8080';

      mockFile.exists.mockResolvedValue([true]);
      mockFile.download.mockResolvedValue([Buffer.from('{}')]);
      vi.mocked(fetch).mockResolvedValue({ ok: true, status: 200 } as Response);

      const handler = new GcsCacheHandler({} as any);
      // IncrementalCache stores `/` under `/index` (normalizePagePath).
      await handler.set('/index', { kind: 'APP_PAGE' as const } as any, { tags: [] });

      await new Promise((r) => setTimeout(r, 50));

      expect(fetch).toHaveBeenCalledWith(
        expect.stringContaining(`/paths/${encodeURIComponent(encodeURIComponent('/'))}`),
        expect.objectContaining({ method: 'DELETE' })
      );
      expect(fetch).not.toHaveBeenCalledWith(expect.stringContaining('/paths/index'), expect.anything());
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
    // Staleness is tracked via Next's shared tagsManifest, not by deleting the
    // stored entry — Next needs the last-good value to still be gettable so it
    // can serve it once while revalidating in the background (see base.ts's
    // revalidateTag for the full rationale).
    it('should not delete cache entries with matching tag', async () => {
      // Setup: tags mapping with entries
      const tagsMapping = { posts: ['key1', 'key2'] };
      mockFile.exists.mockResolvedValue([true]);
      mockFile.download.mockResolvedValue([Buffer.from(JSON.stringify(tagsMapping))]);

      const handler = new GcsCacheHandler({} as any);
      await handler.revalidateTag('posts');

      expect(mockFile.delete).not.toHaveBeenCalled();
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

describe('GcsCacheHandler environment prefix', () => {
  let originalCacheBucket: string | undefined;
  let originalPantheonEnv: string | undefined;

  beforeEach(() => {
    originalCacheBucket = process.env.CACHE_BUCKET;
    originalPantheonEnv = process.env.PANTHEON_ENVIRONMENT;

    process.env.CACHE_BUCKET = 'test-bucket';
    delete process.env.OUTBOUND_PROXY_ENDPOINT;

    vi.clearAllMocks();
    resetGcsSharedState();

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

    if (originalPantheonEnv !== undefined) {
      process.env.PANTHEON_ENVIRONMENT = originalPantheonEnv;
    } else {
      delete process.env.PANTHEON_ENVIRONMENT;
    }
  });

  it('should prefix cache keys with environment directory for multidev', async () => {
    process.env.PANTHEON_ENVIRONMENT = 'pr-42';

    const handler = new GcsCacheHandler({} as any);
    await handler.get('my-key', { fetchIdx: 0 } as any);

    expect(mockBucket.file).toHaveBeenCalledWith('environments/pr-42/fetch-cache/my-key.json');
  });

  it('should prefix route cache keys for multidev', async () => {
    process.env.PANTHEON_ENVIRONMENT = 'pr-42';

    const handler = new GcsCacheHandler({} as any);
    await handler.get('my-key');

    expect(mockBucket.file).toHaveBeenCalledWith('environments/pr-42/route-cache/my-key.json');
  });

  it('should prefix tags mapping for multidev', async () => {
    process.env.PANTHEON_ENVIRONMENT = 'pr-42';
    vi.useFakeTimers();
    const random = vi.spyOn(Math, 'random').mockReturnValue(0); // no interval jitter
    try {
      const handler = new GcsCacheHandler({} as any);
      await handler.set('key', { kind: 'FETCH' as const } as any, { tags: ['tag1'] });
      await vi.advanceTimersByTimeAsync(DEFAULT_TAGS_FLUSH_INTERVAL_MS + 100);
    } finally {
      vi.useRealTimers();
      random.mockRestore();
    }

    expect(mockBucket.file).toHaveBeenCalledWith('environments/pr-42/cache/tags/tags.json');
    expect(tagsMappingSaves()).toHaveLength(1);
  });

  it('should prefix build meta for multidev', async () => {
    process.env.PANTHEON_ENVIRONMENT = 'pr-42';
    resetBuildInvalidationCheck();
    mockFile.exists.mockResolvedValue([true]);
    mockFile.download.mockResolvedValue([Buffer.from(JSON.stringify({ buildId: 'old', timestamp: 1 }))]);

    new GcsCacheHandler({} as any);
    await new Promise((r) => setTimeout(r, 50));

    expect(mockBucket.file).toHaveBeenCalledWith('environments/pr-42/build-meta.json');
  });

  it('should use no prefix for live (production) environment', async () => {
    process.env.PANTHEON_ENVIRONMENT = 'live';

    const handler = new GcsCacheHandler({} as any);
    await handler.get('my-key', { fetchIdx: 0 } as any);

    expect(mockBucket.file).toHaveBeenCalledWith('fetch-cache/my-key.json');
  });

  it('should invalidate only prefixed route cache for multidev', async () => {
    process.env.PANTHEON_ENVIRONMENT = 'pr-42';
    resetBuildInvalidationCheck();
    mockFile.exists.mockResolvedValue([true]);

    const buildMeta = { buildId: 'old-build', timestamp: 1 };
    mockFile.download.mockResolvedValue([Buffer.from(JSON.stringify(buildMeta))]);

    new GcsCacheHandler({} as any);
    await new Promise((r) => setTimeout(r, 50));

    // Build invalidation should list files only under the env prefix
    expect(mockBucket.getFiles).toHaveBeenCalledWith({ prefix: 'environments/pr-42/route-cache/' });
  });

  it('should not touch other environments cache during invalidation', async () => {
    process.env.PANTHEON_ENVIRONMENT = 'pr-42';
    resetBuildInvalidationCheck();
    mockFile.exists.mockResolvedValue([true]);

    const buildMeta = { buildId: 'old-build', timestamp: 1 };
    mockFile.download.mockResolvedValue([Buffer.from(JSON.stringify(buildMeta))]);

    new GcsCacheHandler({} as any);
    await new Promise((r) => setTimeout(r, 50));

    // Verify no calls to unprefixed or other environment paths
    const getFilesCalls = mockBucket.getFiles.mock.calls;
    for (const [args] of getFilesCalls) {
      expect(args.prefix).toMatch(/^environments\/pr-42\//);
    }
  });
});

describe('GCS standalone functions environment prefix', () => {
  let originalCacheBucket: string | undefined;
  let originalPantheonEnv: string | undefined;

  beforeEach(() => {
    originalCacheBucket = process.env.CACHE_BUCKET;
    originalPantheonEnv = process.env.PANTHEON_ENVIRONMENT;

    process.env.CACHE_BUCKET = 'test-bucket';
    delete process.env.OUTBOUND_PROXY_ENDPOINT;

    vi.clearAllMocks();
    resetGcsSharedState();

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

    if (originalPantheonEnv !== undefined) {
      process.env.PANTHEON_ENVIRONMENT = originalPantheonEnv;
    } else {
      delete process.env.PANTHEON_ENVIRONMENT;
    }
  });

  it('getSharedCacheStats should use prefixed paths for multidev', async () => {
    process.env.PANTHEON_ENVIRONMENT = 'pr-99';
    mockBucket.getFiles.mockResolvedValue([[]]);

    await getSharedCacheStats();

    expect(mockBucket.getFiles).toHaveBeenCalledWith({ prefix: 'environments/pr-99/fetch-cache/' });
    expect(mockBucket.getFiles).toHaveBeenCalledWith({ prefix: 'environments/pr-99/route-cache/' });
  });

  it('clearSharedCache should use prefixed paths for multidev', async () => {
    process.env.PANTHEON_ENVIRONMENT = 'pr-99';
    mockBucket.getFiles.mockResolvedValue([[]]);

    await clearSharedCache();

    expect(mockBucket.getFiles).toHaveBeenCalledWith({ prefix: 'environments/pr-99/fetch-cache/' });
    expect(mockBucket.getFiles).toHaveBeenCalledWith({ prefix: 'environments/pr-99/route-cache/' });
    expect(mockBucket.file).toHaveBeenCalledWith('environments/pr-99/cache/tags/tags.json');
  });

  it('clearSharedCache should use unprefixed paths for live', async () => {
    process.env.PANTHEON_ENVIRONMENT = 'live';
    mockBucket.getFiles.mockResolvedValue([[]]);

    await clearSharedCache();

    expect(mockBucket.getFiles).toHaveBeenCalledWith({ prefix: 'fetch-cache/' });
    expect(mockBucket.getFiles).toHaveBeenCalledWith({ prefix: 'route-cache/' });
    expect(mockBucket.file).toHaveBeenCalledWith('cache/tags/tags.json');
  });
});

describe('GCS getSharedCacheStats', () => {
  let originalCacheBucket: string | undefined;

  beforeEach(() => {
    originalCacheBucket = process.env.CACHE_BUCKET;
    process.env.CACHE_BUCKET = 'test-bucket';
    vi.clearAllMocks();
    resetGcsSharedState();
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
    resetGcsSharedState();
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

describe('GcsCacheHandler tags mapping writes', () => {
  let originalCacheBucket: string | undefined;
  let originalProxyEndpoint: string | undefined;

  beforeEach(() => {
    originalCacheBucket = process.env.CACHE_BUCKET;
    originalProxyEndpoint = process.env.OUTBOUND_PROXY_ENDPOINT;

    process.env.CACHE_BUCKET = 'test-bucket';
    delete process.env.OUTBOUND_PROXY_ENDPOINT;

    vi.clearAllMocks();
    resetGcsSharedState();
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(Math, 'random').mockReturnValue(0); // no interval jitter: tests advance exact intervals

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

    if (originalProxyEndpoint !== undefined) {
      process.env.OUTBOUND_PROXY_ENDPOINT = originalProxyEndpoint;
    } else {
      delete process.env.OUTBOUND_PROXY_ENDPOINT;
    }
  });

  async function setWithTags(handler: GcsCacheHandler, key: string, tags: string[]) {
    await handler.set(key, { kind: 'FETCH' as const } as any, { tags });
  }

  it('shares one buffer across handler instances and writes once per interval', async () => {
    // Next.js constructs a handler per request; the write pacing must be per process.
    const handler1 = new GcsCacheHandler({} as any);
    const handler2 = new GcsCacheHandler({} as any);

    await setWithTags(handler1, 'key1', ['posts']);
    await setWithTags(handler2, 'key2', ['posts']);
    expect(tagsMappingSaves()).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(DEFAULT_TAGS_FLUSH_INTERVAL_MS + 100);

    const saves = tagsMappingSaves();
    expect(saves).toHaveLength(1);
    expect(JSON.parse(saves[0][0] as string)).toEqual({ posts: ['key1', 'key2'] });
  });

  it('writes with ifGenerationMatch from the generation it read', async () => {
    mockFile.getMetadata.mockResolvedValue([{ generation: '77' }]);

    const handler = new GcsCacheHandler({} as any);
    await setWithTags(handler, 'key1', ['posts']);
    await vi.advanceTimersByTimeAsync(DEFAULT_TAGS_FLUSH_INTERVAL_MS + 100);

    // The download is pinned to the generation whose metadata was read.
    expect(mockBucket.file).toHaveBeenCalledWith('cache/tags/tags.json', { generation: '77' });
    const [, options] = tagsMappingSaves()[0];
    expect(options).toMatchObject({ resumable: false, preconditionOpts: { ifGenerationMatch: '77' } });
  });

  it('creates the tags mapping with ifGenerationMatch 0 when it does not exist', async () => {
    mockFile.getMetadata.mockRejectedValue(Object.assign(new Error('Not Found'), { code: 404 }));

    const handler = new GcsCacheHandler({} as any);
    await setWithTags(handler, 'key1', ['posts']);
    await vi.advanceTimersByTimeAsync(DEFAULT_TAGS_FLUSH_INTERVAL_MS + 100);

    const [data, options] = tagsMappingSaves()[0];
    expect(JSON.parse(data as string)).toEqual({ posts: ['key1'] });
    expect(options).toMatchObject({ preconditionOpts: { ifGenerationMatch: 0 } });
  });

  it('flushes inline from set() once the interval has elapsed', async () => {
    const handler = new GcsCacheHandler({} as any);
    await setWithTags(handler, 'key1', ['posts']);
    expect(tagsMappingSaves()).toHaveLength(0);

    // Move the clock without firing timers: the request itself must do the flush.
    vi.setSystemTime(Date.now() + DEFAULT_TAGS_FLUSH_INTERVAL_MS + 1);
    await setWithTags(handler, 'key2', ['posts']);

    const saves = tagsMappingSaves();
    expect(saves).toHaveLength(1);
    expect(JSON.parse(saves[0][0] as string)).toEqual({ posts: ['key1', 'key2'] });
  });

  it('does not rewrite the mapping when it already contains the key', async () => {
    mockFile.download.mockResolvedValue([Buffer.from(JSON.stringify({ posts: ['key1'] }))]);

    const handler = new GcsCacheHandler({} as any);
    await setWithTags(handler, 'key1', ['posts']);
    await vi.advanceTimersByTimeAsync(DEFAULT_TAGS_FLUSH_INTERVAL_MS + 100);

    expect(mockFile.getMetadata).toHaveBeenCalled();
    expect(tagsMappingSaves()).toHaveLength(0);
  });

  it('revalidateTag reads the mapping without writing it', async () => {
    mockFile.download.mockResolvedValue([Buffer.from(JSON.stringify({ posts: ['key1'] }))]);

    const handler = new GcsCacheHandler({} as any);
    await setWithTags(handler, 'key2', ['posts']);
    await handler.revalidateTag('posts');

    expect(mockFile.getMetadata).toHaveBeenCalled();
    expect(tagsMappingSaves()).toHaveLength(0);
  });

  it('revalidateTag sees queued updates before they are flushed', async () => {
    process.env.OUTBOUND_PROXY_ENDPOINT = 'proxy.example.com:8080';
    vi.mocked(fetch).mockResolvedValue({ ok: true, status: 200 } as Response);

    const handler = new GcsCacheHandler({} as any);
    await setWithTags(handler, '/blogs/new', ['posts']);
    await handler.revalidateTag('posts');
    await vi.advanceTimersByTimeAsync(10);

    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining(`/paths/${encodeURIComponent(encodeURIComponent('blogs/new'))}`),
      expect.objectContaining({ method: 'DELETE' })
    );
    expect(tagsMappingSaves()).toHaveLength(0);
  });

  it('retries a rate-limited write with backoff and keeps the updates', async () => {
    let tagsAttempts = 0;
    mockFile.save.mockImplementation(async (data: string) => {
      const parsed = JSON.parse(data);
      if ('lastModified' in parsed || 'buildId' in parsed) return;
      if (tagsAttempts++ === 0) {
        throw Object.assign(new Error('rateLimitExceeded'), { code: 429 });
      }
    });

    const handler = new GcsCacheHandler({} as any);
    await setWithTags(handler, 'key1', ['posts']);
    await vi.advanceTimersByTimeAsync(DEFAULT_TAGS_FLUSH_INTERVAL_MS + 100);

    expect(tagsMappingSaves()).toHaveLength(1);
    expect(console.warn).toHaveBeenCalledTimes(1);
    expect(vi.mocked(console.warn).mock.calls[0][0]).toContain('rate limited (429)');

    // Backoff after one failure is at most twice the interval.
    await vi.advanceTimersByTimeAsync(DEFAULT_TAGS_FLUSH_INTERVAL_MS * 2 + 100);

    const saves = tagsMappingSaves();
    expect(saves).toHaveLength(2);
    expect(JSON.parse(saves[1][0] as string)).toEqual({ posts: ['key1'] });
  });

  it('flushGcsTagsMapping writes pending updates immediately (manual shutdown hook)', async () => {
    const handler = new GcsCacheHandler({} as any);
    await setWithTags(handler, 'key1', ['posts']);
    expect(tagsMappingSaves()).toHaveLength(0);

    expect(await flushGcsTagsMapping()).toBe(1);

    const saves = tagsMappingSaves();
    expect(saves).toHaveLength(1);
    expect(JSON.parse(saves[0][0] as string)).toEqual({ posts: ['key1'] });

    // Nothing pending any more: reports 0 and writes nothing.
    expect(await flushGcsTagsMapping()).toBe(0);
    expect(tagsMappingSaves()).toHaveLength(1);
  });

  it('flushGcsTagsMapping keeps retrying a rate-limited write until the deadline', async () => {
    let tagsAttempts = 0;
    mockFile.save.mockImplementation(async (data: string) => {
      const parsed = JSON.parse(data);
      if ('lastModified' in parsed || 'buildId' in parsed) return;
      if (tagsAttempts++ < 2) {
        throw Object.assign(new Error('rateLimitExceeded'), { code: 429 });
      }
    });

    const handler = new GcsCacheHandler({} as any);
    await setWithTags(handler, 'key1', ['posts']);

    const flushing = flushGcsTagsMapping({ timeoutMs: 8000 });
    await vi.advanceTimersByTimeAsync(3500); // two ~1s retry waits
    expect(await flushing).toBe(1);
    expect(tagsMappingSaves()).toHaveLength(3);
  });

  it('flushGcsTagsMapping gives up at the deadline and warns about what is still pending', async () => {
    mockFile.save.mockImplementation(async (data: string) => {
      const parsed = JSON.parse(data);
      if ('lastModified' in parsed || 'buildId' in parsed) return;
      throw Object.assign(new Error('rateLimitExceeded'), { code: 429 });
    });

    const handler = new GcsCacheHandler({} as any);
    await setWithTags(handler, 'key1', ['posts']);

    const flushing = flushGcsTagsMapping({ timeoutMs: 2500 });
    await vi.advanceTimersByTimeAsync(4000);
    expect(await flushing).toBe(0);
    const warned = vi
      .mocked(console.warn)
      .mock.calls.some(([m]) => String(m).includes('still pending at the deadline'));
    expect(warned).toBe(true);
  });

  it('uses a separate storage client for the tags mapping that does not retry 429s itself', async () => {
    storageConstructorOptions.length = 0;

    const handler = new GcsCacheHandler({} as any);
    await setWithTags(handler, 'key1', ['posts']);

    // One client for unconditional entry writes, one for conditional tag writes.
    expect(storageConstructorOptions).toHaveLength(2);
    const tagsOptions = storageConstructorOptions.find(
      (o) => (o as { retryOptions?: unknown } | undefined)?.retryOptions !== undefined
    ) as { retryOptions: { retryableErrorFn: (err: { code?: number }) => boolean } };
    expect(tagsOptions).toBeDefined();
    expect(tagsOptions.retryOptions.retryableErrorFn({ code: 429 })).toBe(false);
    expect(tagsOptions.retryOptions.retryableErrorFn({ code: 503 })).toBe(true);
    expect(tagsOptions.retryOptions.retryableErrorFn({ code: 412 })).toBe(false);
  });

  it('replaces an unparseable mapping instead of failing forever', async () => {
    mockFile.getMetadata.mockResolvedValue([{ generation: '5' }]);
    mockFile.download.mockResolvedValue([Buffer.from('{not json')]);

    const handler = new GcsCacheHandler({} as any);
    await setWithTags(handler, 'key1', ['posts']);
    await vi.advanceTimersByTimeAsync(DEFAULT_TAGS_FLUSH_INTERVAL_MS + 100);

    const saves = tagsMappingSaves();
    expect(saves).toHaveLength(1);
    expect(JSON.parse(saves[0][0] as string)).toEqual({ posts: ['key1'] });
    expect(saves[0][1]).toMatchObject({ preconditionOpts: { ifGenerationMatch: '5' } });
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('not valid JSON'), expect.anything());
  });

  it('does not wipe the mapping when the read fails', async () => {
    mockFile.getMetadata.mockRejectedValue(Object.assign(new Error('Service Unavailable'), { code: 503 }));

    const handler = new GcsCacheHandler({} as any);
    await setWithTags(handler, 'key1', ['posts']);
    await vi.advanceTimersByTimeAsync(DEFAULT_TAGS_FLUSH_INTERVAL_MS + 100);

    // No write of a pending-only mapping; the update stays queued for the retry.
    expect(tagsMappingSaves()).toHaveLength(0);
    mockFile.getMetadata.mockResolvedValue([{ generation: '1' }]);
    await vi.advanceTimersByTimeAsync(DEFAULT_TAGS_FLUSH_INTERVAL_MS * 2 + 100);
    expect(tagsMappingSaves()).toHaveLength(1);
  });
});

describe('GcsCacheHandler build invalidation on a cold start', () => {
  let originalCacheBucket: string | undefined;

  beforeEach(() => {
    originalCacheBucket = process.env.CACHE_BUCKET;
    process.env.CACHE_BUCKET = 'test-bucket';
    delete process.env.OUTBOUND_PROXY_ENDPOINT;
    vi.clearAllMocks();
    resetGcsSharedState();
    resetBuildInvalidationCheck();

    mockFile.exists.mockResolvedValue([true]);
    mockFile.save.mockResolvedValue(undefined);
    mockFile.getMetadata.mockResolvedValue([{ generation: '1' }]);
    mockFile.download.mockResolvedValue([Buffer.from(JSON.stringify({ buildId: 'old-build', timestamp: 1 }))]);
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
  });

  it('runs the check once even when several handlers are constructed concurrently', async () => {
    new GcsCacheHandler({} as any);
    new GcsCacheHandler({} as any);
    new GcsCacheHandler({} as any);
    await new Promise((r) => setTimeout(r, 50));

    const routeCacheWipes = mockBucket.getFiles.mock.calls.filter(([args]) => args.prefix === 'route-cache/');
    expect(routeCacheWipes).toHaveLength(1);
  });
});
