import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

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

vi.mock('@google-cloud/storage', () => ({
  Storage: function Storage() {
    return { bucket: () => mockBucket };
  },
  Bucket: vi.fn(),
  RETRYABLE_ERR_FN_DEFAULT: (err: { code?: number }) => err.code === 429 || err.code === 408 || (err.code ?? 0) >= 500,
}));

import { GcsCacheHandler, resetGcsSharedState, flushGcsTagsMapping } from '../../src/handlers/gcs.js';
import { PurgeQueue, purgeQueueFor } from '../../src/edge/purge-queue.js';
import { PURGE_WAIT_MS } from '../../src/edge/edge-cache-clear.js';
import { resetBuildPrerenderTagsForTests } from '../../src/utils/build-prerender-tags.js';
import { writeBuildOutput } from '../helpers/build-output.js';

vi.stubGlobal('fetch', vi.fn());

/** The edge purges sent through the outbound proxy, decoded (paths and keys deduplicated). */
function sentPurges(): { paths: string[]; keys: string[]; nukes: number } {
  const urls = vi.mocked(fetch).mock.calls.map(([url]) => String(url));
  const decode = (segment: string) => decodeURIComponent(decodeURIComponent(segment));
  const after = (marker: string) =>
    urls.filter((u) => u.includes(marker)).map((u) => decode(u.slice(u.indexOf(marker) + marker.length)));
  return {
    // The wire form drops the leading slash (except for `/`); edge-cache-clearer restores it.
    paths: [...new Set(after('/cache/paths/').map((p) => (p.startsWith('/') ? p : `/${p}`)))].sort(),
    keys: [...new Set(after('/cache/keys/'))].sort(),
    nukes: urls.filter((u) => u.endsWith('/rest/v0alpha1/cache')).length,
  };
}

/** Background purges are fire-and-forget. */
const settle = () => new Promise((r) => setTimeout(r, 50));

describe('GcsCacheHandler edge purges on revalidation', () => {
  let tempDir: string;
  let serverDistDir: string;
  let tagsMapping: Record<string, string[]>;

  beforeEach(() => {
    process.env.CACHE_BUCKET = 'test-bucket';
    process.env.OUTBOUND_PROXY_ENDPOINT = 'proxy.example.com:8080';

    vi.clearAllMocks();
    resetGcsSharedState();
    resetBuildPrerenderTagsForTests();

    tagsMapping = {};
    mockFile.exists.mockResolvedValue([true]);
    mockFile.getMetadata.mockResolvedValue([{ generation: '1' }]);
    mockFile.download.mockImplementation(async () => [Buffer.from(JSON.stringify(tagsMapping))]);
    mockFile.save.mockResolvedValue(undefined);
    mockBucket.getFiles.mockResolvedValue([[]]);
    mockBucket.file.mockReturnValue(mockFile);
    vi.mocked(fetch).mockResolvedValue({ ok: true, status: 200 } as Response);

    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gcs-edge-purge-'));
    serverDistDir = path.join(tempDir, '.next', 'server');
    fs.mkdirSync(serverDistDir, { recursive: true });
  });

  afterEach(() => {
    delete process.env.CACHE_BUCKET;
    delete process.env.OUTBOUND_PROXY_ENDPOINT;
    resetBuildPrerenderTagsForTests();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const newHandler = () => new GcsCacheHandler({ serverDistDir } as any);

  describe('build-time prerenders (not in the tags map)', () => {
    beforeEach(() => {
      writeBuildOutput(serverDistDir, {
        '/': { key: 'index', tags: ['_N_T_/layout', '_N_T_/page', '_N_T_/', '_N_T_/index', 'home'] },
        '/tags': { key: 'tags', tags: ['_N_T_/layout', '_N_T_/tags/page', '_N_T_/tags', 'stations'] },
        '/isr-fallback/europe/london': {
          key: 'isr-fallback/europe/london',
          tags: ['_N_T_/layout', '_N_T_/isr-fallback/europe/london', 'stations', 'stations:london'],
        },
      });
    });

    it("purges / for revalidatePath('/') on a page that has not regenerated", async () => {
      await newHandler().revalidateTag(['_N_T_/', '_N_T_/index']);
      await settle();

      expect(sentPurges().paths).toEqual(['/']);
    });

    it("purges the page for a tag from its prerendered 'use cache' scope", async () => {
      await newHandler().revalidateTag('stations:london');
      await settle();

      expect(sentPurges().paths).toEqual(['/isr-fallback/europe/london']);
    });

    it('purges every page sharing a tag', async () => {
      await newHandler().revalidateTag('stations');
      await settle();

      expect(sentPurges().paths).toEqual(['/isr-fallback/europe/london', '/tags']);
    });

    it('merges build prerenders with keys recorded at runtime', async () => {
      tagsMapping = { stations: ['/isr-fallback/asia-pacific/tokyo'] };

      await newHandler().revalidateTag('stations');
      await settle();

      expect(sentPurges().paths).toEqual(['/isr-fallback/asia-pacific/tokyo', '/isr-fallback/europe/london', '/tags']);
    });
  });

  describe('revalidatePath with no keys anywhere', () => {
    it('purges the path named by the tag', async () => {
      await newHandler().revalidateTag('_N_T_/blog/post-1');
      await settle();

      expect(sentPurges().paths).toEqual(['/blog/post-1']);
    });

    it("purges the path from revalidatePath's type form", async () => {
      await newHandler().revalidateTag('_N_T_/about/page');
      await settle();

      expect(sentPurges().paths).toEqual(['/about']);
    });

    it("purges the whole site for revalidatePath('/', 'layout')", async () => {
      await newHandler().revalidateTag('_N_T_/layout');
      await settle();
      expect(sentPurges()).toMatchObject({ paths: [], nukes: 1 });

      // Again after every instance has applied the revalidation (sent by the shutdown flush here).
      await flushGcsTagsMapping({ timeoutMs: 5000 });
      expect(sentPurges()).toMatchObject({ paths: [], nukes: 2 });
    });

    it('purges the concrete pages of a dynamic route, not the pattern', async () => {
      tagsMapping = { '_N_T_/blog/[slug]/page': ['/blog/a', '/blog/b'] };

      await newHandler().revalidateTag('_N_T_/blog/[slug]/page');
      await settle();

      expect(sentPurges().paths).toEqual(['/blog/a', '/blog/b']);
    });
  });

  it('sends key purges even when no cache key is found', async () => {
    await newHandler().revalidateTag('posts');
    await settle();

    expect(sentPurges()).toEqual({ paths: [], keys: ['posts'], nukes: 0 });
  });

  it('does not purge partial-fallback shell keys', async () => {
    tagsMapping = { stations: ['/isr-fallback/europe/[station]', '/isr-fallback/europe/london'] };

    await newHandler().revalidateTag('stations');
    await settle();

    expect(sentPurges().paths).toEqual(['/isr-fallback/europe/london']);
  });

  it('does not path-purge fetch cache keys', async () => {
    tagsMapping = { posts: ['9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08'] };

    await newHandler().revalidateTag('posts');
    await settle();

    expect(sentPurges().paths).toEqual([]);
  });

  it('purges the URL path of Next 16.3.8+ namespaced keys', async () => {
    const hash = 'cb6fe78c021ac9725045fb93151cc4b81faec4e3a321225f29dc587e045ca103';
    tagsMapping = { stations: [`/route-cache/APP_PAGE/${hash}/$/index`, `/route-cache/APP_PAGE/${hash}/$/tags`] };

    await newHandler().revalidateTag('stations');
    await settle();

    expect(sentPurges().paths).toEqual(['/', '/tags']);
  });

  it('purges a Pages Router ISR page when it regenerates (res.revalidate)', async () => {
    await newHandler().set(
      '/pages-isr/london',
      { kind: 'PAGES', html: '', pageData: {}, status: 200 } as any,
      {
        tags: [],
      } as any
    );
    await settle();

    expect(sentPurges().paths).toEqual(['/pages-isr/london']);
  });

  describe('bounded fan-out (CACHE_PURGE_MAX_PATHS, CACHE_PURGE_CONCURRENCY)', () => {
    let warn: ReturnType<typeof vi.spyOn>;
    let inFlight: number;
    let mostInFlight: number;

    /** Every purge request stays open until the next turn of the event loop, so overlap is visible. */
    const countInFlight = () => {
      inFlight = 0;
      mostInFlight = 0;
      vi.mocked(fetch).mockImplementation(async () => {
        inFlight++;
        mostInFlight = Math.max(mostInFlight, inFlight);
        await new Promise((resolve) => setImmediate(resolve));
        inFlight--;
        return { ok: true, status: 200 } as Response;
      });
    };

    beforeEach(() => {
      warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    });

    afterEach(() => {
      warn.mockRestore();
      delete process.env.CACHE_PURGE_MAX_PATHS;
      delete process.env.CACHE_PURGE_CONCURRENCY;
    });

    it('a tag on 5,000 pages sends its key and one full purge', async () => {
      tagsMapping = { menu: Array.from({ length: 5000 }, (_, i) => `/page-${i}`) };

      await newHandler().revalidateTag('menu');

      expect(sentPurges()).toEqual({ paths: [], keys: ['menu'], nukes: 1 });
      expect(warn).toHaveBeenCalledWith(
        '[EdgeCacheClear] One purge added 5000 paths, over CACHE_PURGE_MAX_PATHS (200): ' +
          'purging the whole edge cache instead'
      );

      // The second purge, after every instance has applied the revalidation, is capped the same way.
      await flushGcsTagsMapping({ timeoutMs: 5000 });
      expect(sentPurges()).toEqual({ paths: [], keys: ['menu'], nukes: 2 });
      expect(fetch).toHaveBeenCalledTimes(4);
    });

    it.each([
      ['by path', 'posts', { paths: ['/blog/a'], keys: ['posts'], nukes: 0 }],
      ['for the whole site', '_N_T_/layout', { paths: [], nukes: 1 }],
    ])(
      'revalidateTag stops waiting for a purge %s that gets no answer, and the purge stays sent',
      async (_how, tag, sent) => {
        tagsMapping = { posts: ['/blog/a'] };
        vi.mocked(fetch).mockImplementation(() => new Promise<Response>(() => {}));
        // Only the timers: the handler's file reads still need the real event loop.
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

        try {
          let returned = false;
          const revalidation = newHandler()
            .revalidateTag(tag)
            .then(() => {
              returned = true;
            });
          await vi.waitFor(() => expect(sentPurges()).toMatchObject(sent));
          expect(returned).toBe(false);

          await vi.advanceTimersByTimeAsync(PURGE_WAIT_MS);
          await revalidation;
          expect(returned).toBe(true);
        } finally {
          vi.useRealTimers();
        }
      }
    );

    describe('after the purge service has refused a request', () => {
      const QUEUE = 'http://proxy.example.com:8080/rest/v0alpha1/cache';
      const refuseFor = (seconds: number) =>
        vi
          .mocked(fetch)
          .mockImplementation(
            async () => new Response('slow down', { status: 429, headers: { 'retry-after': String(seconds) } })
          );
      const answerNormally = () =>
        vi.mocked(fetch).mockImplementation(async () => ({ ok: true, status: 200 }) as Response);

      beforeEach(() => {
        // Only the timers: the handler's file reads still need the real event loop.
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
      });

      afterEach(() => {
        vi.useRealTimers();
      });

      /** Starts the pause: the revalidation that finds out is refused, and returns with that answer. */
      const refusedRevalidation = async (seconds: number) => {
        refuseFor(seconds);
        const revalidation = newHandler().revalidateTag('posts');
        await vi.waitFor(() => expect(purgeQueueFor(QUEUE).pauseLeftMs).toBeGreaterThan(0));
        await revalidation;
        vi.mocked(fetch).mockClear();
        answerNormally();
      };

      it.each([
        ['by path', 'posts', { paths: ['/blog/a'], keys: ['posts'], nukes: 0 }],
        ['for the whole site', '_N_T_/layout', { paths: [], nukes: 1 }],
      ])(
        'revalidateTag does not wait for a purge %s through a pause longer than its limit, and the purge is sent after it',
        async (_how, tag, sent) => {
          tagsMapping = { posts: ['/blog/a'] };
          await refusedRevalidation(30);

          let returned = false;
          void newHandler()
            .revalidateTag(tag)
            .then(() => {
              returned = true;
            });
          // Well inside both the 10 s limit and the pause: it returned without waiting for either.
          await vi.waitFor(() => expect(returned).toBe(true));
          expect(purgeQueueFor(QUEUE).pauseLeftMs).toBeGreaterThan(PURGE_WAIT_MS);
          expect(fetch).not.toHaveBeenCalled();

          // Queued, not skipped.
          await vi.advanceTimersByTimeAsync(30_000);
          await vi.waitFor(() => expect(sentPurges()).toMatchObject(sent));
        }
      );

      it('revalidateTag waits through a pause shorter than its limit, so the purge is sent while the request is served', async () => {
        tagsMapping = { posts: ['/blog/a'] };
        await refusedRevalidation(8);

        let returned = false;
        const revalidation = newHandler()
          .revalidateTag('posts')
          .then(() => {
            returned = true;
          });
        await vi.waitFor(() => expect(purgeQueueFor(QUEUE).waitingPathCount).toBe(1));
        await vi.advanceTimersByTimeAsync(2000);
        expect(returned).toBe(false);
        expect(fetch).not.toHaveBeenCalled();

        await vi.advanceTimersByTimeAsync(6000);
        await revalidation;
        expect(sentPurges()).toEqual({ paths: ['/blog/a'], keys: ['posts'], nukes: 0 });
      });
    });

    it('purges by path up to the limit, at most CACHE_PURGE_CONCURRENCY at once', async () => {
      process.env.CACHE_PURGE_CONCURRENCY = '4';
      tagsMapping = { posts: Array.from({ length: 200 }, (_, i) => `/post-${i}`) };
      countInFlight();

      await newHandler().revalidateTag('posts');

      expect(sentPurges().paths).toHaveLength(200);
      expect(sentPurges().nukes).toBe(0);
      expect(mostInFlight).toBe(4);
    });

    it('CACHE_PURGE_MAX_PATHS moves the limit', async () => {
      process.env.CACHE_PURGE_MAX_PATHS = '2';
      tagsMapping = { posts: ['/a', '/b', '/c'] };

      await newHandler().revalidateTag('posts');

      expect(sentPurges()).toEqual({ paths: [], keys: ['posts'], nukes: 1 });
    });

    it('400 revalidations of one tag at once send each path and key once per in-flight window', async () => {
      tagsMapping = { posts: ['/blog/a', '/blog/b', '/blog/c'] };
      const open: Array<() => void> = [];
      vi.mocked(fetch).mockImplementation(
        () => new Promise<Response>((resolve) => open.push(() => resolve({ ok: true, status: 200 } as Response)))
      );
      const callsPerUrl = () => {
        const counts = new Map<string, number>();
        for (const [url] of vi.mocked(fetch).mock.calls) {
          counts.set(String(url), (counts.get(String(url)) ?? 0) + 1);
        }
        return [...counts.values()];
      };
      const respondToAll = () => open.splice(0).forEach((respond) => respond());

      const enqueue = vi.spyOn(PurgeQueue.prototype, 'enqueue');

      const revalidations = Array.from({ length: 400 }, () => newHandler().revalidateTag('posts'));
      // Every call has asked for its three paths and its key.
      await vi.waitFor(() => expect(enqueue).toHaveBeenCalledTimes(400 * 4), { timeout: 10000 });

      // First window: each of the four requests is in flight once, while all 400 calls wait.
      expect(callsPerUrl()).toEqual([1, 1, 1, 1]);

      // Calls that arrived after those requests started get one more request each, not 399.
      respondToAll();
      await vi.waitFor(() => expect(open).toHaveLength(4));
      expect(callsPerUrl()).toEqual([2, 2, 2, 2]);

      respondToAll();
      await Promise.all(revalidations);
      expect(sentPurges()).toEqual({ paths: ['/blog/a', '/blog/b', '/blog/c'], keys: ['posts'], nukes: 0 });

      // The 400 second purges still merge into one batch.
      const flushed = flushGcsTagsMapping({ timeoutMs: 5000 });
      await vi.waitFor(() => expect(open).toHaveLength(4), { timeout: 5000 });
      respondToAll();
      await flushed;
      expect(callsPerUrl()).toEqual([3, 3, 3, 3]);

      enqueue.mockRestore();
    });
  });
});
