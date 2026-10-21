import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { pagedObjectsNamed } from '../helpers/paged-objects.js';
import { setRetryBaseDelayForTests } from '../../src/utils/gcs-delete-prefix.js';

// clearSharedCache() and getSharedCacheStats() against a cache too large to list in one go.

let objects: ReturnType<typeof pagedObjectsNamed>;
/** Single objects read by name (tags map, build meta), as [size, contents]. */
const single = new Map<string, string>();
const notFound = () => Object.assign(new Error('HTTP 404'), { code: 404 });
const mockBucket = {
  getFiles: vi.fn((query: any) => objects.getFiles(query)),
  file: vi.fn((name: string) => ({
    exists: async () => [single.has(name)],
    delete: async () => {},
    getMetadata: async () => {
      if (!single.has(name)) throw notFound();
      return [{ size: String(Buffer.byteLength(single.get(name)!)) }];
    },
    download: async () => {
      if (!single.has(name)) throw notFound();
      return [Buffer.from(single.get(name)!)];
    },
  })),
};
vi.mock('@google-cloud/storage', () => ({
  Storage: function Storage() {
    return { bucket: () => mockBucket };
  },
  Bucket: vi.fn(),
  RETRYABLE_ERR_FN_DEFAULT: () => false,
}));
vi.mock('../../src/utils/static-routes.js', () => ({
  getStaticRoutes: () => new Set(['static-a', 'static-b']),
}));
vi.stubGlobal('fetch', vi.fn());

const { clearSharedCache, getSharedCacheCounts, getSharedCacheStats, resetGcsSharedState } =
  await import('../../src/handlers/gcs.js');

const ROUTES = 100_000;
const FETCHES = 1000;
const IMAGES = 500;

function names(prefix: string, count: number): string[] {
  return Array.from({ length: count }, (_, i) => `${prefix}${String(i).padStart(7, '0')}.json`);
}

describe('GCS shared cache functions at scale', () => {
  beforeEach(() => {
    process.env.CACHE_BUCKET = 'test-bucket';
    delete process.env.PANTHEON_ENVIRONMENT;
    resetGcsSharedState();
    single.clear();
    objects = pagedObjectsNamed([
      ...names('route-cache/', ROUTES),
      'route-cache/static-a.json',
      'route-cache/static-b.json',
      'route-cache/not-an-entry.txt',
      ...names('fetch-cache/', FETCHES),
      ...names('image-cache/', IMAGES),
    ]);
  });

  afterEach(() => {
    delete process.env.CACHE_BUCKET;
  });

  it('clearSharedCache deletes a page at a time, keeps static routes and counts what it cleared', async () => {
    const cleared = await clearSharedCache();

    expect(cleared).toBe(ROUTES + FETCHES + IMAGES);
    expect([...objects.live].sort()).toEqual([
      'route-cache/not-an-entry.txt',
      'route-cache/static-a.json',
      'route-cache/static-b.json',
    ]);
    expect(objects.stats().maxInFlight).toBe(50);
    expect(objects.stats().maxPage).toBe(1000);
  });

  it('clearSharedCache logs deletes that fail, with the fix', async () => {
    objects = pagedObjectsNamed(names('fetch-cache/', 10), { deleteStatus: (i) => (i < 2 ? 403 : undefined) });
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(await clearSharedCache()).toBe(8);
      expect(error.mock.calls.map(([message]) => message)).toEqual([
        '[GcsCacheHandler] clearSharedCache: 2 of the objects under gs://test-bucket/fetch-cache/ could not be ' +
          'deleted (403 x2; first error: HTTP 403) and are still served. Permission denied: the service account ' +
          'needs storage.objects.delete and storage.objects.list on gs://test-bucket. Run clearSharedCache() again ' +
          'to retry them.',
      ]);
    } finally {
      error.mockRestore();
    }
  });

  it('getSharedCacheStats lists a page at a time and bounds downloads in flight', async () => {
    const stats = await getSharedCacheStats();

    expect(stats.size).toBe(ROUTES + 2 + FETCHES + IMAGES);
    expect(stats.entries).toHaveLength(stats.size);
    expect(stats.entries[0]).toEqual({ key: 'fetch:0000000', tags: ['t'], lastModified: 1, type: 'fetch' });
    expect(objects.stats().maxInFlight).toBe(50);
    expect(objects.stats().maxPage).toBe(1000);
  });

  it('getSharedCacheStats reads at most `limit` entries per cache type', async () => {
    const stats = await getSharedCacheStats({ limit: 10 });

    expect(stats.keys.filter((k) => k.startsWith('fetch:'))).toHaveLength(10);
    expect(stats.keys.filter((k) => k.startsWith('route:'))).toHaveLength(10);
    expect(stats.keys.filter((k) => k.startsWith('image:'))).toHaveLength(10);
    expect(objects.getFiles).toHaveBeenCalledTimes(3); // one page per type, no more
  });

  describe('getSharedCacheCounts', () => {
    it('counts every object without downloading any, and route objects by build', async () => {
      objects = pagedObjectsNamed(
        [...names('route-cache/', ROUTES), ...names('fetch-cache/', FETCHES), ...names('image-cache/', IMAGES)],
        // Sorted: fetch, image, route. Of the routes, the first 60,000 are this build's.
        {
          customMetadata: (i) => {
            const route = i - FETCHES - IMAGES;
            if (route < 0) return undefined;
            return route < 60_000 ? { generation: 'build-B' } : route < 90_000 ? { generation: 'build-A' } : undefined;
          },
        }
      );
      single.set('cache/tags/tags.json', JSON.stringify({ posts: ['/a', '/b'] }));
      single.set('build-meta.json', JSON.stringify({ buildId: 'build-B', timestamp: 5, builtAt: 4 }));

      const counts = await getSharedCacheCounts();

      expect(counts).toEqual({
        route: { objects: ROUTES, byGeneration: { 'build-B': 60_000, 'build-A': 30_000, unstamped: 10_000 } },
        fetch: { objects: FETCHES },
        image: { objects: IMAGES },
        tagsMap: { bytes: Buffer.byteLength(JSON.stringify({ posts: ['/a', '/b'] })) },
        buildMeta: { buildId: 'build-B', timestamp: 5, builtAt: 4 },
      });
      expect(objects.stats().maxPage).toBe(1000);
      expect(objects.stats().maxInFlight).toBe(0); // no downloads or deletes
    });

    it('reports null for a missing tags map and build meta', async () => {
      objects = pagedObjectsNamed([]);

      expect(await getSharedCacheCounts()).toEqual({
        route: { objects: 0, byGeneration: {} },
        fetch: { objects: 0 },
        image: { objects: 0 },
        tagsMap: null,
        buildMeta: null,
      });
    });

    it('rejects when a listing fails, rather than reporting zeros', async () => {
      setRetryBaseDelayForTests(0);
      mockBucket.getFiles.mockRejectedValueOnce(Object.assign(new Error('denied'), { code: 403 }));
      try {
        await expect(getSharedCacheCounts()).rejects.toThrow(
          'listing route-cache/ failed after 1 attempt (403: denied)'
        );
      } finally {
        setRetryBaseDelayForTests(1000);
      }
    });
  });
});
