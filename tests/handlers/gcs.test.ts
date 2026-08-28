import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock file and bucket stored in globalThis for access
const mockFile = {
  exists: vi.fn(),
  download: vi.fn(),
  save: vi.fn(),
  delete: vi.fn(),
  getMetadata: vi.fn(),
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
import { resetBuildInvalidationCheck } from '../../src/handlers/base.js';

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
    // Distinct generation per call so the tags-manifest read never short-circuits
    // on "unchanged" unless a test deliberately pins it.
    let generation = 0;
    mockFile.getMetadata.mockImplementation(() => Promise.resolve([{ generation: String(++generation) }]));
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

      // Verify edge cache was cleared for the route path (single-encoded)
      expect(fetch).toHaveBeenCalledWith(
        expect.stringContaining(`/paths/${encodeURIComponent('/blogs/my-post')}`),
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

      // Should convert underscores to slashes and single-encode
      expect(fetch).toHaveBeenCalledWith(
        expect.stringContaining(`/paths/${encodeURIComponent('/blogs/my-post')}`),
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

    it('persists the tag staleness update to the shared store (not just the in-memory tagsManifest)', async () => {
      mockFile.exists.mockResolvedValue([true]);
      mockFile.download.mockResolvedValue([Buffer.from('{}')]);

      const handler = new GcsCacheHandler({} as any);
      const saveCallsBefore = mockFile.save.mock.calls.length;

      await handler.revalidateTag('shared-posts');

      // revalidateTag's shared-manifest persistence (updateTagsManifest) is
      // what makes the invalidation visible to another replica -- this is the
      // write half of that fix; confirms it actually runs rather
      // than only updating the process-local Map.
      expect(mockFile.save.mock.calls.length).toBeGreaterThan(saveCallsBefore);
    });

    it('writes the shared manifest under a generation precondition so a concurrent replica cannot be clobbered', async () => {
      mockFile.exists.mockResolvedValue([true]);
      mockFile.download.mockResolvedValue([Buffer.from('{}')]);
      mockFile.getMetadata.mockResolvedValue([{ generation: '17' }]);

      const handler = new GcsCacheHandler({} as any);
      await handler.revalidateTag('posts');

      const manifestSave = mockFile.save.mock.calls.find((call) => call[1]?.preconditionOpts !== undefined);
      expect(manifestSave).toBeDefined();
      expect(manifestSave![1].preconditionOpts).toEqual({ ifGenerationMatch: 17 });
    });

    it('re-reads and retries the manifest write when it loses a generation race (412)', async () => {
      mockFile.exists.mockResolvedValue([true]);
      mockFile.download.mockResolvedValue([Buffer.from('{}')]);
      mockFile.getMetadata.mockResolvedValue([{ generation: '5' }]);

      const preconditionFailed = Object.assign(new Error('Precondition Failed'), { code: 412 });
      let manifestSaves = 0;
      mockFile.save.mockImplementation((_data: string, opts?: any) => {
        if (opts?.preconditionOpts === undefined) {
          return Promise.resolve(undefined);
        }
        manifestSaves++;
        // Lose the race once, then succeed.
        return manifestSaves === 1 ? Promise.reject(preconditionFailed) : Promise.resolve(undefined);
      });

      const handler = new GcsCacheHandler({} as any);
      await handler.revalidateTag('posts');

      expect(manifestSaves).toBe(2);
    });

    it('does not overwrite the shared manifest when it cannot be read first', async () => {
      // A read failure that isn't a 404 must abort the write -- writing a record
      // built from `{}` would drop every other replica's tags from the manifest.
      mockFile.exists.mockResolvedValue([true]);
      mockFile.download.mockResolvedValue([Buffer.from('{}')]);
      mockFile.getMetadata.mockRejectedValue(Object.assign(new Error('500 Internal'), { code: 500 }));

      const handler = new GcsCacheHandler({} as any);
      // revalidateTag swallows and warns rather than failing the caller.
      await expect(handler.revalidateTag('posts')).resolves.not.toThrow();

      const manifestSave = mockFile.save.mock.calls.find((call) => call[1]?.preconditionOpts !== undefined);
      expect(manifestSave).toBeUndefined();
    });

    it('creates the manifest with ifGenerationMatch: 0 when it does not exist yet', async () => {
      mockFile.exists.mockResolvedValue([true]);
      mockFile.download.mockResolvedValue([Buffer.from('{}')]);
      mockFile.getMetadata.mockRejectedValue(Object.assign(new Error('Not Found'), { code: 404 }));

      const handler = new GcsCacheHandler({} as any);
      await handler.revalidateTag('posts');

      const manifestSave = mockFile.save.mock.calls.find((call) => call[1]?.preconditionOpts !== undefined);
      expect(manifestSave![1].preconditionOpts).toEqual({ ifGenerationMatch: 0 });
    });

    it('skips re-downloading the manifest body when its GCS generation is unchanged', async () => {
      // The manifest is pulled on the get() path for the life of the replica and
      // grows with the number of distinct tags a site revalidates, so the
      // steady-state cost must be one metadata call, not a full download.
      mockFile.exists.mockResolvedValue([false]);
      mockFile.getMetadata.mockResolvedValue([{ generation: '42' }]);
      mockFile.download.mockResolvedValue([Buffer.from('{"some-tag":{"expired":1}}')]);

      const handler = new GcsCacheHandler({} as any);

      // First get(): cold instance, must transfer the body.
      await handler.get('key-a');
      const downloadsAfterFirst = mockFile.download.mock.calls.length;
      expect(downloadsAfterFirst).toBeGreaterThan(0);

      // Move past the throttle window; the generation is still 42.
      vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 10_000);
      await handler.get('key-b');
      // Let the background refresh settle.
      await new Promise((r) => setTimeout(r, 10));

      const manifestDownloads = mockFile.download.mock.calls.length - downloadsAfterFirst;
      // The only downloads in this window would be the cache entry itself,
      // which misses (exists: false) and so never downloads at all.
      expect(manifestDownloads).toBe(0);
      // ...but the cheap metadata check did run.
      expect(mockFile.getMetadata.mock.calls.length).toBeGreaterThan(1);
    });

    it('does no shared-manifest I/O during the build phase', async () => {
      // An unguarded blocking GCS call on a prerender path is what trips
      // cacheComponents' "uncached data outside <Suspense>" -- and
      // there is no other replica to inform during a build anyway.
      process.env.NEXT_PHASE = 'phase-production-build';
      try {
        mockFile.exists.mockResolvedValue([true]);
        mockFile.download.mockResolvedValue([Buffer.from('{}')]);

        const handler = new GcsCacheHandler({} as any);
        await handler.revalidateTag('posts');

        const manifestSave = mockFile.save.mock.calls.find((call) => call[1]?.preconditionOpts !== undefined);
        expect(manifestSave).toBeUndefined();
      } finally {
        delete process.env.NEXT_PHASE;
      }
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

    it('still clears the edge cache by tag when the tags mapping lists no keys', async () => {
      process.env.OUTBOUND_PROXY_ENDPOINT = 'proxy.example.com:8080';

      // An empty mapping for the tag is exactly the case a lost/unflushed
      // mapping write produces on another replica -- the CDN is still holding
      // the stale response under that surrogate key, so the purge must run.
      mockFile.exists.mockResolvedValue([true]);
      mockFile.download.mockResolvedValue([Buffer.from('{}')]);

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

    mockFile.exists.mockResolvedValue([false]);
    mockFile.save.mockResolvedValue(undefined);
    mockFile.download.mockResolvedValue([Buffer.from('{}')]);
    mockFile.delete.mockResolvedValue(undefined);
    // Distinct generation per call so the tags-manifest read never short-circuits
    // on "unchanged" unless a test deliberately pins it.
    let generation = 0;
    mockFile.getMetadata.mockImplementation(() => Promise.resolve([{ generation: String(++generation) }]));
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

    new GcsCacheHandler({} as any);
    await new Promise((r) => setTimeout(r, 10));

    expect(mockBucket.file).toHaveBeenCalledWith('environments/pr-42/cache/tags/tags.json');
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

    mockFile.exists.mockResolvedValue([false]);
    mockFile.save.mockResolvedValue(undefined);
    mockFile.download.mockResolvedValue([Buffer.from('{}')]);
    mockFile.delete.mockResolvedValue(undefined);
    // Distinct generation per call so the tags-manifest read never short-circuits
    // on "unchanged" unless a test deliberately pins it.
    let generation = 0;
    mockFile.getMetadata.mockImplementation(() => Promise.resolve([{ generation: String(++generation) }]));
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
