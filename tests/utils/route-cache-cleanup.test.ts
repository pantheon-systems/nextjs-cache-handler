import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import type { Bucket, File } from '@google-cloud/storage';
import {
  LOCK_TTL_MS,
  MAX_PURGE_RUNS,
  RENEW_INTERVAL_MS,
  RouteCacheCleanup,
  createCleanupJob,
  type CleanupJob,
  type RouteCacheCleanupConfig,
} from '../../src/utils/route-cache-cleanup.js';
import { setRetryBaseDelayForTests } from '../../src/utils/gcs-delete-prefix.js';
import { FakeBucket } from '../helpers/fake-bucket.js';
import { pagedObjects } from '../helpers/paged-objects.js';

const PREFIX = 'route-cache/';
const JOB = 'route-cache-cleanup.json';
const OLD = 'build-A';
const NEW = 'build-B';

beforeAll(() => setRetryBaseDelayForTests(0));
afterAll(() => setRetryBaseDelayForTests(1000));

const silentLog = () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() });

/** `total` objects of the old build, then `current` of the new one (names after the old ones). */
function setup(opts: { total?: number; current?: number; pageSize?: number } = {}) {
  const total = opts.total ?? 2500;
  const current = opts.current ?? 0;
  const objects = pagedObjects(PREFIX, total + current, {
    customMetadata: (i) => ({ generation: i < total ? OLD : NEW }),
  });
  const jobBucket = new FakeBucket();
  let clock = 1_000_000;
  // The tags map holds one key per object, named after it.
  const tagKeys = new Set(objects.live);
  const removed = new Set<string>();
  const tagsMap = {
    routeKeysByObject: vi.fn(async () => new Map([...tagKeys].map((name): [string, string[]] => [name, [name]]))),
    remove: vi.fn(async (keys: string[]) => {
      for (const key of keys) removed.add(key);
    }),
    flush: vi.fn(async () => true),
    location: 'gs://test-bucket/tags.json',
  };
  const purge = vi.fn(async () => true);
  const bucket = { name: 'test-bucket', getFiles: objects.getFiles } as unknown as Bucket;

  const cleanup = (owner: string, overrides: Partial<RouteCacheCleanupConfig> = {}) =>
    new RouteCacheCleanup({
      bucket,
      jobBucket: jobBucket as unknown as Bucket,
      jobKey: JOB,
      prefix: PREFIX,
      generationOf: (file: File) => (file.metadata?.metadata as Record<string, unknown> | undefined)?.generation,
      concurrency: () => 50,
      purge,
      tagsMap,
      log: silentLog(),
      now: () => clock,
      owner,
      pageSize: opts.pageSize ?? 1000,
      ...overrides,
    });

  return {
    objects,
    jobBucket,
    cleanup,
    tagKeys,
    tagsMap,
    /** Tag keys left after pruning. */
    remainingTagKeys: () => new Set([...tagKeys].filter((key) => !removed.has(key))),
    purge,
    job: () => jobBucket.json(JOB) as CleanupJob | undefined,
    advance: (ms: number) => {
      clock += ms;
    },
    get clock() {
      return clock;
    },
    create: (extra: { deleteEntries?: boolean; purgePending?: boolean } = {}) =>
      createCleanupJob(jobBucket as unknown as Bucket, JOB, NEW, {
        deleteEntries: extra.deleteEntries ?? true,
        purgePending: extra.purgePending ?? false,
        now: clock,
      }),
  };
}

describe('createCleanupJob', () => {
  it('creates the job, and leaves one for the same build alone', async () => {
    const t = setup();
    expect(await t.create()).toBe('created');
    const generation = t.jobBucket.objects.get(JOB)!.generation;
    expect(await t.create()).toBe('exists');
    expect(t.jobBucket.objects.get(JOB)!.generation).toBe(generation);
    expect(t.job()).toMatchObject({ keep: NEW, deleteEntries: true, totals: { runs: 0 } });
  });

  it("notes another instance's failed purge on the existing job", async () => {
    const t = setup();
    await t.create();
    expect(await t.create({ purgePending: true })).toBe('exists');
    expect(t.job()).toMatchObject({ keep: NEW, purgePending: true });
  });

  it("replaces another build's job, dropping its progress", async () => {
    const t = setup();
    t.jobBucket.putJson(JOB, { keep: OLD, cursor: 'route-cache/x.json', totals: { runs: 3 } });
    expect(await t.create()).toBe('created');
    expect(t.job()).toMatchObject({ keep: NEW, totals: { runs: 0 } });
    expect(t.job()!.cursor).toBeUndefined();
  });

  it('two instances creating at once end with one job', async () => {
    const t = setup();
    const results = await Promise.all([t.create(), t.create()]);
    expect(results.sort()).toEqual(['created', 'exists']);
    expect(t.jobBucket.writes.get(JOB)).toBe(1);
  });
});

describe('RouteCacheCleanup', () => {
  it("deletes the earlier builds' objects, keeps the current build's, prunes, and removes the job", async () => {
    const t = setup({ total: 2500, current: 300 });
    await t.create();
    await t.cleanup('a').resume(NEW);

    expect(t.objects.live.size).toBe(300);
    expect([...t.objects.live].every((name) => name >= `${PREFIX}0002500.json`)).toBe(true);
    expect(t.remainingTagKeys()).toEqual(t.objects.live);
    expect(t.job()).toBeUndefined();
  });

  it('logs how many were deleted, kept and failed, and how long it took', async () => {
    const t = setup({ total: 100, current: 5 });
    await t.create();
    const log = silentLog();
    await t.cleanup('a', { log }).resume(NEW);

    const finished = log.warn.mock.calls.map(([message]) => message).find((m) => m.includes('finished'));
    expect(finished).toMatch(/deleted 100 objects of earlier builds \(105 listed, 5 of this build kept/);
    expect(finished).toMatch(/0 failed, in \d+ms over 1 run$/);
  });

  it('does nothing without a job, or with a job for another build', async () => {
    const t = setup({ total: 10 });
    await t.cleanup('a').resume(NEW);
    expect(t.objects.live.size).toBe(10);

    t.jobBucket.putJson(JOB, { keep: 'build-C', deleteEntries: true, createdAt: 0, totals: {} });
    await t.cleanup('b').resume(NEW);
    expect(t.objects.live.size).toBe(10);
    expect(t.tagsMap.routeKeysByObject).not.toHaveBeenCalled();
  });

  describe('lock', () => {
    it('only one of several instances deletes', async () => {
      const t = setup({ total: 3000 });
      await t.create();
      await Promise.all(['a', 'b', 'c'].map((owner) => t.cleanup(owner).resume(NEW)));

      expect(t.objects.live.size).toBe(0);
      // Each object was deleted by one instance, once.
      expect(Math.max(...t.objects.deleteAttempts.values())).toBe(1);
      expect(t.tagsMap.routeKeysByObject).toHaveBeenCalledTimes(1);
    });

    it('skips a job whose lock is held and not expired', async () => {
      const t = setup({ total: 10 });
      await t.create();
      const job = t.job()!;
      t.jobBucket.putJson(JOB, { ...job, owner: 'other', expiresAt: t.clock + LOCK_TTL_MS });

      await t.cleanup('a').resume(NEW);
      expect(t.objects.live.size).toBe(10);
      expect(t.job()!.owner).toBe('other');
    });

    it('renews the lock and records the cursor while it runs', async () => {
      const t = setup({ total: 5000 });
      await t.create();
      const seen: Array<{ job: CleanupJob; at: number }> = [];
      const getFiles = t.objects.getFiles.getMockImplementation()!;
      t.objects.getFiles.mockImplementation(async (query) => {
        t.advance(RENEW_INTERVAL_MS); // each page takes a renewal interval
        seen.push({ job: t.job()!, at: t.clock });
        return getFiles(query);
      });
      await t.cleanup('a').resume(NEW);

      const during = seen.slice(1, 5); // listings 2-5 happen after pages 1-4 were deleted
      expect(during.map(({ job }) => job.cursor)).toEqual([
        `${PREFIX}0000999.json`,
        `${PREFIX}0001999.json`,
        `${PREFIX}0002999.json`,
        `${PREFIX}0003999.json`,
      ]);
      // The lock never lapsed while the run was working.
      for (const { job, at } of during) {
        expect(job.owner).toBe('a');
        expect(job.expiresAt).toBeGreaterThan(at);
      }
    });

    it('a later instance takes over an expired lock and resumes from the cursor', async () => {
      const t = setup({ total: 3000 });
      await t.create();
      // Instance "dead" deleted the first 2,000 and stopped renewing.
      for (let i = 0; i < 2000; i++) t.objects.live.delete(`${PREFIX}${String(i).padStart(7, '0')}.json`);
      const job = t.job()!;
      t.jobBucket.putJson(JOB, {
        ...job,
        owner: 'dead',
        expiresAt: t.clock - 1,
        cursor: `${PREFIX}0001999.json`,
        totals: { ...job.totals, deleted: 2000, listed: 2000, runs: 1 },
      });
      const log = silentLog();
      await t.cleanup('b', { log }).resume(NEW);

      expect(t.objects.live.size).toBe(0);
      expect(t.objects.getFiles.mock.calls[0][0]).toMatchObject({ startOffset: `${PREFIX}0001999.json` });
      const finished = log.warn.mock.calls.map(([message]) => message).find((m) => m.includes('finished'));
      expect(finished).toMatch(/deleted 3000 objects/);
      expect(finished).toMatch(/over 2 runs$/);
      expect(t.job()).toBeUndefined();
    });

    it('a holder that stalled past expiry stops at its next page once another instance took over', async () => {
      const t = setup({ total: 5000 });
      await t.create();
      const getFiles = t.objects.getFiles.getMockImplementation()!;
      let listings = 0;
      t.objects.getFiles.mockImplementation(async (query) => {
        if (++listings === 2) {
          // While "a" was stalled, its lock expired and "b" took the job.
          t.jobBucket.putJson(JOB, { ...t.job()!, owner: 'b', expiresAt: t.clock + LOCK_TTL_MS });
        }
        return getFiles(query);
      });
      const log = silentLog();
      await t.cleanup('a', { log }).resume(NEW);

      expect(t.objects.live.size).toBe(3000); // pages 1 and 2 only
      expect(t.job()!.owner).toBe('b');
      expect(t.tagsMap.routeKeysByObject).not.toHaveBeenCalled();
      expect(log.warn.mock.calls.some(([m]) => /stopped: the clean-up job was taken over/.test(m))).toBe(true);
    });

    it('stops when a newer build replaces the job', async () => {
      const t = setup({ total: 5000 });
      await t.create();
      const getFiles = t.objects.getFiles.getMockImplementation()!;
      let listings = 0;
      t.objects.getFiles.mockImplementation(async (query) => {
        if (++listings === 2) {
          await createCleanupJob(t.jobBucket as unknown as Bucket, JOB, 'build-C', {
            deleteEntries: true,
            purgePending: false,
          });
        }
        return getFiles(query);
      });
      await t.cleanup('a').resume(NEW);

      expect(t.objects.live.size).toBe(3000);
      expect(t.job()).toMatchObject({ keep: 'build-C' });
    });
  });

  it('keeps an object rewritten for the new build after it was listed', async () => {
    const t = setup({ total: 100 });
    await t.create();
    const rewritten = `${PREFIX}0000042.json`;
    const getFiles = t.objects.getFiles.getMockImplementation()!;
    let listings = 0;
    t.objects.getFiles.mockImplementation(async (query) => {
      const response = await getFiles(query);
      if (++listings === 1) t.objects.rewrite(rewritten, { generation: NEW }); // listed as old, then rewritten
      return response;
    });
    await t.cleanup('a').resume(NEW);

    expect([...t.objects.live]).toEqual([rewritten]);
    expect(t.remainingTagKeys()).toEqual(new Set([rewritten]));
  });

  it('releases the lock with its progress when a listing keeps failing, and a later run resumes', async () => {
    const t = setup({ total: 3000 });
    await t.create();
    const getFiles = t.objects.getFiles.getMockImplementation()!;
    let listings = 0;
    t.objects.getFiles.mockImplementation(async (query) => {
      if (++listings >= 2 && listings <= 4) throw Object.assign(new Error('HTTP 503'), { code: 503 });
      return getFiles(query);
    });
    const a = t.cleanup('a');
    await a.resume(NEW);

    expect(t.objects.live.size).toBe(2000);
    expect(t.job()).toMatchObject({ cursor: `${PREFIX}0000999.json`, totals: { deleted: 1000, runs: 1 } });
    expect(t.job()!.owner).toBeUndefined();

    await t.cleanup('b').resume(NEW);
    expect(t.objects.live.size).toBe(0);
    expect(t.job()).toBeUndefined();
  });

  it('keeps the job when pruning the tags map fails, and a later run prunes without deleting again', async () => {
    const t = setup({ total: 100 });
    await t.create();
    t.tagsMap.flush.mockResolvedValueOnce(false);
    const log = silentLog();
    await t.cleanup('a', { log }).resume(NEW);

    expect(log.warn.mock.calls.map(([m]) => m)).toContain(
      `Route cache clean-up for build ${NEW} stopped (error: removing 100 route keys from ` +
        `gs://test-bucket/tags.json is not stored yet); a later instance prunes the tags map. Objects left ` +
        `behind are not served.`
    );
    expect(t.objects.live.size).toBe(0);
    expect(t.job()).toMatchObject({ deleted: true, totals: { deleted: 100 } });
    expect(t.job()!.owner).toBeUndefined();

    const calls = t.objects.getFiles.mock.calls.length;
    await t.cleanup('b').resume(NEW);
    expect(t.tagsMap.routeKeysByObject).toHaveBeenCalledTimes(2);
    expect(t.objects.getFiles.mock.calls.length).toBe(calls + 1); // the pruning listing only
    expect(t.job()).toBeUndefined();
  });

  it('under CACHE_BUILD_INVALIDATION=off deletes nothing but still prunes the tags map', async () => {
    const t = setup({ total: 100, current: 3 });
    await t.create({ deleteEntries: false });
    await t.cleanup('a').resume(NEW);

    expect(t.objects.live.size).toBe(103);
    expect(t.remainingTagKeys().size).toBe(3);
    expect(t.job()).toBeUndefined();
  });

  it('keeps the job while the CDN purge still fails, and a later run sends it without deleting or pruning again', async () => {
    const t = setup({ total: 10 });
    await t.create({ purgePending: true });
    t.purge.mockResolvedValueOnce(false);
    await t.cleanup('a').resume(NEW);
    expect(t.objects.live.size).toBe(0);
    expect(t.job()).toMatchObject({ purgePending: true, deleted: true, pruned: true, purgeRuns: 1 });
    expect(t.job()!.owner).toBeUndefined();

    const listings = t.objects.getFiles.mock.calls.length;
    const log = silentLog();
    await t.cleanup('b', { log }).resume(NEW);
    expect(t.purge).toHaveBeenCalledTimes(2);
    expect(t.objects.getFiles.mock.calls.length).toBe(listings);
    expect(t.tagsMap.routeKeysByObject).toHaveBeenCalledTimes(1);
    expect(t.job()).toBeUndefined();
    expect(log.warn.mock.calls.map(([m]) => m)).toContainEqual(expect.stringContaining('has now been sent'));
  });

  it(`gives up on a CDN purge that fails ${MAX_PURGE_RUNS} times, with an error`, async () => {
    const t = setup({ total: 10 });
    await t.create({ purgePending: true });
    t.purge.mockResolvedValue(false);
    const log = silentLog();
    for (let run = 1; run <= MAX_PURGE_RUNS; run++) {
      await t.cleanup(`run-${run}`, { log }).resume(NEW);
    }

    expect(t.purge).toHaveBeenCalledTimes(MAX_PURGE_RUNS);
    expect(t.job()).toBeUndefined();
    expect(log.error.mock.calls.map(([m]) => m)).toEqual([
      `CDN purge for build ${NEW} failed again (${MAX_PURGE_RUNS} background attempts); giving up. Pages from ` +
        `the previous build stay in the CDN until they expire or the site's edge cache is cleared.`,
    ]);
  });

  it('checks again only once the lock lifetime has passed, unless forced', async () => {
    const t = setup({ total: 10 });
    const a = t.cleanup('a');
    await a.resume(NEW); // no job yet
    await t.create();

    await a.resume(NEW);
    expect(t.objects.live.size).toBe(10);
    await a.resume(NEW, { force: true });
    expect(t.objects.live.size).toBe(0);

    await t.create();
    t.advance(LOCK_TTL_MS);
    await a.resume(NEW);
    expect(t.job()).toBeUndefined();
  });

  it('never rejects', async () => {
    const t = setup({ total: 10 });
    await t.create();
    const log = silentLog();
    t.tagsMap.routeKeysByObject.mockRejectedValueOnce(new Error('boom'));
    await expect(t.cleanup('a', { log }).resume(NEW)).resolves.toBeUndefined();
    expect(log.warn.mock.calls.some(([m]) => /stopped \(error: boom\)/.test(m))).toBe(true);
  });

  describe('totals', () => {
    it('records them at each renewal, so a run that is killed keeps its counts', async () => {
      const t = setup({ total: 5000 });
      await t.create();
      const getFiles = t.objects.getFiles.getMockImplementation()!;
      let listings = 0;
      t.objects.getFiles.mockImplementation(async (query) => {
        t.advance(RENEW_INTERVAL_MS);
        // The fourth listing never returns: the process is killed.
        return ++listings === 4 ? new Promise(() => {}) : getFiles(query);
      });
      void t.cleanup('dead').resume(NEW);
      await vi.waitFor(() => expect(t.job()!.totals.deleted).toBe(3000));

      t.objects.getFiles.mockImplementation(getFiles);
      t.advance(LOCK_TTL_MS);
      const log = silentLog();
      await t.cleanup('b', { log }).resume(NEW);
      const finished = log.warn.mock.calls.map(([m]) => m).find((m) => m.includes('finished'));
      expect(finished).toMatch(/deleted 5000 objects of earlier builds \(5000 listed/);
      expect(finished).toMatch(/over 2 runs$/);
    });

    it('keeps the counts of a run that stops on a failed renewal', async () => {
      const t = setup({ total: 3000 });
      await t.create();
      const getFiles = t.objects.getFiles.getMockImplementation()!;
      let listings = 0;
      t.objects.getFiles.mockImplementation(async (query) => {
        t.advance(RENEW_INTERVAL_MS);
        // The renewal during the second page fails once.
        if (++listings === 2) t.jobBucket.failWrites.set(JOB, { code: 503, times: 1 });
        return getFiles(query);
      });
      const log = silentLog();
      await t.cleanup('a', { log }).resume(NEW);

      expect(t.job()).toMatchObject({ cursor: `${PREFIX}0000999.json`, totals: { deleted: 1000, listed: 1000 } });
      expect(t.job()!.owner).toBeUndefined();
      expect(log.warn.mock.calls.map(([m]) => m)).toContainEqual(
        expect.stringContaining(`a later instance resumes it from ${PREFIX}0000999.json`)
      );
    });

    it('counts the time once', async () => {
      const t = setup({ total: 2500 });
      await t.create();
      const getFiles = t.objects.getFiles.getMockImplementation()!;
      t.objects.getFiles.mockImplementation(async (query) => {
        t.advance(1000);
        return getFiles(query);
      });
      const log = silentLog();
      await t.cleanup('a', { log }).resume(NEW);

      const listings = t.objects.getFiles.mock.calls.length; // 3 to delete, 1 to prune
      const finished = log.warn.mock.calls.map(([m]) => m).find((m) => m.includes('finished'));
      expect(finished).toContain(`in ${listings * 1000}ms over 1 run`);
    });
  });

  it('keeps the lock through a page that takes longer than the lock lasts', async () => {
    const t = setup({ total: 1000 });
    await t.create();
    const getFiles = t.objects.getFiles.getMockImplementation()!;
    const lapsed: number[] = [];
    t.objects.getFiles.mockImplementation(async (query) => {
      const [files, ...rest] = await getFiles(query);
      // Each delete takes a second (throttling), so the page takes 100 s at concurrency 10.
      const slow = files.map((file: any) => ({
        ...file,
        delete: async (options?: unknown) => {
          t.advance(1000);
          const job = t.job();
          if (job && job.expiresAt! <= t.clock) lapsed.push(t.clock);
          return file.delete(options);
        },
      }));
      return [slow, ...rest];
    });
    await t.cleanup('a', { concurrency: () => 10 }).resume(NEW);

    expect(t.objects.live.size).toBe(0);
    expect(lapsed).toEqual([]);
    expect(t.job()).toBeUndefined();
  });

  it('stops quietly when another instance finished the job and removed it', async () => {
    const t = setup({ total: 3000 });
    await t.create();
    const getFiles = t.objects.getFiles.getMockImplementation()!;
    let listings = 0;
    t.objects.getFiles.mockImplementation(async (query) => {
      if (++listings === 2) t.jobBucket.objects.delete(JOB);
      return getFiles(query);
    });
    const log = silentLog();
    await t.cleanup('a', { log }).resume(NEW);

    expect(t.job()).toBeUndefined();
    expect(log.warn.mock.calls.map(([m]) => m)).toContainEqual(
      expect.stringContaining('stopped: the clean-up job was taken over or replaced')
    );
  });

  it('removes a job object that is not valid JSON', async () => {
    const t = setup({ total: 10 });
    t.jobBucket.objects.set(JOB, { data: 'not json', generation: 99 });
    const log = silentLog();
    await t.cleanup('a', { log }).resume(NEW);

    expect(t.jobBucket.objects.has(JOB)).toBe(false);
    expect(t.objects.live.size).toBe(10);
    expect(log.warn.mock.calls.map(([m]) => m)).toContainEqual(expect.stringContaining('is not valid JSON'));
  });

  describe('tags map pruning', () => {
    it('removes keys page by page, as the listing covers their objects', async () => {
      const t = setup({ total: 0, current: 2500 });
      await t.create({ deleteEntries: false });
      // Keys for objects that are gone, between and after the listed ones.
      t.tagKeys.add(`${PREFIX}0000500x.json`);
      t.tagKeys.add(`${PREFIX}0002000x.json`);
      t.tagKeys.add(`${PREFIX}zzz.json`);
      await t.cleanup('a').resume(NEW);

      const calls = t.tagsMap.remove.mock.calls.map(([keys]) => keys);
      expect(calls).toEqual([[`${PREFIX}0000500x.json`], [], [`${PREFIX}0002000x.json`], [`${PREFIX}zzz.json`]]);
      expect(t.tagsMap.flush).toHaveBeenCalledTimes(1);
    });

    it('keeps a key whose object the new build writes before its page is listed', async () => {
      const t = setup({ total: 2500 });
      await t.create();
      const late = `${PREFIX}0002100.json`; // on the third page
      const getFiles = t.objects.getFiles.getMockImplementation()!;
      let listings = 0;
      t.objects.getFiles.mockImplementation(async (query) => {
        // The deletes take three listings; the pruning listing's first page is the fourth.
        if (++listings === 4) t.objects.rewrite(late, { generation: NEW });
        return getFiles(query);
      });
      await t.cleanup('a').resume(NEW);

      expect(t.remainingTagKeys()).toEqual(new Set([late]));
    });
  });
});
