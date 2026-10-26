import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { FakeBucket } from '../helpers/fake-bucket.js';

let bucket: FakeBucket;

vi.mock('@google-cloud/storage', () => ({
  Storage: function Storage() {
    return { bucket: () => bucket };
  },
  Bucket: vi.fn(),
  RETRYABLE_ERR_FN_DEFAULT: () => false,
}));

// A real build ID: without .next/BUILD_ID in the working directory the
// generation is a fallback-* value, for which the build check does nothing.
const generation = vi.hoisted(() => ({ id: 'test-build' }));
vi.mock('../../src/utils/build-detection.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/utils/build-detection.js')>()),
  getCacheGenerationId: () => generation.id,
}));

import { tagsManifest } from 'next/dist/server/lib/incremental-cache/tags-manifest.external.js';
import { hasStaleTags, nextMajor } from '../helpers/next-version.js';
import {
  GcsCacheHandler,
  resetGcsSharedState,
  flushGcsTagsMapping,
  waitForRouteCacheCleanupsForTests,
} from '../../src/handlers/gcs.js';
import { toObjectName } from '../../src/utils/object-names.js';
import { resetBuildInvalidationCheck } from '../../src/handlers/base.js';
import { writeBuildOutput } from '../helpers/build-output.js';
import { resetBuildPrerenderTagsForTests } from '../../src/utils/build-prerender-tags.js';
import { resetSharedRevalidationsForTests } from '../../src/utils/shared-revalidations.js';
import { resetSiteUrlConfigForTests } from '../../src/utils/site-urls.js';
import { MERGE_WINDOW_MS } from '../../src/utils/delayed-purges.js';

vi.stubGlobal('fetch', vi.fn());

const REVALIDATIONS = 'cache/tags/revalidations.json';
const TAGS_MAP = 'cache/tags/tags.json';
const settle = () => new Promise((r) => setTimeout(r, 50));

/** Every decoded `…/cache/paths/<p>` purge sent, in order, with the leading slash edge-cache-clearer restores. */
function pathPurges(): string[] {
  return vi
    .mocked(fetch)
    .mock.calls.map(([url]) => String(url))
    .filter((url) => url.includes('/cache/paths/'))
    .map((url) => decodeURIComponent(decodeURIComponent(url.slice(url.indexOf('/cache/paths/') + 13))))
    .map((p) => (p.startsWith('/') ? p : `/${p}`));
}

/** The distinct paths purged, sorted. */
const purgedPaths = () => [...new Set(pathPurges())].sort();

// CACHE_TAGS_REFRESH_INTERVAL_MS is 100 in tests (vitest.config.ts): the second
// purge follows the stored revalidation by the interval plus an equal margin.
const APPLY_DELAY_MS = 200;
// The second purge goes out within the merge window after it is due.
const SECOND_PURGE_MS = APPLY_DELAY_MS + MERGE_WINDOW_MS + 100;

const page = (tags: string[]) => ({
  kind: 'APP_PAGE',
  html: '',
  rscData: undefined,
  status: 200,
  headers: { 'x-next-cache-tags': tags.join(',') },
  postponed: undefined,
  segmentData: undefined,
});

describe('GcsCacheHandler across instances', () => {
  let tempDir: string;
  let serverDistDir: string;

  beforeEach(() => {
    bucket = new FakeBucket();
    process.env.CACHE_BUCKET = 'test-bucket';
    process.env.OUTBOUND_PROXY_ENDPOINT = 'proxy.example.com:8080';
    vi.clearAllMocks();
    vi.mocked(fetch).mockResolvedValue({ ok: true, status: 200 } as Response);
    resetGcsSharedState();
    resetSharedRevalidationsForTests();
    resetBuildPrerenderTagsForTests();
    resetSiteUrlConfigForTests();
    tagsManifest.clear();

    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gcs-cross-'));
    serverDistDir = path.join(tempDir, '.next', 'server');
    fs.mkdirSync(serverDistDir, { recursive: true });
  });

  afterEach(() => {
    delete process.env.CACHE_BUCKET;
    delete process.env.OUTBOUND_PROXY_ENDPOINT;
    resetGcsSharedState();
    tagsManifest.clear();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const newHandler = () => new GcsCacheHandler({ serverDistDir } as any);

  describe('route entries from another build', () => {
    const key = '/route-cache/APP_PAGE/h/$/stamped';

    /** Store a route entry through set(), then give it `stamp` (null: no stamp, undefined: as written). */
    async function storeRoute(stamp?: string | null): Promise<string> {
      await newHandler().set(key, page([]) as any, { tags: [] } as any);
      const name = [...bucket.objects.keys()].find((n) => n.startsWith('route-cache/'))!;
      if (stamp !== undefined) {
        const entry = bucket.json(name) as Record<string, unknown>;
        if (stamp === null) delete entry.generation;
        else entry.generation = stamp;
        bucket.putJson(name, entry);
      }
      return name;
    }

    afterEach(() => {
      generation.id = 'test-build';
      resetBuildInvalidationCheck();
    });

    it('stamps a route entry with this build and serves it without the stamp', async () => {
      const name = await storeRoute();

      expect(bucket.json(name)).toMatchObject({ generation: 'test-build' });
      const entry = await newHandler().get(key, { kind: 'APP_PAGE' } as any);
      expect(entry).toMatchObject({ value: { kind: 'APP_PAGE' } });
      expect(entry).not.toHaveProperty('generation');
    });

    it('misses a route entry from another build', async () => {
      await storeRoute('other-build');

      expect(await newHandler().get(key, { kind: 'APP_PAGE' } as any)).toBeNull();
    });

    it('misses an unstamped route entry, as written before 0.13.4', async () => {
      await storeRoute(null);

      expect(await newHandler().get(key, { kind: 'APP_PAGE' } as any)).toBeNull();
    });

    it('serves fetch entries whatever build wrote them, and does not stamp them', async () => {
      const value = { kind: 'FETCH', data: { headers: {}, body: 'x', status: 200 }, revalidate: 60 };
      bucket.putJson('fetch-cache/abc123.json', { value, lastModified: Date.now(), tags: [] });
      await newHandler().set('def456', value as any, { tags: [] } as any);

      expect(await newHandler().get('abc123', { fetchCache: true } as any)).toMatchObject({ value });
      expect(bucket.json('fetch-cache/def456.json')).not.toHaveProperty('generation');
    });

    it('serves any route entry in a process whose build ID is unreadable', async () => {
      generation.id = 'fallback-1';
      resetBuildInvalidationCheck();
      await storeRoute('other-build');

      expect(await newHandler().get(key, { kind: 'APP_PAGE' } as any)).toMatchObject({ value: { kind: 'APP_PAGE' } });
    });
  });

  describe('revalidations made on another instance (gap B)', () => {
    it('stores each revalidation for other instances', async () => {
      await newHandler().revalidateTag('inventory');

      expect(bucket.json(REVALIDATIONS)).toEqual({
        inventory: { expired: expect.any(Number), at: expect.any(Number) },
      });
    });

    it('stops serving an entry whose tag another instance expired', async () => {
      const handler = newHandler();
      await handler.set('/route-cache/APP_PAGE/h/$/tags', page(['inventory']) as any, { tags: [] } as any);
      const at = Date.now() + 5;
      bucket.putJson(REVALIDATIONS, { inventory: { expired: at, at } });
      await new Promise((r) => setTimeout(r, 20));

      expect(await newHandler().get('/route-cache/APP_PAGE/h/$/tags', { kind: 'APP_PAGE' } as any)).toBeNull();
    });

    it('serves without waiting more than 2s when revalidations from other instances cannot be read', async () => {
      const handler = newHandler();
      await handler.set('/route-cache/APP_PAGE/h/$/tags', page(['inventory']) as any, { tags: [] } as any);
      const real = bucket.file.bind(bucket);
      vi.spyOn(bucket, 'file').mockImplementation((name, options) =>
        name === REVALIDATIONS
          ? { ...real(name, options), getMetadata: () => new Promise(() => {}) }
          : real(name, options)
      );

      const started = Date.now();
      const entry = await newHandler().get('/route-cache/APP_PAGE/h/$/tags', { kind: 'APP_PAGE' } as any);

      expect(entry).not.toBeNull();
      expect(Date.now() - started).toBeLessThan(2500);
    });

    it.skipIf(!hasStaleTags)('marks the entry stale, not expired, for a soft revalidation', async () => {
      const handler = newHandler();
      await handler.set('/route-cache/APP_PAGE/h/$/tags', page(['inventory']) as any, { tags: [] } as any);
      const at = Date.now() + 5;
      bucket.putJson(REVALIDATIONS, { inventory: { stale: at, expired: at + 3_600_000, at } });
      await new Promise((r) => setTimeout(r, 20));

      // Served (Next serves it stale and regenerates); tagsManifest carries the staleness.
      expect(await newHandler().get('/route-cache/APP_PAGE/h/$/tags', { kind: 'APP_PAGE' } as any)).not.toBeNull();
      expect(tagsManifest.get('inventory')).toEqual({ stale: at, expired: at + 3_600_000 });
    });

    describe.runIf(nextMajor === 15)('on Next.js 15', () => {
      const FETCH_KEY = 'fetch-key';
      const fetchValue = { kind: 'FETCH', data: { headers: {}, body: '', url: '' }, revalidate: 3600 };
      const fetchCtx = {
        kind: 'FETCH',
        fetchUrl: 'https://api.example.com/posts',
        fetchIdx: 0,
        revalidate: 3600,
        tags: ['api-posts'],
        softTags: [],
      };

      // Next.js 15's IncrementalCache leaves the tagsManifest check for fetches
      // to its FileSystemCache.get, which this handler replaces.
      it('stops serving a fetch entry whose tag another instance revalidated', async () => {
        await newHandler().set(FETCH_KEY, fetchValue as any, { fetchCache: true, tags: ['api-posts'] } as any);
        const at = Date.now() + 5;
        bucket.putJson(REVALIDATIONS, { 'api-posts': { expired: at, at } });
        await new Promise((r) => setTimeout(r, 20));

        expect(await newHandler().get(FETCH_KEY, fetchCtx as any)).toBeNull();
      });

      // Next.js 15's isStale has no `<= now` guard, so a revalidation stamped by
      // a clock that is ahead would mark the regenerated entry stale as well.
      const aheadCases = [
        { name: 'an expiry', revalidation: (ahead: number) => ({ expired: ahead, at: ahead }) },
        { name: 'a soft revalidation', revalidation: (ahead: number) => ({ stale: ahead, at: ahead }) },
      ];

      for (const { name, revalidation } of aheadCases) {
        it(`serves a page regenerated after learning ${name} from an instance whose clock is ahead`, async () => {
          bucket.putJson(REVALIDATIONS, { inventory: revalidation(Date.now() + 3_000) });
          // The first read learns the revalidation.
          await newHandler().get('/route-cache/APP_PAGE/h/$/other', { kind: 'APP_PAGE' } as any);
          await new Promise((r) => setTimeout(r, 5));

          await newHandler().set('/route-cache/APP_PAGE/h/$/tags', page(['inventory']) as any, { tags: [] } as any);

          expect(await newHandler().get('/route-cache/APP_PAGE/h/$/tags', { kind: 'APP_PAGE' } as any)).not.toBeNull();
        });
      }
    });
  });

  describe('CDN purge after every instance has the revalidation', () => {
    it('resolves after the first purge and purges again once every instance has applied it', async () => {
      bucket.putJson(TAGS_MAP, { inventory: ['/route-cache/APP_PAGE/h/$/tags'] });
      const handler = newHandler();

      await handler.revalidateTag('inventory');
      const resolvedAt = Date.now();
      expect(pathPurges()).toEqual(['/tags']);
      // The revalidation was stored before either purge.
      expect(bucket.json(REVALIDATIONS)).toHaveProperty('inventory');

      let secondAt = 0;
      vi.mocked(fetch).mockImplementation(async () => {
        secondAt ||= Date.now();
        return { ok: true, status: 200 } as Response;
      });
      await new Promise((r) => setTimeout(r, SECOND_PURGE_MS));
      expect(pathPurges()).toEqual(['/tags', '/tags']);
      // Never before every instance can have applied it.
      expect(secondAt - resolvedAt).toBeGreaterThanOrEqual(APPLY_DELAY_MS);
    });

    it('merges re-purges due close together into one purge per path and key', async () => {
      bucket.putJson(TAGS_MAP, {
        inventory: ['/route-cache/APP_PAGE/h/$/tags'],
        stations: ['/route-cache/APP_PAGE/h/$/tags', '/route-cache/APP_PAGE/h/$/stations'],
      });
      const handler = newHandler();
      await handler.revalidateTag('inventory');
      await new Promise((r) => setTimeout(r, 100));
      await handler.revalidateTag('stations');
      const firstPurges = vi.mocked(fetch).mock.calls.length;

      await new Promise((r) => setTimeout(r, SECOND_PURGE_MS));
      const later = vi
        .mocked(fetch)
        .mock.calls.slice(firstPurges)
        .map(([url]) => String(url));
      expect(later.filter((url) => url.includes('/cache/paths/')).sort()).toEqual([
        expect.stringContaining('/cache/paths/stations'),
        expect.stringContaining('/cache/paths/tags'),
      ]);
      expect(later.filter((url) => url.includes('/cache/keys/')).sort()).toEqual([
        expect.stringContaining('/cache/keys/inventory'),
        expect.stringContaining('/cache/keys/stations'),
      ]);
    });

    it('sends a re-purge that is still owed when the process flushes for shutdown', async () => {
      bucket.putJson(TAGS_MAP, { inventory: ['/route-cache/APP_PAGE/h/$/tags'] });
      await newHandler().revalidateTag('inventory');
      expect(pathPurges()).toEqual(['/tags']);

      await flushGcsTagsMapping();
      expect(pathPurges()).toEqual(['/tags', '/tags']);
    });

    it('does not hold the revalidation for the apply delay', async () => {
      const started = Date.now();
      await newHandler().revalidateTag('inventory');

      // The batching window plus GCS round trips, not the window plus the apply delay.
      expect(Date.now() - started).toBeLessThan(250 + APPLY_DELAY_MS);
    });

    it('defers the second purge until a revalidation that could not be stored is stored', async () => {
      bucket.putJson(TAGS_MAP, { inventory: ['/route-cache/APP_PAGE/h/$/tags'] });
      const store = (await import('../../src/utils/shared-revalidations.js')).SharedRevalidations.prototype;
      vi.spyOn(store, 'record').mockResolvedValueOnce(false);
      let onStored: (() => void) | undefined;
      vi.spyOn(store, 'whenStored').mockImplementationOnce((_tags, callback) => {
        onStored = callback;
      });

      await newHandler().revalidateTag('inventory');
      await new Promise((r) => setTimeout(r, APPLY_DELAY_MS + 50));
      expect(pathPurges()).toEqual(['/tags']);

      onStored!();
      await new Promise((r) => setTimeout(r, SECOND_PURGE_MS));
      expect(pathPurges()).toEqual(['/tags', '/tags']);
    });

    it('batches revalidations arriving within the window into one write', async () => {
      const handler = newHandler();
      const first = handler.revalidateTag('inventory');
      await new Promise((r) => setTimeout(r, 100)); // another request, 100 ms later
      const second = handler.revalidateTag(['stations', 'stations:london'], { expire: 0 });
      await Promise.all([first, second]);

      expect(bucket.writes.get(REVALIDATIONS)).toBe(1);
      expect(Object.keys(bucket.json(REVALIDATIONS) as object).sort()).toEqual([
        'inventory',
        'stations',
        'stations:london',
      ]);
    });
  });

  describe("purging another instance's revalidations on this one", () => {
    const tagsKey = '/route-cache/APP_PAGE/h/$/tags';
    const storePage = async () => {
      await newHandler().set(tagsKey, page(['inventory']) as any, { tags: [] } as any);
      await settle();
      vi.mocked(fetch).mockClear(); // the ISR purge from storing it
    };
    const nextRefresh = () => new Promise((r) => setTimeout(r, 150)); // past the 100 ms test interval

    it('purges the pages of a tag another instance revalidated once this one learns of it', async () => {
      await storePage();
      await newHandler().get(tagsKey, { kind: 'APP_PAGE' } as any); // first read of the store
      expect(pathPurges()).toEqual([]);

      const at = Date.now();
      bucket.putJson(REVALIDATIONS, { inventory: { expired: at, at } });
      // Served before it learns of the revalidation: the CDN may have kept this copy.
      expect(await newHandler().get(tagsKey, { kind: 'APP_PAGE' } as any)).not.toBeNull();
      await nextRefresh();
      await newHandler().get(tagsKey, { kind: 'APP_PAGE' } as any);
      await settle(); // started by that request, not awaited by its cache read

      expect(pathPurges()).toEqual(['/tags']);
    });

    it('purges nothing on an instance that served no page after the revalidation', async () => {
      await storePage();
      await newHandler().get(tagsKey, { kind: 'APP_PAGE' } as any);

      const at = Date.now() + 5000; // after everything this instance served
      bucket.putJson(REVALIDATIONS, { inventory: { expired: at, at } });
      await nextRefresh();
      await newHandler().get(tagsKey, { kind: 'APP_PAGE' } as any);
      await settle();

      expect(pathPurges()).toEqual([]);
    });

    it('does not hold the cache read that learns of it for the purge', async () => {
      await storePage();
      await newHandler().get(tagsKey, { kind: 'APP_PAGE' } as any);
      vi.mocked(fetch).mockImplementation(() => new Promise(() => {})); // the CDN never answers

      const at = Date.now();
      bucket.putJson(REVALIDATIONS, { inventory: { expired: at, at } });
      await newHandler().get(tagsKey, { kind: 'APP_PAGE' } as any);
      await nextRefresh();
      const started = Date.now();
      await newHandler().get(tagsKey, { kind: 'APP_PAGE' } as any);

      expect(Date.now() - started).toBeLessThan(500);
      await settle(); // let the purge reach fetch here, not in the next test
      expect(pathPurges()).toEqual(['/tags']);
    });

    it('does not purge revalidations already stored when this instance first reads the store', async () => {
      bucket.putJson(TAGS_MAP, { inventory: [tagsKey] });
      const at = Date.now();
      bucket.putJson(REVALIDATIONS, { inventory: { expired: at, at } });

      await newHandler().get(tagsKey, { kind: 'APP_PAGE' } as any);
      await nextRefresh();
      await newHandler().get(tagsKey, { kind: 'APP_PAGE' } as any);

      expect(pathPurges()).toEqual([]);
    });

    it("does not purge this instance's own revalidation a third time when it reads it back", async () => {
      await storePage();
      await newHandler().get(tagsKey, { kind: 'APP_PAGE' } as any);

      await newHandler().revalidateTag('inventory');
      await new Promise((r) => setTimeout(r, SECOND_PURGE_MS));
      await newHandler().get(tagsKey, { kind: 'APP_PAGE' } as any);

      expect(pathPurges()).toEqual(['/tags', '/tags']);
    });
  });

  describe('keys another instance had not flushed (gap A)', () => {
    const santiago = '/route-cache/APP_PAGE/h/$/isr-fallback/americas/santiago';

    it('purges a key whose tag was revalidated before the key reached the tags map', async () => {
      await newHandler().set(santiago, page(['stations:santiago']) as any, { tags: [] } as any);
      await settle();
      vi.mocked(fetch).mockClear();
      expect(bucket.json(TAGS_MAP)).toBeUndefined();

      // Another instance revalidates and reads a map without the key.
      const at = Date.now();
      bucket.putJson(REVALIDATIONS, { 'stations:santiago': { expired: at, at } });

      // The shutdown flush also sends the re-purge, once every instance has applied it.
      await flushGcsTagsMapping();
      await settle();

      expect(bucket.json(TAGS_MAP)).toEqual({ 'stations:santiago': [santiago] });
      expect(pathPurges()).toEqual(['/isr-fallback/americas/santiago', '/isr-fallback/americas/santiago']);
      expect(Date.now() - at).toBeGreaterThanOrEqual(APPLY_DELAY_MS);
    });

    it('does not purge for a revalidation that predates the key', async () => {
      const at = Date.now() - 60_000;
      bucket.putJson(REVALIDATIONS, { 'stations:santiago': { expired: at, at } });
      await newHandler().set(santiago, page(['stations:santiago']) as any, { tags: [] } as any);
      await settle();
      vi.mocked(fetch).mockClear();

      await flushGcsTagsMapping();
      await settle();

      expect(purgedPaths()).toEqual([]);
    });
  });

  describe('deploy hand-over: pruning revalidations.json', () => {
    const previousBuild = Date.parse('2026-10-01T10:00:00Z');
    const oldFetch = 'fetch-cache/a1b2c3.json';
    const recentFetch = 'fetch-cache/d4e5f6.json';

    beforeEach(() => {
      resetBuildInvalidationCheck();
      bucket.putJson('build-meta.json', {
        buildId: 'previous-build',
        timestamp: previousBuild,
        builtAt: previousBuild,
      });
      bucket.putJson(REVALIDATIONS, {
        old: { expired: previousBuild - 1000, at: previousBuild - 1000 },
        recent: { expired: previousBuild + 1000, at: previousBuild + 1000 },
      });
      bucket.putJson(TAGS_MAP, { old: ['a1b2c3', '/route-cache/APP_PAGE/h/$/tags'], recent: ['d4e5f6'] });
      bucket.putJson(oldFetch, { value: { kind: 'FETCH' }, lastModified: 1, tags: ['old'] });
      bucket.putJson(recentFetch, { value: { kind: 'FETCH' }, lastModified: 1, tags: ['recent'] });
    });

    afterEach(() => resetBuildInvalidationCheck());

    /** Start the new deploy's first handler and let the background hand-over finish. */
    async function deploy() {
      const handler = newHandler();
      await handler.get('/route-cache/APP_PAGE/h/$/tags', { kind: 'APP_PAGE' } as any);
      await new Promise((r) => setTimeout(r, 100));
    }

    it('drops revalidations older than the previous build, after deleting their fetch entries', async () => {
      await deploy();

      expect(bucket.json(REVALIDATIONS)).toEqual({
        recent: { expired: previousBuild + 1000, at: previousBuild + 1000 },
      });
      expect(bucket.objects.has(oldFetch)).toBe(false);
      expect(bucket.objects.has(recentFetch)).toBe(true);
    });

    it("removes the previous build's route keys from tags.json, keeping fetch keys", async () => {
      await deploy();

      // The route key is gone and d4e5f6 stays; a1b2c3 leaves with the revalidation
      // pruning, which also runs in the background.
      expect(bucket.json(TAGS_MAP)).toEqual({ recent: ['d4e5f6'] });
    });

    it('keeps a route key the new build sets after the removal', async () => {
      await deploy();
      await newHandler().set('/route-cache/APP_PAGE/h/$/tags', page(['old']) as any, { tags: ['old'] } as any);
      await flushGcsTagsMapping();

      expect((bucket.json(TAGS_MAP) as Record<string, string[]>).old).toContain('/route-cache/APP_PAGE/h/$/tags');
    });

    it("records this build's prerender time for the next deploy", async () => {
      writeBuildOutput(serverDistDir, { '/tags': { key: 'tags', tags: ['t'] } });
      const written = new Date('2026-10-05T12:00:00Z');
      fs.utimesSync(path.join(serverDistDir, 'app', 'tags.meta'), written, written);

      await deploy();

      expect(bucket.json('build-meta.json')).toMatchObject({ builtAt: written.getTime() - 60_000 });
    });

    it('prunes nothing when the previous build recorded no build time', async () => {
      bucket.putJson('build-meta.json', { buildId: 'previous-build', timestamp: previousBuild });

      await deploy();

      expect(Object.keys(bucket.json(REVALIDATIONS) as object).sort()).toEqual(['old', 'recent']);
      expect(bucket.objects.has(oldFetch)).toBe(true);
    });

    it('keeps the revalidations when their fetch entries cannot be deleted', async () => {
      const real = bucket.file.bind(bucket);
      vi.spyOn(bucket, 'file').mockImplementation((name, options) =>
        name === oldFetch
          ? {
              ...real(name, options),
              delete: () => Promise.reject(Object.assign(new Error('HTTP 503'), { code: 503 })),
            }
          : real(name, options)
      );

      await deploy();

      expect(Object.keys(bucket.json(REVALIDATIONS) as object).sort()).toEqual(['old', 'recent']);
    });

    it('leaves the file alone on a restart of the same build', async () => {
      await deploy();
      const after = bucket.json(REVALIDATIONS);
      bucket.putJson(REVALIDATIONS, { ...(after as object), older: { expired: 1, at: 1 } });

      resetBuildInvalidationCheck();
      await deploy();

      expect(bucket.json(REVALIDATIONS)).toHaveProperty('older');
    });
  });

  describe('deploy hand-over: deleting the route cache in the background', () => {
    const shared = '/route-cache/APP_PAGE/shared';
    const old = '/route-cache/APP_PAGE/old';
    const objectOf = (key: string) => `route-cache/${toObjectName(key)}.json`;

    beforeEach(() => {
      resetBuildInvalidationCheck();
      bucket.putJson('build-meta.json', { buildId: 'previous-build', timestamp: 1 });
      for (const key of [shared, old]) {
        bucket.putJson(
          objectOf(key),
          { value: page(['posts']), lastModified: 1, tags: ['posts'] },
          {
            generation: 'previous-build',
          }
        );
      }
      bucket.putJson(TAGS_MAP, { posts: [shared, old] });
    });

    afterEach(() => resetBuildInvalidationCheck());

    it('keeps a page, and its tags map key, that the new build caches while the delete waits', async () => {
      // The clean-up's first listing waits until released.
      let release!: () => void;
      const released = new Promise<void>((resolve) => (release = resolve));
      const getFiles = bucket.getFiles.bind(bucket);
      vi.spyOn(bucket, 'getFiles').mockImplementation(async (query) => {
        await released;
        return getFiles(query);
      });

      // The first request is answered while the delete has not started.
      expect(await newHandler().get(shared, { kind: 'APP_PAGE' } as any)).toBeNull();
      expect(bucket.json('build-meta.json')).toMatchObject({ buildId: 'test-build' });

      // A new-build instance caches `shared` again, before the delete reaches it.
      await newHandler().set(shared, page(['posts']) as any, { tags: ['posts'] } as any);
      await flushGcsTagsMapping();

      release();
      await waitForRouteCacheCleanupsForTests();

      expect(bucket.objects.has(objectOf(old))).toBe(false);
      expect(bucket.objects.get(objectOf(shared))?.custom).toEqual({ generation: 'test-build' });
      expect(bucket.json(TAGS_MAP)).toEqual({ posts: [shared] });
      expect(bucket.objects.has('route-cache-cleanup.json')).toBe(false);
      expect(await newHandler().get(shared, { kind: 'APP_PAGE' } as any)).not.toBeNull();
    });

    it('keeps a tags map key whose page another instance caches after the prune lists it', async () => {
      // The delete pass lists once; the prune's listing is the second. Right after it, another new-build
      // instance caches `shared`. Its key is already in tags.json (from the previous build), so that
      // instance's flush changes nothing and writes nothing.
      const getFiles = bucket.getFiles.bind(bucket);
      let listings = 0;
      vi.spyOn(bucket, 'getFiles').mockImplementation(async (query) => {
        const result = await getFiles(query);
        if (++listings === 2) {
          bucket.putJson(
            objectOf(shared),
            { value: page(['posts']), lastModified: 2, tags: ['posts'] },
            { generation: 'test-build' }
          );
        }
        return result;
      });

      await newHandler().get(old, { kind: 'APP_PAGE' } as any);
      await waitForRouteCacheCleanupsForTests();

      expect(bucket.objects.get(objectOf(shared))?.custom).toEqual({ generation: 'test-build' });
      expect(bucket.json(TAGS_MAP)).toEqual({ posts: [shared] });
    });

    it('adds such a key back under the tags the new build gave the page', async () => {
      const getFiles = bucket.getFiles.bind(bucket);
      let listings = 0;
      vi.spyOn(bucket, 'getFiles').mockImplementation(async (query) => {
        const result = await getFiles(query);
        if (++listings === 2) {
          // The other instance caches `shared` under a new tag, and its flush adds the key there.
          bucket.putJson(
            objectOf(shared),
            { value: page(['news']), lastModified: 2, tags: ['news'] },
            { generation: 'test-build' }
          );
          bucket.putJson(TAGS_MAP, { posts: [shared, old], news: [shared] });
        }
        return result;
      });

      await newHandler().get(old, { kind: 'APP_PAGE' } as any);
      await waitForRouteCacheCleanupsForTests();

      expect(bucket.json(TAGS_MAP)).toEqual({ news: [shared] });
    });

    it('adds such a key back on a later instance when the add-back is not stored before the instance stops', async () => {
      const getFiles = bucket.getFiles.bind(bucket);
      let listings = 0;
      vi.spyOn(bucket, 'getFiles').mockImplementation(async (query) => {
        const result = await getFiles(query);
        listings++;
        if (listings === 2) {
          // Another new-build instance caches `shared` right after the prune listed it; its key is
          // already in tags.json, so its flush writes nothing.
          bucket.putJson(
            objectOf(shared),
            { value: page(['posts']), lastModified: 2, tags: ['posts'] },
            { generation: 'test-build' }
          );
        }
        if (listings === 3) {
          // The removals are stored; the write adding `shared` back fails.
          bucket.failWrites.set(TAGS_MAP, { code: 503, times: 1 });
        }
        return result;
      });
      const warn = vi.spyOn(console, 'warn');

      await newHandler().get(old, { kind: 'APP_PAGE' } as any);
      await waitForRouteCacheCleanupsForTests();

      expect(bucket.json(TAGS_MAP)).toEqual({});
      expect((bucket.json('route-cache-cleanup.json') as { pruned?: boolean }).pruned).toBeUndefined();
      expect(bucket.objects.has('route-cache-cleanup-removals.json')).toBe(true);
      expect(warn.mock.calls.some(([m]) => String(m).includes('adding back 1 route keys'))).toBe(true);

      // The instance stops with the add-back still queued; a later one finishes the prune.
      resetGcsSharedState();
      resetBuildInvalidationCheck();
      await newHandler().get(old, { kind: 'APP_PAGE' } as any);
      await waitForRouteCacheCleanupsForTests();

      expect(bucket.json(TAGS_MAP)).toEqual({ posts: [shared] });
      expect(bucket.objects.has('route-cache-cleanup.json')).toBe(false);
      expect(bucket.objects.has('route-cache-cleanup-removals.json')).toBe(false);
    });

    it("counts the prune as stored when other requests' updates arrive during its write", async () => {
      // Each tags.json write queues another request's update, so the buffer is never empty after a flush.
      const real = bucket.file.bind(bucket);
      let queued = 0;
      vi.spyOn(bucket, 'file').mockImplementation((name, options) => {
        const file = real(name, options);
        if (name !== TAGS_MAP) return file;
        return {
          ...file,
          save: async (data: string, saveOptions?: any) => {
            await file.save(data, saveOptions);
            if (++queued <= 2) {
              await newHandler().set(
                `/route-cache/APP_PAGE/other-${queued}`,
                page(['nav']) as any,
                {
                  tags: ['nav'],
                } as any
              );
            }
          },
        };
      });
      const warn = vi.spyOn(console, 'warn');

      await newHandler().get(shared, { kind: 'APP_PAGE' } as any);
      await waitForRouteCacheCleanupsForTests();

      expect(bucket.objects.has('route-cache-cleanup.json')).toBe(false);
      expect((bucket.json(TAGS_MAP) as Record<string, string[]>).posts ?? []).toEqual([]);
      expect(warn.mock.calls.some(([m]) => String(m).includes('is not stored yet'))).toBe(false);
    });

    it('does not count the prune as stored when the buffer drops its removals', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      try {
        let release!: () => void;
        const released = new Promise<void>((resolve) => (release = resolve));
        const getFiles = bucket.getFiles.bind(bucket);
        vi.spyOn(bucket, 'getFiles').mockImplementation(async (query) => {
          await released;
          return getFiles(query);
        });
        await newHandler().get(shared, { kind: 'APP_PAGE' } as any);

        // tags.json writes keep failing, and a fetch entry's update has been waiting longer than the buffer
        // keeps one. A fetch key, so the prune's removals all queue together and are dropped together.
        bucket.failWrites.set(TAGS_MAP, { code: 503, times: 100 });
        const fetched = { kind: 'FETCH', data: { headers: {}, body: '', status: 200, url: '' }, revalidate: 60 };
        await newHandler().set('a1b2c3', fetched as any, { tags: ['nav'], fetchCache: true } as any);
        vi.setSystemTime(Date.now() + 11 * 60_000);
        const warn = vi.spyOn(console, 'warn');

        release();
        await waitForRouteCacheCleanupsForTests();

        expect(bucket.json(TAGS_MAP)).toEqual({ posts: [shared, old] });
        expect(bucket.json('route-cache-cleanup.json')).toMatchObject({ deleted: true });
        expect((bucket.json('route-cache-cleanup.json') as { pruned?: boolean }).pruned).toBeUndefined();
        expect(warn.mock.calls.some(([m]) => String(m).includes('is not stored yet'))).toBe(true);
        expect(warn.mock.calls.some(([m]) => String(m).includes('Removed'))).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('URLs the CDN caches', () => {
    function writeBuild(config: object, buildId = 'build-1') {
      fs.writeFileSync(path.join(serverDistDir, '..', 'required-server-files.json'), JSON.stringify({ config }));
      fs.writeFileSync(path.join(serverDistDir, '..', 'BUILD_ID'), buildId);
    }

    it('purges the data route with a Pages Router page (gap C)', async () => {
      writeBuild({});
      await newHandler().set(
        '/route-cache/PAGES/h/$/pages-isr/london',
        { kind: 'PAGES', html: '', pageData: {} } as any,
        {
          tags: [],
        } as any
      );
      await settle();

      expect(purgedPaths()).toEqual(['/_next/data/build-1/pages-isr/london.json', '/pages-isr/london']);
    });

    it('does not purge a data route for an App Router page', async () => {
      writeBuild({});
      await newHandler().set('/route-cache/APP_PAGE/h/$/tags', page([]) as any, { tags: [] } as any);
      await settle();

      expect(purgedPaths()).toEqual(['/tags']);
    });

    it('purges the trailing-slash URL with trailingSlash (gap D)', async () => {
      writeBuild({ trailingSlash: true });
      bucket.putJson(TAGS_MAP, {
        inventory: ['/route-cache/APP_PAGE/h/$/tags', '/route-cache/APP_ROUTE/h/$/sitemap.xml'],
      });

      await newHandler().revalidateTag(['inventory', '_N_T_/about']);
      await settle();

      expect(purgedPaths()).toEqual(['/about/', '/sitemap.xml', '/tags/']);
    });

    it('purges the decoded URL of a key with an escaped path delimiter', async () => {
      writeBuild({ trailingSlash: true });
      bucket.putJson(TAGS_MAP, {
        faq: ['/route-cache/APP_PAGE/h/$/what%3F', '/route-cache/APP_PAGE/h/$/docs/a%2Fb'],
      });

      await newHandler().revalidateTag('faq');
      await settle();

      expect(purgedPaths()).toEqual(['/docs/a/b/', '/what?/']);
    });

    it('prefixes basePath', async () => {
      writeBuild({ basePath: '/docs' });
      await newHandler().set(
        '/route-cache/PAGES/h/$/index',
        { kind: 'PAGES', html: '', pageData: {} } as any,
        {
          tags: [],
        } as any
      );
      await settle();

      expect(purgedPaths()).toEqual(['/docs', '/docs/_next/data/build-1/index.json']);
    });

    it('purges the data route Next serves for a page under /index', async () => {
      writeBuild({});
      await newHandler().set(
        '/route-cache/PAGES/h/$/index/index/foo',
        { kind: 'PAGES', html: '', pageData: {} } as any,
        {
          tags: [],
        } as any
      );
      await settle();

      expect(purgedPaths()).toEqual(['/_next/data/build-1/index/index/foo.json', '/index/foo']);
    });

    it('also purges the unprefixed URL of a default-locale Pages Router page', async () => {
      writeBuild({ trailingSlash: true, i18n: { locales: ['en', 'fr'], defaultLocale: 'en' } });
      const handler = newHandler();
      for (const key of [
        '/route-cache/PAGES/h/$/en/blog',
        '/route-cache/PAGES/h/$/en',
        '/route-cache/PAGES/h/$/fr/blog',
      ]) {
        await handler.set(key, { kind: 'PAGES', html: '', pageData: {} } as any, { tags: [] } as any);
      }
      await settle();

      expect(purgedPaths()).toEqual([
        '/',
        '/_next/data/build-1/en.json',
        '/_next/data/build-1/en/blog.json',
        '/_next/data/build-1/fr/blog.json',
        '/blog/',
        '/en/',
        '/en/blog/',
        '/fr/blog/',
      ]);
    });
  });
});
