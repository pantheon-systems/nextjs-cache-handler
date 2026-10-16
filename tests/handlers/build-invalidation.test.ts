import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { pagedObjects } from '../helpers/paged-objects.js';
import { setRetryBaseDelayForTests } from '../../src/utils/gcs-delete-prefix.js';

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

const { GcsCacheHandler } = await import('../../src/handlers/gcs.js');
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

    // Not treated as a first run: no new generation recorded, nothing wiped or purged yet.
    expect(JSON.parse(store[metaKey]).buildId).toBe('build-A');
    expect(mockBucket.getFiles).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();

    failingReads.delete(metaKey);
    await new GcsCacheHandler({} as any).get('k');

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

    expect(mockBucket.getFiles).toHaveBeenCalledWith(
      expect.objectContaining({ prefix: 'environments/pr-42/route-cache/', autoPaginate: false })
    );
    expect(fetch).toHaveBeenCalled();
    expect(JSON.parse(store[metaKey]).buildId).toBe('build-A');
  });

  describe('at scale', () => {
    const metaKey = 'environments/pr-42/build-meta.json';
    const routePrefix = 'environments/pr-42/route-cache/';
    const fullPurges = () =>
      vi.mocked(fetch).mock.calls.filter(([url]) => url === 'http://proxy.example.com:8080/rest/v0alpha1/cache');
    const location = 'gs://test-bucket/environments/pr-42/route-cache/';
    const leftovers =
      `The objects left in ${location} are not served (route entries from another build count as cache ` +
      'misses). Startup continues, and the next deploy deletes them.';
    const throttled =
      'GCS throttled or was unavailable after retries; a lower CACHE_INVALIDATION_DELETE_CONCURRENCY (now 50) reduces throttling.';
    const denied =
      'Permission denied: the service account needs storage.objects.delete and storage.objects.list on gs://test-bucket.';
    let warn: ReturnType<typeof vi.spyOn>;
    let error: ReturnType<typeof vi.spyOn>;
    /** Messages logged to `spy`, with durations replaced by N. */
    const logged = (spy: ReturnType<typeof vi.spyOn>) =>
      spy.mock.calls.map(([message]) => String(message).replace(/in \d+ms/, 'in Nms'));

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

    it('deletes a page at a time within the concurrency limit, then purges and records the build', async () => {
      process.env.CACHE_INVALIDATION_DELETE_CONCURRENCY = '20';
      const objects = pagedObjects(routePrefix, 3500);
      mockBucket.getFiles.mockImplementation(objects.getFiles);
      const meta = recordMetaWrites(objects);

      try {
        await new GcsCacheHandler({} as any).get('k');
      } finally {
        meta.restore();
      }

      expect(objects.live.size).toBe(0);
      expect(objects.stats()).toMatchObject({ maxInFlight: 20, maxPage: 1000, pages: 4 });
      for (const [args] of mockBucket.getFiles.mock.calls) {
        expect(args).toMatchObject({ prefix: routePrefix, autoPaginate: false, maxResults: 1000 });
      }
      expect(meta.writes).toEqual([0]); // once, after every delete
      expect(fullPurges()).toHaveLength(1);
      expect(warn).toHaveBeenCalledWith(
        expect.stringMatching(/Route cache invalidation: deleted 3500\/3500 objects in \d+ms$/)
      );
      expect(JSON.parse(store[metaKey]).buildId).toBe('build-B');
    });

    it('warns about deletes that still fail after a retry, with the fix, and still purges and records the build', async () => {
      const objects = pagedObjects(routePrefix, 100, { failDelete: (i) => i < 3 });
      mockBucket.getFiles.mockImplementation(objects.getFiles);

      await new GcsCacheHandler({} as any).get('k');

      expect(logged(warn)).toContain(
        '[GcsCacheHandler] Route cache invalidation: deleted 97/100 objects in Nms; 3 could not be deleted ' +
          `(503 x3; first error: HTTP 503). ${leftovers} ${throttled}`
      );
      expect(error).not.toHaveBeenCalled(); // transient: the next deploy cleans up
      expect(objects.deleteAttempts.get(`${routePrefix}0000000.json`)).toBe(2);
      expect(fullPurges()).toHaveLength(1);
      expect(JSON.parse(store[metaKey]).buildId).toBe('build-B');
    });

    it('says the service account lacks permission when deletes are denied', async () => {
      const objects = pagedObjects(routePrefix, 10, { deleteStatus: () => 403 });
      mockBucket.getFiles.mockImplementation(objects.getFiles);

      await new GcsCacheHandler({} as any).get('k');

      expect(logged(error)).toEqual([
        '[GcsCacheHandler] Route cache invalidation: deleted 0/10 objects in Nms; 10 could not be deleted ' +
          `(403 x10; first error: HTTP 403). ${leftovers} ${denied}`,
      ]);
      expect(objects.deleteAttempts.get(`${routePrefix}0000000.json`)).toBe(1); // not retried
    });

    it('logs nothing at error level when a retried delete succeeds', async () => {
      const objects = pagedObjects(routePrefix, 10, {
        deleteStatus: (_i, attempt) => (attempt === 1 ? 429 : undefined),
      });
      mockBucket.getFiles.mockImplementation(objects.getFiles);

      await new GcsCacheHandler({} as any).get('k');

      expect(error).not.toHaveBeenCalled();
      expect(logged(warn)).toContain('[GcsCacheHandler] Route cache invalidation: deleted 10/10 objects in Nms');
    });

    it('resumes on the next start when a process dies part-way through the delete', async () => {
      const objects = pagedObjects(routePrefix, 3500);
      // Run 1: the third page never comes back, standing in for the process dying.
      mockBucket.getFiles.mockImplementation(async (query) =>
        objects.stats().pages < 2 ? objects.getFiles(query) : new Promise(() => {})
      );
      new GcsCacheHandler({} as any);
      await vi.waitFor(() => expect(objects.deleted.size).toBe(2000));

      expect(JSON.parse(store[metaKey]).buildId).toBe('build-A'); // the new build is not recorded yet
      expect(fullPurges()).toHaveLength(0);

      // Run 2: a fresh process.
      resetBuildInvalidationCheck();
      mockBucket.getFiles.mockImplementation(objects.getFiles);
      const listedBefore = objects.getFiles.mock.calls.length;
      await new GcsCacheHandler({} as any).get('k');

      expect(objects.live.size).toBe(0);
      expect(objects.getFiles.mock.calls.length - listedBefore).toBe(2); // only the 1500 left
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(/deleted 1500\/1500 objects/));
      expect(fullPurges()).toHaveLength(1);
      expect(JSON.parse(store[metaKey]).buildId).toBe('build-B');
    });

    it('logs how far it got when listing keeps failing, and still purges and records the build', async () => {
      const objects = pagedObjects(routePrefix, 2500, { deleteStatus: (i) => (i === 0 ? 403 : undefined) });
      mockBucket.getFiles
        .mockImplementationOnce(objects.getFiles)
        .mockRejectedValue(Object.assign(new Error('unavailable'), { code: 503 }));

      await new GcsCacheHandler({} as any).get('k');

      expect(mockBucket.getFiles).toHaveBeenCalledTimes(4); // one page, then three attempts at the next
      expect(logged(error)).toEqual([
        `[GcsCacheHandler] Route cache invalidation stopped: listing ${routePrefix} failed after 3 attempts ` +
          '(503: unavailable), after deleting 999 of the 1000 objects listed so far (1 could not be deleted: 403 x1). ' +
          `${leftovers} ${denied} ${throttled}`,
      ]);
      expect(fullPurges()).toHaveLength(1);
      expect(JSON.parse(store[metaKey]).buildId).toBe('build-B');
    });

    it('does nothing for a fallback build ID', async () => {
      mockGenerationId = 'fallback-123';

      await new GcsCacheHandler({} as any).get('k');

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

      await new GcsCacheHandler({} as any).get('k');

      expect(mockBucket.getFiles).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
      expect(JSON.parse(store[metaKey]).buildId).toBe('build-A');
    });

    it('deletes nothing with CACHE_BUILD_INVALIDATION=off, but purges and records the build', async () => {
      process.env.CACHE_BUILD_INVALIDATION = 'off';

      await new GcsCacheHandler({} as any).get('k');

      expect(mockBucket.getFiles).not.toHaveBeenCalled();
      expect(fullPurges()).toHaveLength(1);
      expect(JSON.parse(store[metaKey]).buildId).toBe('build-B');
      expect(logged(warn)).toContain(
        `[GcsCacheHandler] CACHE_BUILD_INVALIDATION=off: ${location} was not deleted for the new build. Its ` +
          'entries from earlier builds are not served (they count as cache misses), but stay in storage until a ' +
          'deploy runs without CACHE_BUILD_INVALIDATION=off.'
      );
    });

    it("removes the previous build's route keys from tags.json once every object is deleted", async () => {
      const tagsKey = 'environments/pr-42/cache/tags/tags.json';
      store[tagsKey] = JSON.stringify({ posts: ['/en/blog', '/EN/Blog', 'a1b2c3'], nav: ['/en/blog'] });
      const objects = pagedObjects(routePrefix, 10);
      mockBucket.getFiles.mockImplementation(objects.getFiles);

      await new GcsCacheHandler({} as any).get('k');

      expect(JSON.parse(store[tagsKey])).toEqual({ posts: ['a1b2c3'] }); // fetch keys survive deploys
      expect(logged(warn)).toContain(
        '[GcsCacheHandler] Removed 2 route keys of the previous build from gs://test-bucket/' + tagsKey
      );
      expect(error).not.toHaveBeenCalled();
    });

    it('removes route keys from tags.json even when some objects could not be deleted, or with off', async () => {
      const tagsKey = 'environments/pr-42/cache/tags/tags.json';
      store[tagsKey] = JSON.stringify({ posts: ['/en/blog', 'a1b2c3'] });
      const objects = pagedObjects(routePrefix, 10, { deleteStatus: (i) => (i === 0 ? 403 : undefined) });
      mockBucket.getFiles.mockImplementation(objects.getFiles);

      await new GcsCacheHandler({} as any).get('k');

      expect(JSON.parse(store[tagsKey])).toEqual({ posts: ['a1b2c3'] });

      // Another deploy, with deletion off.
      store[tagsKey] = JSON.stringify({ posts: ['/en/blog', 'a1b2c3'] });
      mockGenerationId = 'build-C';
      process.env.CACHE_BUILD_INVALIDATION = 'off';
      resetBuildInvalidationCheck();
      await new GcsCacheHandler({} as any).get('k');

      expect(JSON.parse(store[tagsKey])).toEqual({ posts: ['a1b2c3'] });
    });

    it('logs what an unreadable tags.json leaves behind', async () => {
      const tagsKey = 'environments/pr-42/cache/tags/tags.json';
      store[tagsKey] = JSON.stringify({ posts: ['/en/blog'] });
      failingReads.add(tagsKey);

      await new GcsCacheHandler({} as any).get('k');

      expect(logged(error)).toEqual([
        `[GcsCacheHandler] Could not read gs://test-bucket/${tagsKey} to remove the previous build's route keys ` +
          '(503: Service unavailable). They stay in it until the next deploy; until then tag revalidations also ' +
          'purge the CDN for pages that no longer exist.',
      ]);
      expect(JSON.parse(store[metaKey]).buildId).toBe('build-B');
    });

    it('says what a failed CDN purge leaves behind', async () => {
      vi.mocked(fetch).mockResolvedValue({ ok: false, status: 502, statusText: 'Bad Gateway' } as Response);

      await new GcsCacheHandler({} as any).get('k');

      expect(logged(error)).toEqual([
        expect.stringMatching(
          /^\[GcsCacheHandler\] Edge cache purge on build invalidation failed: .+\. Pages from the previous build stay in the CDN until they expire or the site's edge cache is cleared\.$/
        ),
      ]);
    });

    it('clamps CACHE_INVALIDATION_DELETE_CONCURRENCY to 200', async () => {
      process.env.CACHE_INVALIDATION_DELETE_CONCURRENCY = '500';
      const objects = pagedObjects(routePrefix, 1000);
      mockBucket.getFiles.mockImplementation(objects.getFiles);

      await new GcsCacheHandler({} as any).get('k');

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

    // FileCacheHandler doesn't expose its init promise, so let it settle.
    new FileCacheHandler({} as any);
    await new Promise((r) => setTimeout(r, 100));

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

    new FileCacheHandler({} as any);
    await new Promise((r) => setTimeout(r, 100));

    expect(fs.existsSync(sentinel)).toBe(false);
    expect(JSON.parse(fs.readFileSync(metaFile, 'utf-8')).buildId).toBe('build-A');
  });

  it('does not treat unreadable build metadata as a first run', async () => {
    // A directory where the file should be: reading it fails with EISDIR, not ENOENT.
    const { sentinel } = setUp((f) => fs.mkdirSync(f));
    mockGenerationId = 'build-A';
    const writeBuildMeta = vi.spyOn(FileCacheHandler.prototype as any, 'writeBuildMeta');

    new FileCacheHandler({} as any);
    await new Promise((r) => setTimeout(r, 100));

    expect(writeBuildMeta).not.toHaveBeenCalled();
    expect(fs.existsSync(sentinel)).toBe(true);
  });
});
