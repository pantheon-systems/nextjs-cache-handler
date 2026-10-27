import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { pagedObjects, pagedObjectsNamed } from '../helpers/paged-objects.js';
import { toObjectName } from '../../src/utils/object-names.js';
import { setRetryBaseDelayForTests } from '../../src/utils/gcs-delete-prefix.js';
import { PURGE_RETRY_DELAY_MS } from '../../src/utils/route-cache-cleanup.js';

// Route/ISR invalidation keyed on the generation ID (build ID + optional deployment ID).
let mockGenerationId = 'build-A';
vi.mock('../../src/utils/build-detection.js', () => ({
  getBuildId: () => mockGenerationId,
  getCacheGenerationId: () => mockGenerationId,
  isBuildPhase: () => false,
}));

const store: Record<string, string> = {};
// Keys whose download fails with a transient error.
const failingReads = new Set<string>();
const mockBucket = {
  file: vi.fn((key: string) => ({
    exists: vi.fn(async () => [key in store]),
    getMetadata: vi.fn(async () => {
      if (!(key in store)) throw Object.assign(new Error('No such object'), { code: 404 });
      return [{ generation: '1' }];
    }),
    download: vi.fn(async () => {
      if (failingReads.has(key)) throw Object.assign(new Error('Service unavailable'), { code: 503 });
      if (!(key in store)) throw Object.assign(new Error('No such object'), { code: 404 });
      return [Buffer.from(store[key])];
    }),
    save: vi.fn(async (data: string) => {
      store[key] = data;
    }),
    delete: vi.fn(async () => {
      delete store[key];
    }),
  })),
  getFiles: vi.fn(),
};
vi.mock('@google-cloud/storage', () => ({
  Storage: function Storage() {
    return { bucket: () => mockBucket };
  },
  Bucket: vi.fn(),
}));
vi.stubGlobal('fetch', vi.fn());

const { GcsCacheHandler, resetGcsSharedState, waitForRouteCacheCleanupsForTests } =
  await import('../../src/handlers/gcs.js');
const { FileCacheHandler } = await import('../../src/handlers/file.js');
const { resetBuildInvalidationCheck } = await import('../../src/handlers/base.js');

const DPL_BUILD = 'build-TfctsWXpff2fKS';

// Each scenario: [name, stored meta (undefined = none), current id, expect invalidation]
const scenarios: Array<[string, string | undefined, string, boolean]> = [
  ['17 unchanged, no deployment ID', 'build-A', 'build-A', false],
  ['18 changed build, no deployment ID', 'build-A', 'build-B', true],
  ['19 same build, deployment ID changed (the bug)', `${DPL_BUILD}:dpl-1`, `${DPL_BUILD}:dpl-2`, true],
  ['20 same build and deployment ID', `${DPL_BUILD}:dpl-1`, `${DPL_BUILD}:dpl-1`, false],
  ['21 upgrade, plain meta and no deployment ID', 'build-A', 'build-A', false],
  ['22 plain meta, deployment ID now present', DPL_BUILD, `${DPL_BUILD}:dpl-1`, true],
  ['23 first run, no meta', undefined, 'build-A', false],
];

describe('GcsCacheHandler build invalidation', () => {
  beforeEach(() => {
    for (const k of Object.keys(store)) delete store[k];
    failingReads.clear();
    process.env.CACHE_BUCKET = 'test-bucket';
    process.env.PANTHEON_ENVIRONMENT = 'pr-42';
    process.env.OUTBOUND_PROXY_ENDPOINT = 'proxy.example.com:8080';
    vi.clearAllMocks();
    vi.mocked(fetch).mockResolvedValue({ ok: true, status: 200 } as Response);
    mockBucket.getFiles.mockResolvedValue([[]]);
    resetBuildInvalidationCheck();
    resetGcsSharedState();
  });

  afterEach(() => {
    delete process.env.CACHE_BUCKET;
    delete process.env.PANTHEON_ENVIRONMENT;
    delete process.env.OUTBOUND_PROXY_ENDPOINT;
  });

  it.each(scenarios)('%s', async (_name, stored, current, invalidates) => {
    const metaKey = 'environments/pr-42/build-meta.json';
    if (stored !== undefined) store[metaKey] = JSON.stringify({ buildId: stored, timestamp: 1 });
    mockGenerationId = current;

    const handler = new GcsCacheHandler({} as any);
    await handler.get('k');
    await waitForRouteCacheCleanupsForTests();

    if (invalidates) {
      expect(mockBucket.getFiles).toHaveBeenCalledWith(
        expect.objectContaining({ prefix: 'environments/pr-42/route-cache/', autoPaginate: false })
      );
      expect(fetch).toHaveBeenCalledWith(
        expect.stringContaining('/rest/v0alpha1/cache'),
        expect.objectContaining({ method: 'DELETE' })
      );
      expect(JSON.parse(store[metaKey]).buildId).toBe(current);
      for (const [args] of mockBucket.getFiles.mock.calls) {
        expect(args.prefix).toMatch(/^environments\/pr-42\//);
      }
    } else {
      expect(mockBucket.getFiles).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
    }
    if (stored === undefined) expect(JSON.parse(store[metaKey]).buildId).toBe(current);
  });

  it('leaves the check to the next handler when build-meta.json cannot be read, then invalidates', async () => {
    const metaKey = 'environments/pr-42/build-meta.json';
    store[metaKey] = JSON.stringify({ buildId: 'build-A', timestamp: 1 });
    mockGenerationId = 'build-B';
    failingReads.add(metaKey);

    await new GcsCacheHandler({} as any).get('k');
    await waitForRouteCacheCleanupsForTests();

    // Not treated as a first run: no new generation recorded, nothing wiped or purged yet.
    expect(JSON.parse(store[metaKey]).buildId).toBe('build-A');
    expect(mockBucket.getFiles).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();

    failingReads.delete(metaKey);
    await new GcsCacheHandler({} as any).get('k');
    await waitForRouteCacheCleanupsForTests();

    expect(mockBucket.getFiles).toHaveBeenCalledWith(
      expect.objectContaining({ prefix: 'environments/pr-42/route-cache/', autoPaginate: false })
    );
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining('/rest/v0alpha1/cache'),
      expect.objectContaining({ method: 'DELETE' })
    );
    expect(JSON.parse(store[metaKey]).buildId).toBe('build-B');
  });

  it('treats build-meta.json that is not valid JSON as a different build', async () => {
    const metaKey = 'environments/pr-42/build-meta.json';
    store[metaKey] = 'not json';
    mockGenerationId = 'build-A';

    await new GcsCacheHandler({} as any).get('k');
    await waitForRouteCacheCleanupsForTests();

    expect(mockBucket.getFiles).toHaveBeenCalledWith(
      expect.objectContaining({ prefix: 'environments/pr-42/route-cache/', autoPaginate: false })
    );
    expect(fetch).toHaveBeenCalled();
    expect(JSON.parse(store[metaKey]).buildId).toBe('build-A');
  });

  describe('at scale', () => {
    const metaKey = 'environments/pr-42/build-meta.json';
    const jobKey = 'environments/pr-42/route-cache-cleanup.json';
    const tagsKey = 'environments/pr-42/cache/tags/tags.json';
    const routePrefix = 'environments/pr-42/route-cache/';
    const fullPurges = () =>
      vi.mocked(fetch).mock.calls.filter(([url]) => url === 'http://proxy.example.com:8080/rest/v0alpha1/cache');
    const location = 'gs://test-bucket/environments/pr-42/route-cache/';
    const leftovers = 'The objects left behind are not served; the next deploy deletes them.';
    const throttled =
      'GCS throttled or was unavailable after retries; a lower CACHE_INVALIDATION_DELETE_CONCURRENCY (now 50) reduces throttling.';
    const denied =
      'Permission denied: the service account needs storage.objects.delete and storage.objects.list on gs://test-bucket.';
    let warn: ReturnType<typeof vi.spyOn>;
    let error: ReturnType<typeof vi.spyOn>;
    /** Messages logged to `spy`, with durations replaced by N. */
    const logged = (spy: ReturnType<typeof vi.spyOn>) =>
      spy.mock.calls.map(([message]) => String(message).replace(/in \d+ms/, 'in Nms'));
    const finished = (deleted: number, listed: number, kept = 0, failed = 0, runs = 1) =>
      `[GcsCacheHandler] Route cache clean-up for build build-B finished: deleted ${deleted} objects of earlier ` +
      `builds (${listed} listed, ${kept} of this build kept, 0 rewritten during the delete kept), ${failed} failed, ` +
      `in Nms over ${runs} run${runs === 1 ? '' : 's'}`;
    /** Serve one request on a fresh handler, then wait for the clean-up it started. */
    const serve = async () => {
      await new GcsCacheHandler({} as any).get('k');
      await waitForRouteCacheCleanupsForTests();
    };

    beforeAll(() => setRetryBaseDelayForTests(0));
    afterAll(() => setRetryBaseDelayForTests(1000));

    beforeEach(() => {
      store[metaKey] = JSON.stringify({ buildId: 'build-A', timestamp: 1 });
      mockGenerationId = 'build-B';
      warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      error = vi.spyOn(console, 'error').mockImplementation(() => {});
    });

    afterEach(() => {
      warn.mockRestore();
      error.mockRestore();
      delete process.env.CACHE_INVALIDATION_DELETE_CONCURRENCY;
      delete process.env.CACHE_BUILD_INVALIDATION;
    });

    /** Build meta saves, each with how many route objects were left when it was written. */
    function recordMetaWrites(objects: { live: Set<string> }) {
      const writes: number[] = [];
      const original = mockBucket.file.getMockImplementation()!;
      mockBucket.file.mockImplementation((key: string) => {
        const file = original(key);
        if (key === metaKey) {
          const save = file.save;
          file.save = vi.fn(async (data: string) => {
            writes.push(objects.live.size);
            return save(data);
          });
        }
        return file;
      });
      return { writes, restore: () => mockBucket.file.mockImplementation(original) };
    }

    it('records the build and answers before the delete, then deletes a page at a time in the background', async () => {
      process.env.CACHE_INVALIDATION_DELETE_CONCURRENCY = '20';
      const objects = pagedObjects(routePrefix, 3500);
      // Listings wait until released, so the request can be shown to finish first.
      let release!: () => void;
      const released = new Promise<void>((resolve) => (release = resolve));
      mockBucket.getFiles.mockImplementation(async (query) => {
        await released;
        return objects.getFiles(query);
      });
      const meta = recordMetaWrites(objects);

      try {
        await new GcsCacheHandler({} as any).get('k');
        expect(meta.writes).toEqual([3500]); // recorded before anything was deleted
        expect(fullPurges()).toHaveLength(1);
        expect(JSON.parse(store[metaKey]).buildId).toBe('build-B');
        expect(objects.live.size).toBe(3500);

        release();
        await waitForRouteCacheCleanupsForTests();
      } finally {
        meta.restore();
      }

      expect(objects.live.size).toBe(0);
      expect(objects.stats()).toMatchObject({ maxInFlight: 20, maxPage: 1000, pages: 5 }); // 4 to delete, 1 to prune
      for (const [args] of mockBucket.getFiles.mock.calls) {
        expect(args).toMatchObject({ prefix: routePrefix, autoPaginate: false, maxResults: 1000 });
      }
      expect(logged(warn)).toContain(finished(3500, 3500));
      expect(store[jobKey]).toBeUndefined();
      expect(fullPurges()).toHaveLength(1);
    });

    it("keeps the current build's objects, and their keys in tags.json", async () => {
      const current = `${routePrefix}${toObjectName('/en/blog')}.json`;
      const objects = pagedObjectsNamed(
        Array.from({ length: 10 }, (_, i) => `${routePrefix}old-${i}.json`),
        { customMetadata: () => ({ generation: 'build-A' }) }
      );
      objects.rewrite(current, { generation: 'build-B' }); // cached by an instance of the new build
      mockBucket.getFiles.mockImplementation(objects.getFiles);
      store[tagsKey] = JSON.stringify({ posts: ['/en/blog', '/en/old', 'a1b2c3'] });

      await serve();

      expect([...objects.live]).toEqual([current]);
      expect(JSON.parse(store[tagsKey])).toEqual({ posts: ['/en/blog', 'a1b2c3'] });
      expect(logged(warn)).toContain(
        `[GcsCacheHandler] Removed 1 route keys of earlier builds from gs://test-bucket/${tagsKey}`
      );
    });

    it('warns about deletes that still fail after a retry, with the fix', async () => {
      const objects = pagedObjects(routePrefix, 100, { failDelete: (i) => i < 3 });
      mockBucket.getFiles.mockImplementation(objects.getFiles);

      await serve();

      expect(logged(warn)).toContain(`${finished(97, 100, 0, 3)} (503 x3). ${leftovers} ${throttled}`);
      expect(error).not.toHaveBeenCalled(); // transient: the next deploy cleans up
      expect(objects.deleteAttempts.get(`${routePrefix}0000000.json`)).toBe(2);
      expect(JSON.parse(store[metaKey]).buildId).toBe('build-B');
    });

    it('says the service account lacks permission when deletes are denied', async () => {
      const objects = pagedObjects(routePrefix, 10, { deleteStatus: () => 403 });
      mockBucket.getFiles.mockImplementation(objects.getFiles);

      await serve();

      expect(logged(error)).toEqual([`${finished(0, 10, 0, 10)} (403 x10). ${leftovers} ${denied}`]);
      expect(objects.deleteAttempts.get(`${routePrefix}0000000.json`)).toBe(1); // not retried
    });

    it('logs nothing at error level when a retried delete succeeds', async () => {
      const objects = pagedObjects(routePrefix, 10, {
        deleteStatus: (_i, attempt) => (attempt === 1 ? 429 : undefined),
      });
      mockBucket.getFiles.mockImplementation(objects.getFiles);

      await serve();

      expect(error).not.toHaveBeenCalled();
      expect(logged(warn)).toContain(finished(10, 10));
    });

    it('a later instance finishes when the instance deleting dies part-way', async () => {
      const objects = pagedObjects(routePrefix, 3500);
      // Run 1: the third page never comes back, standing in for the process dying.
      mockBucket.getFiles.mockImplementation(async (query) =>
        objects.stats().pages < 2 ? objects.getFiles(query) : new Promise(() => {})
      );
      await new GcsCacheHandler({} as any).get('k');
      await vi.waitFor(() => expect(objects.deleted.size).toBe(2000));

      expect(JSON.parse(store[metaKey]).buildId).toBe('build-B'); // recorded before the delete
      expect(fullPurges()).toHaveLength(1);

      // Run 2: a fresh process, after the dead one's lock expired.
      resetGcsSharedState();
      resetBuildInvalidationCheck();
      store[jobKey] = JSON.stringify({ ...JSON.parse(store[jobKey]), expiresAt: 0 });
      mockBucket.getFiles.mockImplementation(objects.getFiles);
      const listedBefore = objects.getFiles.mock.calls.length;
      await serve();

      expect(objects.live.size).toBe(0);
      expect(objects.getFiles.mock.calls.length - listedBefore).toBe(3); // the 1500 left, then the pruning listing
      expect(logged(warn)).toContain(finished(1500, 1500, 0, 0, 2));
      expect(fullPurges()).toHaveLength(1); // the build was already recorded and purged
      expect(store[jobKey]).toBeUndefined();
    });

    it('logs how far it got when listing keeps failing, and keeps the job for a later instance', async () => {
      const objects = pagedObjects(routePrefix, 2500, { deleteStatus: (i) => (i === 0 ? 403 : undefined) });
      mockBucket.getFiles
        .mockImplementationOnce(objects.getFiles)
        .mockRejectedValue(Object.assign(new Error('unavailable'), { code: 503 }));

      await serve();

      expect(mockBucket.getFiles).toHaveBeenCalledTimes(4); // one page, then three attempts at the next
      expect(logged(warn)).toContain(
        `[GcsCacheHandler] Route cache clean-up for build build-B stopped (listing ${routePrefix} failed after 3 ` +
          `attempts (503: unavailable)); the next run resumes it after ${routePrefix}0000999.json. Objects left ` +
          'behind are not served.'
      );
      expect(JSON.parse(store[jobKey])).toMatchObject({
        keep: 'build-B',
        cursor: `${routePrefix}0000999.json`,
        totals: { deleted: 999, failed: 1, runs: 1 },
      });
      expect(JSON.parse(store[jobKey]).owner).toBeUndefined();
      expect(fullPurges()).toHaveLength(1);
      expect(JSON.parse(store[metaKey]).buildId).toBe('build-B');
    });

    it('does nothing for a fallback build ID', async () => {
      mockGenerationId = 'fallback-123';

      await serve();

      expect(mockBucket.getFiles).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
      expect(JSON.parse(store[metaKey]).buildId).toBe('build-A');
      expect(logged(warn)).toEqual([
        '[GcsCacheHandler] BUILD_ID unreadable (generation fallback-123); skipping build invalidation. Neither ' +
          `.next/BUILD_ID nor .next/build-manifest.json is readable under ${process.cwd()}, so a new build is not ` +
          'detected: on a deploy the route cache is not deleted, the CDN is not purged, and route entries from ' +
          'earlier builds are served. Start the server from the directory that contains .next.',
      ]);
    });

    it('does nothing for a fallback build ID with a deployment ID', async () => {
      mockGenerationId = 'fallback-123:dpl-1';

      await serve();

      expect(mockBucket.getFiles).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
      expect(JSON.parse(store[metaKey]).buildId).toBe('build-A');
    });

    it('deletes nothing with CACHE_BUILD_INVALIDATION=off, but purges, records the build and prunes tags.json', async () => {
      process.env.CACHE_BUILD_INVALIDATION = 'off';
      const objects = pagedObjects(routePrefix, 10);
      mockBucket.getFiles.mockImplementation(objects.getFiles);
      store[tagsKey] = JSON.stringify({ posts: ['/en/blog', 'a1b2c3'] });

      await serve();

      expect(objects.deleted.size).toBe(0);
      expect(JSON.parse(store[tagsKey])).toEqual({ posts: ['a1b2c3'] });
      expect(fullPurges()).toHaveLength(1);
      expect(JSON.parse(store[metaKey]).buildId).toBe('build-B');
      expect(logged(warn)).toContain(
        `[GcsCacheHandler] CACHE_BUILD_INVALIDATION=off: ${location} is not deleted for the new build. Its ` +
          'entries from earlier builds are not served (they count as cache misses), but stay in storage until a ' +
          'deploy runs without CACHE_BUILD_INVALIDATION=off.'
      );
    });

    it("removes the previous build's route keys from tags.json once every object is deleted", async () => {
      store[tagsKey] = JSON.stringify({ posts: ['/en/blog', '/EN/Blog', 'a1b2c3'], nav: ['/en/blog'] });
      const objects = pagedObjects(routePrefix, 10);
      mockBucket.getFiles.mockImplementation(objects.getFiles);

      await serve();

      expect(JSON.parse(store[tagsKey])).toEqual({ posts: ['a1b2c3'] }); // fetch keys survive deploys
      expect(logged(warn)).toContain(
        '[GcsCacheHandler] Removed 2 route keys of earlier builds from gs://test-bucket/' + tagsKey
      );
      expect(error).not.toHaveBeenCalled();
    });

    it('removes route keys from tags.json even when some objects could not be deleted', async () => {
      store[tagsKey] = JSON.stringify({ posts: ['/en/blog', 'a1b2c3'] });
      const objects = pagedObjects(routePrefix, 10, { deleteStatus: (i) => (i === 0 ? 403 : undefined) });
      mockBucket.getFiles.mockImplementation(objects.getFiles);

      await serve();

      expect(JSON.parse(store[tagsKey])).toEqual({ posts: ['a1b2c3'] });
    });

    it('keeps the job when tags.json is unreadable, and a later instance prunes it', async () => {
      store[tagsKey] = JSON.stringify({ posts: ['/en/blog'] });
      failingReads.add(tagsKey);

      await serve();

      expect(logged(warn)).toContain(
        '[GcsCacheHandler] Route cache clean-up for build build-B stopped (503: Service unavailable); the next ' +
          'run prunes the tags map. Objects left behind are not served.'
      );
      expect(JSON.parse(store[jobKey])).toMatchObject({ keep: 'build-B', deleted: true });
      expect(JSON.parse(store[metaKey]).buildId).toBe('build-B');

      failingReads.delete(tagsKey);
      resetGcsSharedState();
      resetBuildInvalidationCheck();
      await serve();
      expect(JSON.parse(store[tagsKey])).toEqual({});
      expect(store[jobKey]).toBeUndefined();
    });

    it('retries a failed CDN purge in the background, once the retry delay has passed', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      try {
        vi.mocked(fetch).mockResolvedValueOnce({ ok: false, status: 502, statusText: 'Bad Gateway' } as Response);

        await serve();

        expect(logged(error)).toEqual([
          expect.stringMatching(
            /^\[GcsCacheHandler\] Edge cache purge on build invalidation failed: .+\. The background clean-up retries it \(up to 5 runs\); until then, pages from the previous build stay in the CDN\.$/
          ),
        ]);
        expect(fullPurges()).toHaveLength(1);
        expect(JSON.parse(store[jobKey])).toMatchObject({ purgePending: true, pruned: true });

        vi.setSystemTime(Date.now() + PURGE_RETRY_DELAY_MS);
        await serve();

        expect(fullPurges()).toHaveLength(2);
        expect(logged(warn)).toContain(
          '[GcsCacheHandler] CDN purge for build build-B, which failed when the build was recorded, has now been sent'
        );
        expect(store[jobKey]).toBeUndefined();
      } finally {
        vi.useRealTimers();
      }
    });

    it('says a failed CDN purge is not retried when the clean-up job cannot be recorded', async () => {
      vi.mocked(fetch).mockResolvedValueOnce({ ok: false, status: 502, statusText: 'Bad Gateway' } as Response);
      store[jobKey] = JSON.stringify({ keep: 'build-A', deleteEntries: true, createdAt: 1, totals: {} });
      failingReads.add(jobKey);

      await serve();

      // Then the background run cannot read the job either.
      expect(logged(error)).toEqual([
        expect.stringMatching(
          /^\[GcsCacheHandler\] Could not record the route cache clean-up .+ until the next deploy\. Edge cache purge on build invalidation failed: .+\. It is not retried, so pages from the previous build stay in the CDN until they expire or the site's edge cache is cleared\.$/
        ),
        '[GcsCacheHandler] Could not take the route cache clean-up job; the next check retries it:',
      ]);
      expect(fullPurges()).toHaveLength(1);
    });

    it('clamps CACHE_INVALIDATION_DELETE_CONCURRENCY to 200', async () => {
      process.env.CACHE_INVALIDATION_DELETE_CONCURRENCY = '500';
      const objects = pagedObjects(routePrefix, 1000);
      mockBucket.getFiles.mockImplementation(objects.getFiles);

      await serve();

      expect(objects.live.size).toBe(0);
      expect(objects.stats().maxInFlight).toBe(200);
    });
  });
});

describe('FileCacheHandler build invalidation', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'build-inval-'));
    vi.spyOn(process, 'cwd').mockReturnValue(tempDir);
    resetBuildInvalidationCheck();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it.each(scenarios)('%s', async (_name, stored, current, invalidates) => {
    const metaFile = path.join(tempDir, '.cache', 'build-meta.json');
    const sentinel = path.join(tempDir, '.next', 'cache', 'route-cache', 'sentinel.json');
    fs.mkdirSync(path.dirname(sentinel), { recursive: true });
    fs.writeFileSync(sentinel, '{}');
    if (stored !== undefined) {
      fs.mkdirSync(path.dirname(metaFile), { recursive: true });
      fs.writeFileSync(metaFile, JSON.stringify({ buildId: stored, timestamp: 1 }));
    }
    mockGenerationId = current;

    // get() waits for the build check.
    await new FileCacheHandler({} as any).get('k');

    expect(fs.existsSync(sentinel)).toBe(!invalidates);
    expect(JSON.parse(fs.readFileSync(metaFile, 'utf-8')).buildId).toBe(
      stored === undefined || invalidates ? current : stored
    );
  });

  function setUp(meta: (metaFile: string) => void) {
    const metaFile = path.join(tempDir, '.cache', 'build-meta.json');
    const sentinel = path.join(tempDir, '.next', 'cache', 'route-cache', 'sentinel.json');
    fs.mkdirSync(path.dirname(sentinel), { recursive: true });
    fs.writeFileSync(sentinel, '{}');
    fs.mkdirSync(path.dirname(metaFile), { recursive: true });
    meta(metaFile);
    return { metaFile, sentinel };
  }

  it('treats build metadata that is not valid JSON as a different build', async () => {
    const { metaFile, sentinel } = setUp((f) => fs.writeFileSync(f, 'not json'));
    mockGenerationId = 'build-A';

    await new FileCacheHandler({} as any).get('k');

    expect(fs.existsSync(sentinel)).toBe(false);
    expect(JSON.parse(fs.readFileSync(metaFile, 'utf-8')).buildId).toBe('build-A');
  });

  it('does not treat unreadable build metadata as a first run', async () => {
    // A directory where the file should be: reading it fails with EISDIR, not ENOENT.
    const { sentinel } = setUp((f) => fs.mkdirSync(f));
    mockGenerationId = 'build-A';
    const writeBuildMeta = vi.spyOn(FileCacheHandler.prototype as any, 'writeBuildMeta');

    await new FileCacheHandler({} as any).get('k');

    expect(writeBuildMeta).not.toHaveBeenCalled();
    expect(fs.existsSync(sentinel)).toBe(true);
  });

  it('retries the build check with the next handler after build metadata could not be read', async () => {
    const { metaFile, sentinel } = setUp((f) => fs.mkdirSync(f));
    mockGenerationId = 'build-A';

    await new FileCacheHandler({} as any).get('k');
    expect(fs.existsSync(sentinel)).toBe(true);

    // The read recovers; Next.js constructs a new handler for the next request.
    fs.rmdirSync(metaFile);
    fs.writeFileSync(metaFile, JSON.stringify({ buildId: 'build-old', timestamp: 1 }));
    await new FileCacheHandler({} as any).get('k');

    expect(fs.existsSync(sentinel)).toBe(false);
    expect(JSON.parse(fs.readFileSync(metaFile, 'utf-8')).buildId).toBe('build-A');
  });
});
