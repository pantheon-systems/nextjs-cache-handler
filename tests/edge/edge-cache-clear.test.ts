import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EdgeCacheClear, createEdgeCacheClearer, settledWithin } from '../../src/edge/edge-cache-clear.js';
import { resetPurgeQueuesForTests } from '../../src/edge/purge-queue.js';
import { clearEdgeCachePaths, clearEdgeCache } from '../../src/index.js';
import { resetSiteUrlConfigForTests } from '../../src/utils/site-urls.js';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

describe('EdgeCacheClear', () => {
  const mockEndpoint = 'proxy.example.com:8080';
  let originalEnv: string | undefined;

  beforeEach(() => {
    originalEnv = process.env.OUTBOUND_PROXY_ENDPOINT;
    process.env.OUTBOUND_PROXY_ENDPOINT = mockEndpoint;
    resetPurgeQueuesForTests();
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
      vi.mocked(fetch).mockResolvedValue(new Response('Internal Server Error', { status: 500 }));

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
    it('sends each path once per call (`a` and `/a` alike), but keeps `/a/` apart', async () => {
      vi.mocked(fetch).mockResolvedValue({ ok: true, status: 200 } as Response);

      const result = await new EdgeCacheClear().clearPaths(['a', '/a', '/a/', '/a', '/b']);

      expect(vi.mocked(fetch).mock.calls.map(([url]) => String(url))).toEqual([
        `http://${mockEndpoint}/rest/v0alpha1/cache/paths/a`,
        `http://${mockEndpoint}/rest/v0alpha1/cache/paths/a%252F`,
        `http://${mockEndpoint}/rest/v0alpha1/cache/paths/b`,
      ]);
      expect(result.paths).toEqual(['a', '/a/', '/b']);
    });

    it('still rejects an empty path rather than treating it as `/`', async () => {
      vi.mocked(fetch).mockResolvedValue({ ok: true, status: 200 } as Response);

      const result = await new EdgeCacheClear().clearPaths(['', '/']);

      expect(vi.mocked(fetch).mock.calls.map(([url]) => String(url))).toEqual([
        `http://${mockEndpoint}/rest/v0alpha1/cache/paths/%252F`,
      ]);
      expect(result.paths).toEqual(['/']);
    });

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

      // Double-encoded: blog/post -> blog%2Fpost -> blog%252Fpost
      expect(fetch).toHaveBeenCalledWith(
        `http://${mockEndpoint}/rest/v0alpha1/cache/paths/${encodeURIComponent(encodeURIComponent('blog/post'))}`,
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

    it('keeps a trailing slash, the URL a trailingSlash site serves', async () => {
      vi.mocked(fetch).mockResolvedValue({ ok: true, status: 200 } as Response);

      await new EdgeCacheClear().clearPaths(['/tags/']);

      expect(fetch).toHaveBeenCalledWith(
        `http://${mockEndpoint}/rest/v0alpha1/cache/paths/${encodeURIComponent(encodeURIComponent('tags/'))}`,
        expect.any(Object)
      );
    });

    it('does not send a path with control characters or over the length limit', async () => {
      vi.mocked(fetch).mockResolvedValue({ ok: true, status: 200 } as Response);

      const result = await new EdgeCacheClear().clearPaths(['/ok', '/bad\npath', `/${'a'.repeat(2048)}`]);

      expect(fetch).toHaveBeenCalledTimes(1);
      expect(result.paths).toEqual(['/ok']);
    });

    it('pins what is sent for paths with spaces, query marks and tag-shaped values', async () => {
      vi.mocked(fetch).mockResolvedValue({ ok: true, status: 200 } as Response);

      await new EdgeCacheClear().clearPaths(['/node/998', '/a b', '/what?', '_N_T_/blog']);

      // Encoded twice, without the leading slash. The outbound proxy escapes the segment once
      // more before the gateway (`url.PathEscape` in tenant-outbound-proxy's DeleteCachePath),
      // which is where the third level seen in its logs (%25252F) comes from.
      const sent = vi.mocked(fetch).mock.calls.map(([url]) => String(url).split('/cache/paths/')[1]);
      expect(sent).toEqual(['node%252F998', 'a%2520b', 'what%253F', '_N_T_%252Fblog']);
    });

    describe('over CACHE_PURGE_MAX_PATHS', () => {
      let warn: ReturnType<typeof vi.spyOn>;

      beforeEach(() => {
        warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        vi.mocked(fetch).mockResolvedValue({ ok: true, status: 200 } as Response);
      });

      afterEach(() => {
        delete process.env.CACHE_PURGE_MAX_PATHS;
      });

      const manyPaths = (count: number) => Array.from({ length: count }, (_, i) => `/p/${i}`);

      it('sends one full purge instead of the paths, and says so', async () => {
        const result = await new EdgeCacheClear().clearPaths(manyPaths(201));

        expect(fetch).toHaveBeenCalledTimes(1);
        expect(fetch).toHaveBeenCalledWith(`http://${mockEndpoint}/rest/v0alpha1/cache`, expect.anything());
        expect(result).toMatchObject({ success: true, paths: [], fullPurge: true });
        expect(warn).toHaveBeenCalledWith(
          '[EdgeCacheClear] One purge added 201 paths, over CACHE_PURGE_MAX_PATHS (200): ' +
            'purging the whole edge cache instead'
        );
      });

      it('sends exactly the limit by path', async () => {
        const result = await new EdgeCacheClear().clearPaths(manyPaths(200));

        expect(fetch).toHaveBeenCalledTimes(200);
        expect(result.fullPurge).toBeUndefined();
        expect(warn).not.toHaveBeenCalled();
      });

      it('counts each path once', async () => {
        const result = await new EdgeCacheClear().clearPaths([...manyPaths(200), ...manyPaths(200)]);

        expect(fetch).toHaveBeenCalledTimes(200);
        expect(result.fullPurge).toBeUndefined();
      });

      it('reports a failed full purge as a failure', async () => {
        vi.mocked(fetch).mockResolvedValue(new Response('no route', { status: 404 }));

        const result = await new EdgeCacheClear().clearPaths(manyPaths(201));

        expect(result).toMatchObject({ success: false, statusCode: 404, fullPurge: true });
        expect(warn).toHaveBeenCalledWith('[EdgeCacheClear] Failed to clear the whole edge cache: HTTP 404');
      });

      it('counts the paths other purges still have waiting', async () => {
        process.env.CACHE_PURGE_MAX_PATHS = '5';
        process.env.CACHE_PURGE_CONCURRENCY = '1';
        const open: Array<() => void> = [];
        vi.mocked(fetch).mockImplementation(
          () => new Promise<Response>((resolve) => open.push(() => resolve({ ok: true, status: 200 } as Response)))
        );
        const respond = async () => {
          await vi.waitFor(() => expect(open).toHaveLength(1));
          open.pop()!();
        };

        try {
          // One request in flight and three waiting, then three more: six outstanding is over five.
          const first = new EdgeCacheClear().clearPaths(['/a', '/b', '/c', '/d']);
          const second = new EdgeCacheClear().clearPaths(['/e', '/f', '/g']);
          await respond();
          await respond();

          expect(await second).toMatchObject({ success: true, paths: [], fullPurge: true });
          expect((await first).success).toBe(true);
          // /a, then one full purge in place of the six paths that were waiting.
          expect(vi.mocked(fetch).mock.calls.map(([url]) => String(url).split('/rest/v0alpha1/')[1])).toEqual([
            'cache/paths/a',
            'cache',
          ]);
          expect(warn).toHaveBeenCalledWith(
            '[EdgeCacheClear] One purge added 3 paths, with 3 path purges already waiting, ' +
              'over CACHE_PURGE_MAX_PATHS (5): purging the whole edge cache instead'
          );
        } finally {
          delete process.env.CACHE_PURGE_CONCURRENCY;
        }
      });

      it('does not count paths that are already waiting again', async () => {
        process.env.CACHE_PURGE_MAX_PATHS = '5';
        process.env.CACHE_PURGE_CONCURRENCY = '1';
        const open: Array<() => void> = [];
        vi.mocked(fetch).mockImplementation(
          () => new Promise<Response>((resolve) => open.push(() => resolve({ ok: true, status: 200 } as Response)))
        );

        try {
          // /a in flight, /b to /e waiting; the repeat adds only /a's follow-up: five outstanding.
          const first = new EdgeCacheClear().clearPaths(['/a', '/b', '/c', '/d', '/e']);
          const repeat = new EdgeCacheClear().clearPaths(['/a', '/b', '/c', '/d', '/e']);
          for (let sent = 0; sent < 6; sent++) {
            await vi.waitFor(() => expect(open).toHaveLength(1));
            open.pop()!();
          }

          expect((await repeat).fullPurge).toBeUndefined();
          expect((await first).fullPurge).toBeUndefined();
          expect(warn).not.toHaveBeenCalled();
        } finally {
          delete process.env.CACHE_PURGE_CONCURRENCY;
        }
      });

      it('does not count paths it will not send', async () => {
        process.env.CACHE_PURGE_MAX_PATHS = '2';

        const result = await new EdgeCacheClear().clearPaths(['/a', '/b', '/bad\u0000path', '']);

        expect(result).toMatchObject({ success: true, paths: ['/a', '/b'] });
        expect(result.fullPurge).toBeUndefined();
        expect(fetch).toHaveBeenCalledTimes(2);
      });

      it('follows CACHE_PURGE_MAX_PATHS', async () => {
        process.env.CACHE_PURGE_MAX_PATHS = '1000';

        await new EdgeCacheClear().clearPaths(manyPaths(201));

        expect(fetch).toHaveBeenCalledTimes(201);
      });
    });

    it('never has more than CACHE_PURGE_CONCURRENCY requests in flight, across clearers', async () => {
      process.env.CACHE_PURGE_CONCURRENCY = '3';
      let inFlight = 0;
      let most = 0;
      vi.mocked(fetch).mockImplementation(async () => {
        inFlight++;
        most = Math.max(most, inFlight);
        await new Promise((resolve) => setImmediate(resolve));
        inFlight--;
        return { ok: true, status: 200 } as Response;
      });

      try {
        // A clearer per request, as Next constructs them, all for the same target.
        await Promise.all([
          new EdgeCacheClear().clearPaths(['/a', '/b', '/c', '/d']),
          new EdgeCacheClear().clearKeys(['x', 'y', 'z']),
          new EdgeCacheClear().clearPaths(['/e', '/f']),
        ]);
      } finally {
        delete process.env.CACHE_PURGE_CONCURRENCY;
      }

      expect(fetch).toHaveBeenCalledTimes(9);
      expect(most).toBe(3);
    });

    it('logs a full purge that fails, since callers may not read the result', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      vi.mocked(fetch).mockRejectedValue(new Error('socket hang up'));

      const result = await new EdgeCacheClear().nukeCache();

      expect(result).toMatchObject({ success: false, error: 'socket hang up' });
      expect(warn).toHaveBeenCalledWith('[EdgeCacheClear] Error clearing the whole edge cache:', expect.any(Error));
    });

    it('logs a failed request once, however many callers shared it', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      let respond!: (response: Response) => void;
      vi.mocked(fetch).mockImplementation(() => new Promise<Response>((resolve) => (respond = resolve)));

      // One request in flight for /a; the repeats share the one sent after it.
      const first = new EdgeCacheClear().clearPaths(['/a']);
      await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
      const repeats = Array.from({ length: 50 }, () => new EdgeCacheClear().clearPaths(['/a']));
      respond(new Response(null, { status: 404 }));
      await first;
      await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
      respond(new Response(null, { status: 404 }));
      const results = await Promise.all(repeats);

      expect(results.every((result) => result.success === false)).toBe(true);
      expect(warn.mock.calls.map(([line]) => line)).toEqual([
        '[EdgeCacheClear] Failed to clear path /a: HTTP 404',
        '[EdgeCacheClear] Failed to clear path /a: HTTP 404',
      ]);
    });

    it('a background purge over the limit reports the whole edge cache as cleared', async () => {
      process.env.CACHE_DEBUG = 'true';
      process.env.CACHE_PURGE_MAX_PATHS = '1';
      const debug = vi.spyOn(console, 'log').mockImplementation(() => {});
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      vi.mocked(fetch).mockResolvedValue({ ok: true, status: 200 } as Response);

      try {
        new EdgeCacheClear().clearPathsInBackground(['/a', '/b'], 'a test');
        await vi.waitFor(() =>
          expect(debug).toHaveBeenCalledWith(
            '[EdgeCacheClear] Background path clear for a test: whole edge cache cleared'
          )
        );
      } finally {
        delete process.env.CACHE_DEBUG;
        delete process.env.CACHE_PURGE_MAX_PATHS;
      }
    });

    it('should handle partial failures', async () => {
      vi.mocked(fetch)
        .mockResolvedValueOnce({ ok: true, status: 200 } as Response)
        .mockResolvedValueOnce(new Response(null, { status: 404 }));

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

      // Double-encoded for edge cache clearer
      expect(fetch).toHaveBeenCalledWith(
        `http://${mockEndpoint}/rest/v0alpha1/cache/keys/${encodeURIComponent(encodeURIComponent('tag/with/slashes'))}`,
        expect.any(Object)
      );
    });
  });

  describe('clearKeys validation', () => {
    it('does not send a key with control characters or over the length limit', async () => {
      vi.mocked(fetch).mockResolvedValue({ ok: true, status: 200 } as Response);

      const result = await new EdgeCacheClear().clearKeys([
        'posts',
        `_N_T_/${'a'.repeat(1024)}/layout`,
        'bad\u0000key',
        'x'.repeat(1100),
      ]);

      expect(fetch).toHaveBeenCalledTimes(2);
      expect(result.paths).toEqual(['posts', `_N_T_/${'a'.repeat(1024)}/layout`]);
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

describe('settledWithin', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('gives the result of work that finishes in time', async () => {
    const work = new Promise<string>((resolve) => setTimeout(() => resolve('done'), 100));

    const result = settledWithin(work, 1000);
    await vi.advanceTimersByTimeAsync(100);

    expect(await result).toBe('done');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('stops waiting at the limit and leaves the work running', async () => {
    let finished = false;
    const work = new Promise<string>((resolve) => setTimeout(() => resolve('done'), 5000)).then((value) => {
      finished = true;
      return value;
    });

    const result = settledWithin(work, 1000);
    await vi.advanceTimersByTimeAsync(1000);
    expect(await result).toBeUndefined();
    expect(finished).toBe(false);

    await vi.advanceTimersByTimeAsync(4000);
    expect(finished).toBe(true);
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

  it('drops a trailing slash without trailingSlash', async () => {
    process.env.OUTBOUND_PROXY_ENDPOINT = 'proxy.example.com:8080';
    vi.mocked(fetch).mockResolvedValue({ ok: true, status: 200 } as Response);

    await clearEdgeCachePaths(['/about/', '/']);

    expect(fetch).toHaveBeenCalledWith(
      'http://proxy.example.com:8080/rest/v0alpha1/cache/paths/about',
      expect.objectContaining({ method: 'DELETE' })
    );
    expect(fetch).toHaveBeenCalledWith(
      'http://proxy.example.com:8080/rest/v0alpha1/cache/paths/%252F',
      expect.objectContaining({ method: 'DELETE' })
    );
  });

  it('purges the trailing-slash URL with trailingSlash', async () => {
    process.env.OUTBOUND_PROXY_ENDPOINT = 'proxy.example.com:8080';
    vi.mocked(fetch).mockResolvedValue({ ok: true, status: 200 } as Response);
    const appDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clear-edge-paths-'));
    fs.mkdirSync(path.join(appDir, '.next'));
    fs.writeFileSync(
      path.join(appDir, '.next', 'required-server-files.json'),
      JSON.stringify({ config: { trailingSlash: true } })
    );
    vi.spyOn(process, 'cwd').mockReturnValue(appDir);
    resetSiteUrlConfigForTests();

    try {
      await clearEdgeCachePaths(['/about/', '/contact', '/sitemap.xml']);
    } finally {
      resetSiteUrlConfigForTests();
      fs.rmSync(appDir, { recursive: true, force: true });
    }

    const urls = vi.mocked(fetch).mock.calls.map(([url]) => String(url));
    expect(urls.sort()).toEqual([
      'http://proxy.example.com:8080/rest/v0alpha1/cache/paths/about%252F',
      'http://proxy.example.com:8080/rest/v0alpha1/cache/paths/contact%252F',
      'http://proxy.example.com:8080/rest/v0alpha1/cache/paths/sitemap.xml',
    ]);
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
