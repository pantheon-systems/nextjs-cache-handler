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

import { GcsCacheHandler, resetGcsSharedState } from '../../src/handlers/gcs.js';
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

      // Once now, once after every instance has applied the revalidation.
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
});
