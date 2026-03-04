import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EdgeCacheClear, createEdgeCacheClearer } from '../../src/edge/edge-cache-clear.js';
import { clearEdgeCachePaths, clearEdgeCache } from '../../src/index.js';

describe('EdgeCacheClear', () => {
  const mockEndpoint = 'proxy.example.com:8080';
  let originalEnv: string | undefined;

  beforeEach(() => {
    originalEnv = process.env.OUTBOUND_PROXY_ENDPOINT;
    process.env.OUTBOUND_PROXY_ENDPOINT = mockEndpoint;
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.OUTBOUND_PROXY_ENDPOINT = originalEnv;
    } else {
      delete process.env.OUTBOUND_PROXY_ENDPOINT;
    }
    vi.restoreAllMocks();
  });

  describe('constructor', () => {
    it('should throw if OUTBOUND_PROXY_ENDPOINT is not set', () => {
      delete process.env.OUTBOUND_PROXY_ENDPOINT;
      expect(() => new EdgeCacheClear()).toThrow('OUTBOUND_PROXY_ENDPOINT environment variable is required');
    });

    it('should use provided endpoint over environment variable', () => {
      const customEndpoint = 'custom.proxy.com:9000';
      const clearer = new EdgeCacheClear(customEndpoint);
      // Verify it was constructed (no throw)
      expect(clearer).toBeInstanceOf(EdgeCacheClear);
    });
  });

  describe('nukeCache', () => {
    it('should make DELETE request to base cache URL', async () => {
      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        status: 200,
      } as Response);

      const clearer = new EdgeCacheClear();
      const result = await clearer.nukeCache();

      expect(fetch).toHaveBeenCalledWith(
        `http://${mockEndpoint}/rest/v0alpha1/cache`,
        expect.objectContaining({
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
        })
      );
      expect(result.success).toBe(true);
      expect(result.statusCode).toBe(200);
    });

    it('should return failure on HTTP error', async () => {
      vi.mocked(fetch).mockResolvedValue({
        ok: false,
        status: 500,
        text: () => Promise.resolve('Internal Server Error'),
      } as Response);

      const clearer = new EdgeCacheClear();
      const result = await clearer.nukeCache();

      expect(result.success).toBe(false);
      expect(result.statusCode).toBe(500);
      expect(result.error).toContain('500');
    });

    it('should return failure on network error', async () => {
      vi.mocked(fetch).mockRejectedValue(new Error('Network error'));

      const clearer = new EdgeCacheClear();
      const result = await clearer.nukeCache();

      expect(result.success).toBe(false);
      expect(result.error).toBe('Network error');
    });

    it('should include duration in result', async () => {
      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        status: 200,
      } as Response);

      const clearer = new EdgeCacheClear();
      const result = await clearer.nukeCache();

      expect(result.duration).toBeDefined();
      expect(result.duration).toBeGreaterThanOrEqual(0);
    });
  });

  describe('clearPaths', () => {
    it('should return success immediately for empty paths array', async () => {
      const clearer = new EdgeCacheClear();
      const result = await clearer.clearPaths([]);

      expect(fetch).not.toHaveBeenCalled();
      expect(result.success).toBe(true);
      expect(result.paths).toEqual([]);
    });

    it('should make DELETE request for each path', async () => {
      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        status: 200,
      } as Response);

      const clearer = new EdgeCacheClear();
      const result = await clearer.clearPaths(['/blog', '/about']);

      expect(fetch).toHaveBeenCalledTimes(2);
      expect(fetch).toHaveBeenCalledWith(
        `http://${mockEndpoint}/rest/v0alpha1/cache/paths/blog`,
        expect.objectContaining({ method: 'DELETE' })
      );
      expect(fetch).toHaveBeenCalledWith(
        `http://${mockEndpoint}/rest/v0alpha1/cache/paths/about`,
        expect.objectContaining({ method: 'DELETE' })
      );
      expect(result.success).toBe(true);
      expect(result.paths).toEqual(['/blog', '/about']);
    });

    it('should normalize paths without leading slash', async () => {
      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        status: 200,
      } as Response);

      const clearer = new EdgeCacheClear();
      await clearer.clearPaths(['blog/post']);

      expect(fetch).toHaveBeenCalledWith(
        `http://${mockEndpoint}/rest/v0alpha1/cache/paths/blog/post`,
        expect.any(Object)
      );
    });

    it('should double-encode root path / as %252F', async () => {
      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        status: 200,
      } as Response);

      const clearer = new EdgeCacheClear();
      const result = await clearer.clearPaths(['/']);

      expect(fetch).toHaveBeenCalledTimes(1);
      expect(fetch).toHaveBeenCalledWith(
        `http://${mockEndpoint}/rest/v0alpha1/cache/paths/%252F`,
        expect.objectContaining({ method: 'DELETE' })
      );
      expect(result.success).toBe(true);
      expect(result.paths).toEqual(['/']);
    });

    it('should handle partial failures', async () => {
      vi.mocked(fetch)
        .mockResolvedValueOnce({ ok: true, status: 200 } as Response)
        .mockResolvedValueOnce({ ok: false, status: 404 } as Response);

      const clearer = new EdgeCacheClear();
      const result = await clearer.clearPaths(['/path1', '/path2']);

      expect(result.success).toBe(true); // At least one succeeded
      expect(result.paths).toEqual(['/path1']);
    });
  });

  describe('clearPath', () => {
    it('should delegate to clearPaths with single path', async () => {
      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        status: 200,
      } as Response);

      const clearer = new EdgeCacheClear();
      const result = await clearer.clearPath('/single');

      expect(fetch).toHaveBeenCalledTimes(1);
      expect(result.paths).toEqual(['/single']);
    });
  });

  describe('clearKeys', () => {
    it('should return success immediately for empty keys array', async () => {
      const clearer = new EdgeCacheClear();
      const result = await clearer.clearKeys([]);

      expect(fetch).not.toHaveBeenCalled();
      expect(result.success).toBe(true);
    });

    it('should make DELETE request for each key', async () => {
      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        status: 200,
      } as Response);

      const clearer = new EdgeCacheClear();
      const result = await clearer.clearKeys(['tag1', 'tag2']);

      expect(fetch).toHaveBeenCalledTimes(2);
      expect(fetch).toHaveBeenCalledWith(
        `http://${mockEndpoint}/rest/v0alpha1/cache/keys/tag1`,
        expect.objectContaining({ method: 'DELETE' })
      );
      expect(fetch).toHaveBeenCalledWith(
        `http://${mockEndpoint}/rest/v0alpha1/cache/keys/tag2`,
        expect.objectContaining({ method: 'DELETE' })
      );
      expect(result.success).toBe(true);
    });

    it('should URL-encode special characters in keys', async () => {
      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        status: 200,
      } as Response);

      const clearer = new EdgeCacheClear();
      await clearer.clearKeys(['tag/with/slashes']);

      expect(fetch).toHaveBeenCalledWith(
        `http://${mockEndpoint}/rest/v0alpha1/cache/keys/${encodeURIComponent('tag/with/slashes')}`,
        expect.any(Object)
      );
    });
  });

  describe('background methods', () => {
    it('clearPathsInBackground should not throw', async () => {
      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        status: 200,
      } as Response);

      const clearer = new EdgeCacheClear();
      expect(() => clearer.clearPathsInBackground(['/path'], 'test')).not.toThrow();
    });

    it('clearPathInBackground should delegate to clearPathsInBackground', async () => {
      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        status: 200,
      } as Response);

      const clearer = new EdgeCacheClear();
      clearer.clearPathInBackground('/single-path', 'ISR update');

      // Wait for background operation
      await new Promise((r) => setTimeout(r, 50));

      expect(fetch).toHaveBeenCalledWith(
        expect.stringContaining('/paths/single-path'),
        expect.objectContaining({ method: 'DELETE' })
      );
    });

    it('clearKeysInBackground should not throw', async () => {
      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        status: 200,
      } as Response);

      const clearer = new EdgeCacheClear();
      expect(() => clearer.clearKeysInBackground(['key'], 'test')).not.toThrow();
    });

    it('nukeCacheInBackground should not throw', async () => {
      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        status: 200,
      } as Response);

      const clearer = new EdgeCacheClear();
      expect(() => clearer.nukeCacheInBackground('test')).not.toThrow();
    });

    it('clearPathsInBackground should do nothing for empty array', () => {
      const clearer = new EdgeCacheClear();
      clearer.clearPathsInBackground([], 'test');
      expect(fetch).not.toHaveBeenCalled();
    });

    it('clearKeysInBackground should do nothing for empty array', () => {
      const clearer = new EdgeCacheClear();
      clearer.clearKeysInBackground([], 'test');
      expect(fetch).not.toHaveBeenCalled();
    });
  });
});

describe('createEdgeCacheClearer', () => {
  let originalEnv: string | undefined;

  beforeEach(() => {
    originalEnv = process.env.OUTBOUND_PROXY_ENDPOINT;
  });

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.OUTBOUND_PROXY_ENDPOINT = originalEnv;
    } else {
      delete process.env.OUTBOUND_PROXY_ENDPOINT;
    }
  });

  it('should return EdgeCacheClear instance when endpoint is configured', () => {
    process.env.OUTBOUND_PROXY_ENDPOINT = 'proxy.example.com:8080';
    const clearer = createEdgeCacheClearer();
    expect(clearer).toBeInstanceOf(EdgeCacheClear);
  });

  it('should return null when endpoint is not configured', () => {
    delete process.env.OUTBOUND_PROXY_ENDPOINT;
    const clearer = createEdgeCacheClearer();
    expect(clearer).toBeNull();
  });
});

describe('clearEdgeCachePaths', () => {
  let originalEnv: string | undefined;

  beforeEach(() => {
    originalEnv = process.env.OUTBOUND_PROXY_ENDPOINT;
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.OUTBOUND_PROXY_ENDPOINT = originalEnv;
    } else {
      delete process.env.OUTBOUND_PROXY_ENDPOINT;
    }
    vi.restoreAllMocks();
  });

  it('should make DELETE request to proxy when env var is set', async () => {
    process.env.OUTBOUND_PROXY_ENDPOINT = 'proxy.example.com:8080';
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      status: 200,
    } as Response);

    const result = await clearEdgeCachePaths(['/']);

    expect(fetch).toHaveBeenCalledWith(
      'http://proxy.example.com:8080/rest/v0alpha1/cache/paths/%252F',
      expect.objectContaining({ method: 'DELETE' })
    );
    expect(result).not.toBeNull();
    expect(result!.success).toBe(true);
  });

  it('should return null when env var is missing', async () => {
    delete process.env.OUTBOUND_PROXY_ENDPOINT;

    const result = await clearEdgeCachePaths(['/']);

    expect(fetch).not.toHaveBeenCalled();
    expect(result).toBeNull();
  });
});

describe('clearEdgeCache', () => {
  let originalEnv: string | undefined;

  beforeEach(() => {
    originalEnv = process.env.OUTBOUND_PROXY_ENDPOINT;
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.OUTBOUND_PROXY_ENDPOINT = originalEnv;
    } else {
      delete process.env.OUTBOUND_PROXY_ENDPOINT;
    }
    vi.restoreAllMocks();
  });

  it('should call nukeCache when configured', async () => {
    process.env.OUTBOUND_PROXY_ENDPOINT = 'proxy.example.com:8080';
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      status: 200,
    } as Response);

    const result = await clearEdgeCache();

    expect(fetch).toHaveBeenCalledWith(
      'http://proxy.example.com:8080/rest/v0alpha1/cache',
      expect.objectContaining({ method: 'DELETE' })
    );
    expect(result).not.toBeNull();
    expect(result!.success).toBe(true);
  });

  it('should return null when env var is missing', async () => {
    delete process.env.OUTBOUND_PROXY_ENDPOINT;

    const result = await clearEdgeCache();

    expect(fetch).not.toHaveBeenCalled();
    expect(result).toBeNull();
  });
});
