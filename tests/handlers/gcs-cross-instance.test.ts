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

import { tagsManifest } from 'next/dist/server/lib/incremental-cache/tags-manifest.external.js';
import { GcsCacheHandler, resetGcsSharedState, flushGcsTagsMapping } from '../../src/handlers/gcs.js';
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

    it('marks the entry stale, not expired, for a soft revalidation', async () => {
      const handler = newHandler();
      await handler.set('/route-cache/APP_PAGE/h/$/tags', page(['inventory']) as any, { tags: [] } as any);
      const at = Date.now() + 5;
      bucket.putJson(REVALIDATIONS, { inventory: { stale: at, expired: at + 3_600_000, at } });
      await new Promise((r) => setTimeout(r, 20));

      // Served (Next serves it stale and regenerates); tagsManifest carries the staleness.
      expect(await newHandler().get('/route-cache/APP_PAGE/h/$/tags', { kind: 'APP_PAGE' } as any)).not.toBeNull();
      expect(tagsManifest.get('inventory')).toEqual({ stale: at, expired: at + 3_600_000 });
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
    const nextRefresh = () => new Promise((r) => setTimeout(r, 150)); // past the 100 ms test interval

    it('purges the pages of a tag another instance revalidated once this one learns of it', async () => {
      bucket.putJson(TAGS_MAP, { inventory: [tagsKey] });
      await newHandler().get(tagsKey, { kind: 'APP_PAGE' } as any); // first read of the store
      expect(pathPurges()).toEqual([]);

      const at = Date.now();
      bucket.putJson(REVALIDATIONS, { inventory: { expired: at, at } });
      await nextRefresh();
      await newHandler().get(tagsKey, { kind: 'APP_PAGE' } as any);
      await settle(); // started by that request, not awaited by its cache read

      expect(pathPurges()).toEqual(['/tags']);
    });

    it('does not hold the cache read that learns of it for the purge', async () => {
      bucket.putJson(TAGS_MAP, { inventory: [tagsKey] });
      await newHandler().get(tagsKey, { kind: 'APP_PAGE' } as any);
      vi.mocked(fetch).mockImplementation(() => new Promise(() => {})); // the CDN never answers

      const at = Date.now();
      bucket.putJson(REVALIDATIONS, { inventory: { expired: at, at } });
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
      bucket.putJson(TAGS_MAP, { inventory: [tagsKey] });
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
  });
});
