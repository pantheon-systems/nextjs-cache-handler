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
import { resetBuildPrerenderTagsForTests } from '../../src/utils/build-prerender-tags.js';
import { resetSharedRevalidationsForTests } from '../../src/utils/shared-revalidations.js';
import { resetSiteUrlConfigForTests } from '../../src/utils/site-urls.js';

vi.stubGlobal('fetch', vi.fn());

const REVALIDATIONS = 'cache/tags/revalidations.json';
const TAGS_MAP = 'cache/tags/tags.json';
const settle = () => new Promise((r) => setTimeout(r, 50));

/** Decoded `…/cache/paths/<p>` purges sent, with the leading slash edge-cache-clearer restores. */
function purgedPaths(): string[] {
  return vi
    .mocked(fetch)
    .mock.calls.map(([url]) => String(url))
    .filter((url) => url.includes('/cache/paths/'))
    .map((url) => decodeURIComponent(decodeURIComponent(url.slice(url.indexOf('/cache/paths/') + 13))))
    .map((p) => (p.startsWith('/') ? p : `/${p}`))
    .sort();
}

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

      await flushGcsTagsMapping();
      await settle();

      expect(bucket.json(TAGS_MAP)).toEqual({ 'stations:santiago': [santiago] });
      expect(purgedPaths()).toEqual(['/isr-fallback/americas/santiago']);
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
