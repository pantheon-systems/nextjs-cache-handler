import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import type { Bucket, File } from '@google-cloud/storage';
import {
  LOCK_TTL_MS,
  MAX_PURGE_RUNS,
  PURGE_RETRY_DELAY_MS,
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
const REMOVALS = 'route-cache-cleanup-removals.json';
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
    restore: vi.fn(async (byObject: Map<string, string[]>) => byObject.size),
    location: 'gs://test-bucket/tags.json',
  };
  const purge = vi.fn(async () => true);
  const bucket = { name: 'test-bucket', getFiles: objects.getFiles } as unknown as Bucket;

  const cleanup = (owner: string, overrides: Partial<RouteCacheCleanupConfig> = {}) =>
    new RouteCacheCleanup({
      bucket,
      jobBucket: jobBucket as unknown as Bucket,
      jobKey: JOB,
      removalsKey: REMOVALS,
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
    restoredKeys: new Set<string>(),
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
      expect(log.warn.mock.calls.map(([m]) => m)).toContain(
        'Route cache clean-up lock held by dead expired; took it over'
      );
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

      expect(t.objects.live.size).toBe(4000); // page 1 only
      expect(t.job()!.owner).toBe('b');
      expect(t.tagsMap.routeKeysByObject).not.toHaveBeenCalled();
      expect(log.warn.mock.calls.some(([m]) => /stopped: the clean-up job was taken over/.test(m))).toBe(true);
    });

    it("stops when a newer build replaces the job, before deleting the newer build's objects", async () => {
      const t = setup({ total: 5000 });
      await t.create();
      const getFiles = t.objects.getFiles.getMockImplementation()!;
      // The newer build replaces the job, then caches pages, all on the next page, before it is listed.
      const newer = Array.from({ length: 1000 }, (_, i) => `${PREFIX}${String(1000 + i).padStart(7, '0')}.json`);
      let listings = 0;
      t.objects.getFiles.mockImplementation(async (query) => {
        if (++listings === 2) {
          await createCleanupJob(t.jobBucket as unknown as Bucket, JOB, 'build-C', {
            deleteEntries: true,
            purgePending: false,
          });
          for (const name of newer) t.objects.rewrite(name, { generation: 'build-C' });
        }
        return getFiles(query);
      });
      await t.cleanup('a').resume(NEW);

      expect(t.objects.live.size).toBe(4000); // page 1 only
      expect(newer.every((name) => t.objects.live.has(name))).toBe(true);
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
        `gs://test-bucket/tags.json is not stored yet); the next run prunes the tags map. Objects left ` +
        `behind are not served.`
    );
    expect(t.objects.live.size).toBe(0);
    expect(t.job()).toMatchObject({ deleted: true, totals: { deleted: 100 } });
    expect(t.job()!.owner).toBeUndefined();

    // The removals run "a" decided are saved for the next run.
    expect(Object.keys((t.jobBucket.json(REMOVALS) as { byObject: object }).byObject)).toHaveLength(100);

    const calls = t.objects.getFiles.mock.calls.length;
    await t.cleanup('b').resume(NEW);
    // Stores the saved removals instead of reading the map again; lists only for pages cached meanwhile.
    expect(t.tagsMap.routeKeysByObject).toHaveBeenCalledTimes(1);
    expect(t.tagsMap.remove).toHaveBeenCalledTimes(2);
    expect(t.objects.getFiles.mock.calls.length).toBe(calls + 1);
    expect(t.job()).toBeUndefined();
    expect(t.jobBucket.objects.has(REMOVALS)).toBe(false);
  });

  it('under CACHE_BUILD_INVALIDATION=off deletes nothing but still prunes the tags map', async () => {
    const t = setup({ total: 100, current: 3 });
    await t.create({ deleteEntries: false });
    const log = silentLog();
    await t.cleanup('a', { log }).resume(NEW);

    expect(t.objects.live.size).toBe(103);
    expect(t.remainingTagKeys().size).toBe(3);
    expect(t.job()).toBeUndefined();
    expect(log.warn.mock.calls.map(([m]) => m)).toContainEqual(
      expect.stringMatching(
        new RegExp(
          `^Route cache clean-up for build ${NEW} finished: nothing deleted \\(CACHE_BUILD_INVALIDATION=off\\), tags map pruned, in \\d+ms over 1 run$`
        )
      )
    );
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
    t.advance(PURGE_RETRY_DELAY_MS);
    await t.cleanup('b', { log }).resume(NEW);
    expect(t.purge).toHaveBeenCalledTimes(2);
    expect(t.objects.getFiles.mock.calls.length).toBe(listings);
    expect(t.tagsMap.routeKeysByObject).toHaveBeenCalledTimes(1);
    expect(t.job()).toBeUndefined();
    const warned = log.warn.mock.calls.map(([m]) => m);
    expect(warned).toContainEqual(expect.stringContaining('has now been sent'));
    expect(warned).toContain(`Route cache clean-up for build ${NEW}: retrying the CDN purge (attempt 2 of 5)`);
    expect(warned.some((m) => m.includes('resumed'))).toBe(false);
  });

  it(`gives up on a CDN purge that fails ${MAX_PURGE_RUNS} times, with an error`, async () => {
    const t = setup({ total: 10 });
    await t.create({ purgePending: true });
    t.purge.mockResolvedValue(false);
    const log = silentLog();
    for (let run = 1; run <= MAX_PURGE_RUNS; run++) {
      await t.cleanup(`run-${run}`, { log }).resume(NEW);
      t.advance(PURGE_RETRY_DELAY_MS * 2 ** (run - 1));
    }

    expect(t.purge).toHaveBeenCalledTimes(MAX_PURGE_RUNS);
    expect(t.job()).toBeUndefined();
    expect(log.error.mock.calls.map(([m]) => m)).toEqual([
      `CDN purge for build ${NEW} failed again (${MAX_PURGE_RUNS} background attempts); giving up. Pages from ` +
        `the previous build stay in the CDN until they expire or the site's edge cache is cleared.`,
    ]);
  });

  it('does not spend the CDN purge retries on instances that check within moments of each other', async () => {
    // 20 instances, each checking once a minute, all pick up the released job within seconds.
    const t = setup({ total: 10 });
    await t.create({ purgePending: true });
    t.purge.mockResolvedValue(false);
    for (let instance = 1; instance <= MAX_PURGE_RUNS; instance++) {
      await t.cleanup(`instance-${instance}`).resume(NEW);
      t.advance(1_000);
    }

    expect(t.purge).toHaveBeenCalledTimes(1);
    expect(t.job()).toMatchObject({ purgePending: true, purgeRuns: 1 });
    // The checks that came too early did not write the job.
    expect(t.job()!.owner).toBeUndefined();
  });

  it('waits twice as long after each failed CDN purge', async () => {
    const t = setup({ total: 10 });
    await t.create({ purgePending: true });
    t.purge.mockResolvedValue(false);
    await t.cleanup('a').resume(NEW);
    expect(t.job()!.purgeRetryAt).toBe(t.clock + PURGE_RETRY_DELAY_MS);

    t.advance(PURGE_RETRY_DELAY_MS - 1);
    await t.cleanup('b').resume(NEW);
    expect(t.purge).toHaveBeenCalledTimes(1);

    t.advance(1);
    await t.cleanup('c').resume(NEW);
    expect(t.purge).toHaveBeenCalledTimes(2);
    expect(t.job()!.purgeRetryAt).toBe(t.clock + 2 * PURGE_RETRY_DELAY_MS);
  });

  it('deletes and prunes even while the CDN purge retry is not due', async () => {
    const t = setup({ total: 10 });
    await t.create({ purgePending: true });
    t.jobBucket.putJson(JOB, { ...t.job()!, purgeRuns: 1, purgeRetryAt: t.clock + PURGE_RETRY_DELAY_MS });

    await t.cleanup('a').resume(NEW);

    expect(t.purge).not.toHaveBeenCalled();
    expect(t.objects.live.size).toBe(0);
    expect(t.job()).toMatchObject({ purgePending: true, purgeRuns: 1, deleted: true, pruned: true });
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
        expect.stringContaining(`the next run resumes it after ${PREFIX}0000999.json`)
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
      expect.stringContaining('stopped: the clean-up job was taken over, replaced or removed')
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
    it('decides keys page by page, as the listing covers their objects, and removes them together', async () => {
      const t = setup({ total: 0, current: 2500 });
      await t.create({ deleteEntries: false });
      // Keys for objects that are gone, between and after the listed ones.
      t.tagKeys.add(`${PREFIX}0000500x.json`);
      t.tagKeys.add(`${PREFIX}0002000x.json`);
      t.tagKeys.add(`${PREFIX}zzz.json`);
      await t.cleanup('a').resume(NEW);

      const calls = t.tagsMap.remove.mock.calls.map(([keys]) => keys);
      expect(calls).toEqual([[`${PREFIX}0000500x.json`, `${PREFIX}0002000x.json`, `${PREFIX}zzz.json`]]);
      expect(t.tagsMap.flush).toHaveBeenCalledTimes(1);
      expect(t.jobBucket.objects.has(REMOVALS)).toBe(false);
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
    it('adds back the key of a page the new build caches after its removal was decided', async () => {
      const t = setup({ total: 2500 });
      await t.create();
      t.tagsMap.restore.mockImplementation(async (byObject: Map<string, string[]>) => {
        for (const keys of byObject.values()) for (const key of keys) t.restoredKeys.add(key);
        return byObject.size;
      });
      const late = `${PREFIX}0000100.json`; // on the first page
      const getFiles = t.objects.getFiles.getMockImplementation()!;
      let listings = 0;
      t.objects.getFiles.mockImplementation(async (query) => {
        const result = await getFiles(query);
        // Right after the pruning listing's first page: the deletes took three listings.
        if (++listings === 4) t.objects.rewrite(late, { generation: NEW });
        return result;
      });
      const log = silentLog();
      await t.cleanup('a', { log }).resume(NEW);

      expect(t.tagsMap.restore).toHaveBeenCalledTimes(1);
      expect([...t.tagsMap.restore.mock.calls[0][0].keys()]).toEqual([late]);
      expect(t.tagsMap.flush).toHaveBeenCalledTimes(2);
      expect(log.warn.mock.calls.map(([m]) => m)).toContain(
        `Removed 2499 route keys of earlier builds from gs://test-bucket/tags.json (and added back 1 whose ` +
          `pages were cached during the prune)`
      );
    });

    it('lists only once, and adds nothing back, when it removes nothing', async () => {
      const t = setup({ total: 0, current: 10 });
      await t.create({ deleteEntries: false });
      await t.cleanup('a').resume(NEW);

      expect(t.objects.getFiles).toHaveBeenCalledTimes(1);
      expect(t.tagsMap.restore).not.toHaveBeenCalled();
    });
  });

  it('logs no takeover when another instance takes the expired lock first', async () => {
    const t = setup({ total: 10 });
    await t.create();
    t.jobBucket.putJson(JOB, { ...t.job()!, owner: 'dead', expiresAt: t.clock - 1 });
    t.jobBucket.failWrites.set(JOB, { code: 412, times: 1 });
    const log = silentLog();
    await t.cleanup('a', { log }).resume(NEW);

    expect(t.objects.live.size).toBe(10);
    expect(log.warn.mock.calls.some(([m]) => m.includes('took it over'))).toBe(false);
  });

  it('does not count the object at the cursor again when it resumes', async () => {
    const t = setup({ total: 0, current: 2000 });
    await t.create();
    t.jobBucket.putJson(JOB, {
      ...t.job()!,
      cursor: `${PREFIX}0000999.json`,
      totals: { ...t.job()!.totals, listed: 1000, kept: 1000, runs: 1 },
    });
    const log = silentLog();
    await t.cleanup('b', { log }).resume(NEW);

    const finished = log.warn.mock.calls.map(([m]) => m).find((m) => m.includes('finished'));
    expect(finished).toContain('deleted 0 objects of earlier builds (2000 listed, 2000 of this build kept');
  });

  it('drops an owed CDN purge on an instance with no edge cache clearer, and finishes', async () => {
    const t = setup({ total: 10 });
    await t.create({ purgePending: true });
    const log = silentLog();
    await t.cleanup('a', { log, purge: undefined }).resume(NEW);

    expect(t.job()).toBeUndefined();
    expect(log.warn.mock.calls.map(([m]) => m)).toContainEqual(
      expect.stringContaining('is dropped: this instance has no edge cache clearer')
    );
  });

  it('adds the operator hint only to a denied listing', async () => {
    const listingFails = (code: number) => {
      const t = setup({ total: 10 });
      t.objects.getFiles.mockRejectedValue(Object.assign(new Error(`HTTP ${code}`), { code }));
      return t;
    };
    const hint = () => ['HINT'];

    const throttled = listingFails(503);
    await throttled.create();
    const log503 = silentLog();
    await throttled.cleanup('a', { log: log503, failureHints: hint }).resume(NEW);
    expect(log503.warn.mock.calls.some(([m]) => m.includes('stopped') && m.includes('HINT'))).toBe(false);

    const denied = listingFails(403);
    await denied.create();
    const log403 = silentLog();
    await denied.cleanup('a', { log: log403, failureHints: hint }).resume(NEW);
    expect(log403.error.mock.calls.some(([m]) => m.includes('stopped') && m.endsWith('HINT'))).toBe(true);
  });

  it('says only the finishing step is left when removing the finished job fails', async () => {
    const t = setup({ total: 10 });
    await t.create();
    const real = t.jobBucket.file.bind(t.jobBucket);
    vi.spyOn(t.jobBucket, 'file').mockImplementation((name, options) => ({
      ...real(name, options),
      delete: async () => Promise.reject(Object.assign(new Error('HTTP 503'), { code: 503 })),
    }));
    const log = silentLog();
    await t.cleanup('a', { log }).resume(NEW);

    expect(t.job()).toMatchObject({ deleted: true, pruned: true });
    expect(log.warn.mock.calls.map(([m]) => m)).toContainEqual(expect.stringContaining('; the next run finishes it.'));
  });
});

/**
 * A tags map that behaves like the stored one: removals are stored as soon as
 * they are queued, reads see what is stored, and a page the new build caches
 * adds its key only if it is missing (as applyBatch does).
 */
function storedTagsMap(names: Iterable<string>) {
  const stored = new Set(names);
  return {
    stored,
    /** The new build caches a page: its add writes nothing when the key is already there. */
    cache: (key: string) => stored.add(key),
    tagsMap: {
      routeKeysByObject: vi.fn(async () => new Map([...stored].map((name): [string, string[]] => [name, [name]]))),
      remove: async (keys: string[]) => {
        for (const key of keys) stored.delete(key);
      },
      flush: vi.fn(async () => true),
      restore: async (byObject: Map<string, string[]>) => {
        for (const keys of byObject.values()) for (const key of keys) stored.add(key);
        return byObject.size;
      },
      location: 'gs://test-bucket/tags.json',
    },
  };
}

describe('a prune that stops part-way', () => {
  const denied = () => Object.assign(new Error('HTTP 403'), { code: 403 });

  /** 2,500 objects of the old build, kept in place (CACHE_BUILD_INVALIDATION=off) so every listing is the prune's. */
  function setupStored() {
    const t = setup({ total: 2500 });
    const map = storedTagsMap(t.objects.live);
    const late = `${PREFIX}0000100.json`; // on the first page
    /** The new build caches `late`: the object is rewritten, and its add finds the key in the map. */
    const cacheLate = () => {
      t.objects.rewrite(late, { generation: NEW });
      map.cache(late);
    };
    const getFiles = t.objects.getFiles.getMockImplementation()!;
    /** `hook` runs on each listing, by number, after the page is fetched; it may throw to fail the listing. */
    const onListing = (hook: (n: number) => void) => {
      let listings = 0;
      t.objects.getFiles.mockImplementation(async (query) => {
        const response = await getFiles(query);
        hook(++listings);
        return response;
      });
    };
    return { t, map, late, cacheLate, onListing, run: (owner: string) => t.cleanup(owner, { tagsMap: map.tagsMap }) };
  }

  it('keeps the key of a page the new build cached after its removal was decided, when the deciding listing fails', async () => {
    const s = setupStored();
    await s.t.create({ deleteEntries: false });
    s.onListing((n) => {
      if (n === 1) s.cacheLate(); // page 1 listed `late` as the old build's
      if (n === 2) throw denied(); // run 1 stops on page 2
    });
    await s.run('a').resume(NEW);
    expect(s.t.job()!.pruned).toBeFalsy();

    // Run 1 removed nothing, so run 2 decides afresh and sees `late` as the new build's.
    await s.run('b').resume(NEW);
    expect(s.t.job()).toBeUndefined();
    expect(s.map.stored.has(s.late)).toBe(true);
  });

  it('keeps that key when the run stops after the removals are stored, before adding back', async () => {
    const s = setupStored();
    await s.t.create({ deleteEntries: false });
    s.onListing((n) => {
      if (n === 1) s.cacheLate();
      if (n === 4) throw denied(); // the add-back listing (after three deciding pages)
    });
    await s.run('a').resume(NEW);
    expect(s.map.stored.has(s.late)).toBe(false); // removed, not yet added back
    expect(s.t.jobBucket.objects.has(REMOVALS)).toBe(true);

    await s.run('b').resume(NEW);
    expect(s.t.job()).toBeUndefined();
    expect(s.map.stored.has(s.late)).toBe(true);
    // Run "b" used the saved removals; the map no longer had the key to decide on.
    expect(s.map.tagsMap.routeKeysByObject).toHaveBeenCalledTimes(1);
  });

  it('keeps the job when adding back is not stored, and a later run adds the key back', async () => {
    const s = setupStored();
    await s.t.create({ deleteEntries: false });
    s.onListing((n) => {
      if (n === 1) s.cacheLate();
    });
    // The removals are stored; the add-back is not, and the instance stops with it queued.
    s.map.tagsMap.flush.mockResolvedValueOnce(true).mockImplementationOnce(async () => {
      s.map.stored.delete(s.late);
      return false;
    });
    const log = silentLog();
    await s.t.cleanup('a', { tagsMap: s.map.tagsMap, log }).resume(NEW);
    expect(s.t.job()!.pruned).toBeFalsy();
    expect(log.warn.mock.calls.map(([m]) => m)).toContainEqual(
      expect.stringContaining('adding back 1 route keys of pages cached during the prune')
    );

    await s.run('b').resume(NEW);
    expect(s.t.job()).toBeUndefined();
    expect(s.map.stored.has(s.late)).toBe(true);
  });

  it('adds back after losing the job, when its removals land after the instance that took over added keys back', async () => {
    const s = setupStored();
    await s.t.create({ deleteEntries: false });
    s.onListing((n) => {
      if (n === 1) s.cacheLate();
    });
    // "a"'s write of its removals stalls past the lock's lifetime; "b" takes over and finishes the
    // prune, adding `late` back, then a's write lands.
    let queued: string[] = [];
    const tagsMap = {
      ...s.map.tagsMap,
      remove: async (keys: string[]) => {
        queued = keys;
      },
      flush: vi.fn(async () => {
        if (queued.length > 0) {
          s.t.advance(LOCK_TTL_MS + 1);
          await s.run('b').resume(NEW, { force: true });
          expect(s.map.stored.has(s.late)).toBe(true);
          for (const key of queued) s.map.stored.delete(key);
          queued = [];
        }
        return true;
      }),
    };
    const log = silentLog();
    await s.t.cleanup('a', { tagsMap, log }).resume(NEW);

    expect(s.t.job()).toBeUndefined();
    expect(s.map.stored.has(s.late)).toBe(true);
    expect(log.warn.mock.calls.some(([m]) => /stopped: the clean-up job was taken over/.test(m))).toBe(true);
  });

  it('adds back the key of a page a newer build cached after the removal was decided', async () => {
    const s = setupStored();
    await s.t.create({ deleteEntries: false });
    // After "a" decided to remove `late` (the old build's), a newer build replaces the job and caches
    // `late`; its add writes nothing, as the key is still there. Then a's removal lands.
    const tagsMap = {
      ...s.map.tagsMap,
      remove: async (keys: string[]) => {
        await createCleanupJob(s.t.jobBucket as unknown as Bucket, JOB, 'build-C', {
          deleteEntries: false,
          purgePending: false,
        });
        s.t.objects.rewrite(s.late, { generation: 'build-C' });
        s.map.cache(s.late);
        await s.map.tagsMap.remove(keys);
      },
    };
    const log = silentLog();
    await s.t.cleanup('a', { tagsMap, log }).resume(NEW);

    expect(s.map.stored.has(s.late)).toBe(true);
    expect(s.t.job()).toMatchObject({ keep: 'build-C' });
    expect(log.warn.mock.calls.some(([m]) => /stopped: the clean-up job was taken over/.test(m))).toBe(true);
  });

  it('uses the removals another run of the job saved while it was deciding, instead of overwriting them', async () => {
    const s = setupStored();
    await s.t.create({ deleteEntries: false });
    const first = `${PREFIX}0000001.json`;
    // While "a" decides, another run of the job (which may already have stored its removals) saves
    // a decision of one key.
    const tagsMap = {
      ...s.map.tagsMap,
      routeKeysByObject: async () => {
        const byObject = await s.map.tagsMap.routeKeysByObject();
        s.t.jobBucket.putJson(REMOVALS, {
          keep: NEW,
          createdAt: s.t.job()!.createdAt,
          byObject: { [first]: [first] },
          generations: { [first]: '2' },
        });
        return byObject;
      },
    };
    await s.t.cleanup('a', { tagsMap }).resume(NEW);

    expect(s.t.job()).toBeUndefined();
    expect(s.map.stored.has(first)).toBe(false);
    expect(s.map.stored.size).toBe(2499); // only the saved decision's key was removed
    expect(s.t.jobBucket.objects.has(REMOVALS)).toBe(false);
  });

  it('ignores removals saved by an earlier job for the same build', async () => {
    const s = setupStored();
    await s.t.create({ deleteEntries: false });
    s.t.jobBucket.putJson(REMOVALS, { keep: NEW, createdAt: 1, byObject: { [`${PREFIX}zzz.json`]: ['/stale'] } });
    s.map.stored.add('/stale');
    await s.run('a').resume(NEW);

    expect(s.map.tagsMap.routeKeysByObject).toHaveBeenCalledTimes(1);
    expect(s.map.stored.has('/stale')).toBe(false); // decided afresh: no object of that name
    expect(s.map.stored.size).toBe(0);
  });

  it("leaves removals another job saved after this run's prune", async () => {
    const s = setupStored();
    await s.t.create({ deleteEntries: false });
    const newer = { keep: 'build-C', createdAt: s.t.clock + 1, byObject: {}, generations: {} };
    // The newer build's job saves its decision between a's last renewal and a's removal of the file.
    const flush = s.map.tagsMap.flush;
    const tagsMap = {
      ...s.map.tagsMap,
      flush: vi.fn(async () => {
        const stored = await flush();
        s.t.jobBucket.putJson(REMOVALS, newer);
        return stored;
      }),
    };
    await s.t.cleanup('a', { tagsMap }).resume(NEW);

    expect(s.t.job()).toBeUndefined();
    expect(s.t.jobBucket.json(REMOVALS)).toEqual(newer);
  });

  it("ignores removals saved by an earlier build's prune", async () => {
    const s = setupStored();
    await s.t.create({ deleteEntries: false });
    s.t.jobBucket.putJson(REMOVALS, { keep: OLD, byObject: { [`${PREFIX}0000001.json`]: ['/kept'] } });
    s.map.stored.add('/kept');
    await s.run('a').resume(NEW);

    expect(s.map.tagsMap.routeKeysByObject).toHaveBeenCalledTimes(1);
    expect(s.map.stored.has('/kept')).toBe(false); // no object of that name: removed by the fresh decision
    expect(s.t.jobBucket.objects.has(REMOVALS)).toBe(false);
  });
});

describe('purge notes, resumed cursors and purge retries', () => {
  it('a failed purge noted on a running job does not stop the instance that holds the lock', async () => {
    const t = setup({ total: 5000 });
    await t.create();
    const getFiles = t.objects.getFiles.getMockImplementation()!;
    let listings = 0;
    t.objects.getFiles.mockImplementation(async (query) => {
      if (++listings === 2) {
        // Another instance of the same build, whose startup purge failed, notes it on the job.
        await t.create({ purgePending: true });
      }
      return getFiles(query);
    });
    const log = silentLog();
    await t.cleanup('a', { log }).resume(NEW);

    expect(log.warn.mock.calls.some(([m]) => /stopped/.test(m))).toBe(false);
    expect(t.objects.live.size).toBe(0);
    // The note is kept: the job stays, released, for a run to send the purge.
    expect(t.job()).toMatchObject({ pruned: true, purgePending: true, purgeRuns: 0 });
    expect(t.job()!.owner).toBeUndefined();
  });

  it('keeps the lock, and the note, when a failed purge is noted just before a renewal', async () => {
    const t = setup({ total: 5000 });
    await t.create();
    const getFiles = t.objects.getFiles.getMockImplementation()!;
    let listings = 0;
    t.objects.getFiles.mockImplementation(async (query) => {
      t.advance(RENEW_INTERVAL_MS); // the page's end renews, so its write meets the note's generation
      if (++listings === 2) await t.create({ purgePending: true });
      return getFiles(query);
    });
    const log = silentLog();
    await t.cleanup('a', { log }).resume(NEW);

    expect(log.warn.mock.calls.some(([m]) => /stopped/.test(m))).toBe(false);
    expect(t.objects.live.size).toBe(0);
    expect(t.job()).toMatchObject({ purgePending: true });
  });

  it('leaves the purge owed when it is noted just before the finished job is removed', async () => {
    const t = setup({ total: 10 });
    await t.create();
    const real = t.jobBucket.file.bind(t.jobBucket);
    vi.spyOn(t.jobBucket, 'file').mockImplementation((name, options) => {
      const file = real(name, options);
      if (name !== REMOVALS) return file;
      // Removing the saved removals is the last step before the job itself.
      return {
        ...file,
        delete: async () => {
          await t.create({ purgePending: true });
          return file.delete();
        },
      };
    });
    const log = silentLog();
    await t.cleanup('a', { log }).resume(NEW);

    expect(log.warn.mock.calls.some(([m]) => /stopped/.test(m))).toBe(false);
    expect(t.job()).toMatchObject({ pruned: true, purgePending: true });
    expect(t.job()!.owner).toBeUndefined();
    expect(log.warn.mock.calls.map(([m]) => m)).toContainEqual(expect.stringContaining('the CDN purge is still owed'));
  });

  it('keeps the cursor when the first page of a resumed run holds only the cursor object', async () => {
    // The cursor object is the new build's, so it is kept, and pages hold one object.
    const t = setup({ total: 0, current: 3, pageSize: 1 });
    await t.create();
    const cursor = `${PREFIX}0000000.json`;
    t.jobBucket.putJson(JOB, { ...t.job()!, cursor });
    const getFiles = t.objects.getFiles.getMockImplementation()!;
    let listings = 0;
    t.objects.getFiles.mockImplementation(async (query) => {
      if (++listings === 2) throw Object.assign(new Error('HTTP 403'), { code: 403 });
      return getFiles(query);
    });
    await t.cleanup('a').resume(NEW);

    expect(t.job()!.cursor).toBe(cursor);
  });

  it('gives a purge that fails again at startup a full set of retries after an earlier one gave up', async () => {
    const t = setup({ total: 0 });
    await t.create();
    // An earlier purge used up its retries.
    t.jobBucket.putJson(JOB, { ...t.job()!, purgePending: false, purgeRuns: MAX_PURGE_RUNS, pruned: true });
    await t.create({ purgePending: true });
    t.purge.mockResolvedValue(false);
    await t.cleanup('a').resume(NEW);

    expect(t.job()).toMatchObject({ purgePending: true, purgeRuns: 1 });
  });
});
