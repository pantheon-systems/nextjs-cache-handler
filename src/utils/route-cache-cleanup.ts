import { randomUUID } from 'crypto';
import type { Bucket, DeleteFileOptions, File } from '@google-cloud/storage';
import {
  ListPrefixError,
  deletePrefix,
  describeFailures,
  errorLabel,
  errorMessage,
  listPrefixPages,
  type DeletePrefixProgress,
} from './gcs-delete-prefix.js';
import { isNotFound, isPreconditionFailure, readJsonObject, writeJsonObject } from './gcs-json-object.js';
import type { Logger } from './logger.js';

/**
 * Deleting the previous builds' route entries after a deploy, in the
 * background. Requests no longer wait for it: an entry from another build is a
 * cache miss (see GcsCacheHandler.readCacheEntry), so deleting it only frees
 * storage.
 *
 * The work is a job object next to build-meta.json. Its existence means the
 * clean-up is pending; it also holds the lock and the progress, so one
 * conditional write renews the lock and records how far the delete got. Only
 * the instance holding the lock deletes. If it dies, the lock expires and a
 * later instance resumes from the recorded object name. Every change to the
 * object bumps its GCS generation, so a holder that stalled past expiry finds
 * the generation changed at its next page and stops.
 */

/** How long a lock lasts without renewal. Long enough to ride out a throttled-CPU stall between requests. */
export const LOCK_TTL_MS = 60_000;
/** How often the holder renews the lock and records its progress; the job object takes about one write per second. */
export const RENEW_INTERVAL_MS = 15_000;
/** Runs that retry a failed CDN purge before the job gives up on it. */
export const MAX_PURGE_RUNS = 5;
/**
 * Wait after a failed background purge before the next, doubling each time.
 * Every instance checks about once a minute, so without it a fleet spends
 * every retry within seconds of each other.
 */
export const PURGE_RETRY_DELAY_MS = 60_000;

export interface CleanupTotals {
  listed: number;
  deleted: number;
  /** Kept because they belong to the build being kept. */
  kept: number;
  /** Kept because they were rewritten after they were listed. */
  changed: number;
  failed: number;
  failures: Record<string, number>;
  /** Runs that worked on the job, across instances. */
  runs: number;
  durationMs: number;
}

export interface CleanupJob {
  /** Generation whose route entries are kept; every other generation's are deleted. */
  keep: string;
  createdAt: number;
  /** False under CACHE_BUILD_INVALIDATION=off: nothing is deleted, only the tags map is pruned. */
  deleteEntries: boolean;
  /** The CDN purge for the new build failed and is still owed; `purgeRuns` counts the background retries. */
  purgePending?: boolean;
  purgeRuns?: number;
  /** No run retries the purge before this time. */
  purgeRetryAt?: number;
  /** Lock holder, and when the lock lapses without renewal. */
  owner?: string;
  expiresAt?: number;
  /** Last object name processed; the next run lists from it. */
  cursor?: string;
  /** All objects are deleted. */
  deleted?: boolean;
  /** The tags map is pruned. */
  pruned?: boolean;
  totals: CleanupTotals;
}

/** The tags map, as the clean-up prunes it. */
export interface CleanupTagsMap {
  /** The map's route keys by the name of the object each is stored under. */
  routeKeysByObject: () => Promise<Map<string, string[]>>;
  /** Queue keys for removal; may write when the map's flush interval has passed. */
  remove: (keys: string[]) => Promise<void>;
  /** Write what is queued; resolves to whether everything was stored. */
  flush: () => Promise<boolean>;
  /**
   * Queue the keys of these objects again, with the tags the objects hold now;
   * resolves to how many keys were queued.
   */
  restore: (keysByObject: Map<string, string[]>) => Promise<number>;
  /** e.g. `gs://bucket/cache/tags/tags.json`, for logs. */
  location: string;
}

export interface RouteCacheCleanupConfig {
  /** Lists and deletes route entries. */
  bucket: Bucket;
  /** Reads and writes the job object, with preconditions. */
  jobBucket: Bucket;
  jobKey: string;
  /** e.g. `route-cache/`, with the environment prefix. */
  prefix: string;
  /** Generation stamped on a listed object (its custom metadata), or undefined. */
  generationOf: (file: File) => unknown;
  concurrency: () => number;
  /** Purge the whole CDN; resolves to whether it worked. */
  purge?: () => Promise<boolean>;
  tagsMap: CleanupTagsMap;
  /** What an operator can do about failed deletes, from their error labels. */
  failureHints?: (labels: string[]) => string[];
  log: Logger;
  /** @internal Test hooks. */
  now?: () => number;
  owner?: string;
  pageSize?: number;
}

/** The job object was replaced (another instance took over, or a newer build created its own job) or removed. */
class LostJobError extends Error {
  constructor() {
    super('the clean-up job was taken over, replaced or removed');
    this.name = 'LostJobError';
  }
}

const isDenied = (labels: string[]) => labels.some((label) => label === '401' || label === '403');

const emptyTotals = (): CleanupTotals => ({
  listed: 0,
  deleted: 0,
  kept: 0,
  changed: 0,
  failed: 0,
  failures: {},
  runs: 0,
  durationMs: 0,
});

const emptyProgress = (): Omit<DeletePrefixProgress, 'lastName'> => ({
  listed: 0,
  deleted: 0,
  skipped: 0,
  changed: 0,
  failed: 0,
  failures: {},
});

/** `base` plus one run's progress and duration. */
function addRun(base: CleanupTotals, run: Omit<DeletePrefixProgress, 'lastName'>, durationMs: number): CleanupTotals {
  const failures = { ...base.failures };
  for (const [label, count] of Object.entries(run.failures)) {
    failures[label] = (failures[label] ?? 0) + count;
  }
  return {
    listed: base.listed + run.listed,
    deleted: base.deleted + run.deleted,
    kept: base.kept + run.skipped,
    changed: base.changed + run.changed,
    failed: base.failed + run.failed,
    failures,
    runs: base.runs,
    durationMs: base.durationMs + durationMs,
  };
}

/**
 * Record that `keep`'s clean-up is pending, replacing a job for another build
 * (which also deletes everything not of `keep`, so its progress does not
 * carry over). A job for `keep` already exists when another instance created
 * it; it is left as it is, except that a failed purge is noted on it. Throws
 * when the job can't be read or written.
 */
export async function createCleanupJob(
  jobBucket: Bucket,
  jobKey: string,
  keep: string,
  opts: { deleteEntries: boolean; purgePending: boolean; now?: number }
): Promise<'created' | 'exists'> {
  for (let attempt = 1; ; attempt++) {
    const { value, generation } = await readJsonObject<CleanupJob>(jobBucket, jobKey);
    const exists = value?.keep === keep;
    if (exists && (!opts.purgePending || value.purgePending)) {
      return 'exists';
    }
    const job: CleanupJob = exists
      ? { ...value, purgePending: true }
      : {
          keep,
          createdAt: opts.now ?? Date.now(),
          deleteEntries: opts.deleteEntries,
          ...(opts.purgePending ? { purgePending: true } : {}),
          totals: emptyTotals(),
        };
    try {
      await writeJsonObject(jobBucket, jobKey, job, generation);
      return exists ? 'exists' : 'created';
    } catch (error) {
      // Another instance wrote it first: read it again.
      if (!isPreconditionFailure(error) || attempt >= 3) {
        throw error;
      }
    }
  }
}

export class RouteCacheCleanup {
  private readonly owner: string;
  private readonly now: () => number;
  private running: Promise<void> | null = null;
  private lastCheck = -Infinity;

  constructor(private readonly config: RouteCacheCleanupConfig) {
    this.owner = config.owner ?? `${process.env.K_REVISION ?? 'local'}/${randomUUID()}`;
    this.now = config.now ?? Date.now;
  }

  /**
   * Run the pending clean-up for `keep` in the background, unless this process
   * is already running it or checked within the lock's lifetime (`force`
   * skips that wait). Never rejects; the returned promise is for tests.
   */
  resume(keep: string, opts: { force?: boolean } = {}): Promise<void> {
    if (this.running) {
      return this.running;
    }
    if (!opts.force && this.now() - this.lastCheck < LOCK_TTL_MS) {
      return Promise.resolve();
    }
    this.lastCheck = this.now();
    this.running = this.run(keep)
      .catch((error) =>
        this.config.log.error('Could not take the route cache clean-up job; the next check retries it:', error)
      )
      .finally(() => {
        this.running = null;
      });
    return this.running;
  }

  /** The run in progress in this process, if any. @internal */
  get current(): Promise<void> | null {
    return this.running;
  }

  private async run(keep: string): Promise<void> {
    const { jobBucket, jobKey, log } = this.config;
    const location = `gs://${jobBucket.name}/${jobKey}`;

    const acquired = await this.acquire(keep);
    if (!acquired) {
      return;
    }
    let { job, generation } = acquired;
    const started = this.now();
    let lastRenew = started;
    const purgeAttempt = `attempt ${(job.purgeRuns ?? 0) + 1} of ${MAX_PURGE_RUNS}`;
    if (job.pruned && job.purgePending) {
      log.warn(`Route cache clean-up for build ${keep}: retrying the CDN purge (${purgeAttempt})`);
    } else if (job.totals.runs === 1) {
      log.warn(`Route cache clean-up for build ${keep} started`);
    } else {
      const from = job.deleted || !job.deleteEntries ? 'pruning the tags map' : `after ${job.cursor ?? 'the start'}`;
      log.warn(`Route cache clean-up for build ${keep} resumed, ${from} (run ${job.totals.runs})`);
    }

    // Totals from earlier runs, fixed for this run; every write records them plus this run's progress.
    const base = job.totals;
    let progress = emptyProgress();
    let cursor = job.cursor;
    const totals = () => addRun(base, progress, this.now() - started);

    // Write the job at the generation we hold, then learn the new one; a 412 means we lost it.
    const renew = async (update: Partial<CleanupJob> = {}) => {
      job = { ...job, ...update, cursor, totals: totals(), expiresAt: this.now() + LOCK_TTL_MS };
      try {
        await writeJsonObject(jobBucket, jobKey, job, generation);
      } catch (error) {
        if (isPreconditionFailure(error)) {
          throw new LostJobError();
        }
        throw error;
      }
      const reread = await readJsonObject<CleanupJob>(jobBucket, jobKey);
      if (reread.value?.owner !== this.owner || reread.value.keep !== keep) {
        throw new LostJobError();
      }
      generation = reread.generation;
      lastRenew = this.now();
    };
    // Mid-page renewals record the previous page's cursor, so the page's end records its own.
    let renewedInPage = false;
    const renewIfDue = async () => {
      if (this.now() - lastRenew >= RENEW_INTERVAL_MS) {
        await renew();
        renewedInPage = true;
      }
    };
    // Give up the lock, keeping the progress, so a later instance resumes without waiting for it to expire.
    const release = (update: Partial<CleanupJob> = {}) =>
      writeJsonObject(
        jobBucket,
        jobKey,
        { ...job, ...update, cursor, totals: totals(), owner: undefined, expiresAt: 0 },
        generation
      );

    // Fails fast once someone else changed or removed the job; renews when due.
    const check = async () => {
      if (this.now() - lastRenew >= RENEW_INTERVAL_MS) {
        await renew();
        return;
      }
      let metadata;
      try {
        [metadata] = await jobBucket.file(jobKey).getMetadata();
      } catch (error) {
        if (isNotFound(error)) {
          throw new LostJobError();
        }
        throw error;
      }
      if (String(metadata.generation) !== String(generation)) {
        throw new LostJobError();
      }
    };

    try {
      if (job.purgePending && this.config.purge && (job.purgeRetryAt ?? 0) > this.now()) {
        // Not due yet: the run still deletes and prunes, and a later one retries it.
      } else if (job.purgePending && this.config.purge) {
        const purgeRuns = (job.purgeRuns ?? 0) + 1;
        if (await this.config.purge()) {
          log.warn(`CDN purge for build ${keep}, which failed when the build was recorded, has now been sent`);
          await renew({ purgePending: false, purgeRuns });
        } else if (purgeRuns >= MAX_PURGE_RUNS) {
          log.error(
            `CDN purge for build ${keep} failed again (${purgeRuns} background attempts); giving up. Pages from ` +
              `the previous build stay in the CDN until they expire or the site's edge cache is cleared.`
          );
          await renew({ purgePending: false, purgeRuns });
        } else {
          await renew({ purgeRuns, purgeRetryAt: this.now() + PURGE_RETRY_DELAY_MS * 2 ** (purgeRuns - 1) });
        }
      } else if (job.purgePending) {
        // Nothing to send it with here; keeping it owed would hold the job open on every run.
        log.warn(
          `CDN purge for build ${keep}, which failed when the build was recorded, is dropped: this instance has ` +
            `no edge cache clearer (OUTBOUND_PROXY_ENDPOINT is not set)`
        );
        await renew({ purgePending: false });
      }

      if (job.deleteEntries && !job.deleted) {
        try {
          const result = await deletePrefix(this.config.bucket, this.config.prefix, {
            concurrency: this.config.concurrency(),
            pageSize: this.config.pageSize,
            startAfter: cursor,
            ifUnchanged: true,
            shouldDelete: (file) => this.config.generationOf(file) !== keep,
            // A page can take longer than the lock lasts (throttling, low concurrency).
            onBatch: renewIfDue,
            onPage: async ({ lastName, ...counts }) => {
              progress = counts;
              cursor = lastName;
              if (renewedInPage) {
                renewedInPage = false;
                await renew();
              } else {
                await check();
              }
            },
          });
          progress = result;
        } catch (error) {
          if (error instanceof ListPrefixError && error.progress) {
            progress = error.progress;
          }
          throw error;
        }
        cursor = undefined;
        await renew({ deleted: true });
      }

      if (!job.pruned) {
        await this.pruneTagsMap(keep, check);
        await renew({ pruned: true });
      }

      if (job.purgePending) {
        // Everything else is done; a later run retries the purge.
        await release();
        const done = job.deleteEntries ? 'entries deleted' : 'nothing deleted (CACHE_BUILD_INVALIDATION=off)';
        const retryAt = new Date(job.purgeRetryAt ?? this.now()).toISOString();
        log.warn(
          `Route cache clean-up for build ${keep}: ${done} and tags map pruned; the CDN purge is still owed ` +
            `(${job.purgeRuns ?? 0} of ${MAX_PURGE_RUNS} background attempts made) and a run from ${retryAt} ` +
            `retries it`
        );
        return;
      }

      const final = totals();
      await jobBucket
        .file(jobKey)
        .delete({ ifGenerationMatch: generation } as DeleteFileOptions)
        .catch((error: unknown) => {
          if (isPreconditionFailure(error)) {
            throw new LostJobError();
          }
          if (!isNotFound(error)) {
            throw error;
          }
        });
      this.report(keep, job.deleteEntries, final);
    } catch (error) {
      if (error instanceof LostJobError) {
        // Deletes of a page interrupted mid-way are not in `progress` yet.
        log.warn(
          `Route cache clean-up for build ${keep} stopped: ${error.message} (${location}); ` +
            `this run deleted at least ${progress.deleted} objects`
        );
        return;
      }
      const reason = error instanceof ListPrefixError ? error.message : `${errorLabel(error)}: ${errorMessage(error)}`;
      let released = true;
      try {
        await release();
      } catch {
        released = false; // the lock expires on its own, and the job keeps its last renewal's cursor
      }
      const labels = [errorLabel(error instanceof ListPrefixError ? error.reason : error)];
      const when = released ? 'the next run' : 'the next run, once the lock expires,';
      const next = job.pruned
        ? `${when} finishes it`
        : job.deleted || !job.deleteEntries
          ? `${when} prunes the tags map`
          : released
            ? `${when} resumes it after ${cursor ?? 'the start'}`
            : `${when} resumes it from the last recorded object`;
      // Failed deletes are counted, not thrown, so a stop is never one; only a denied listing has a hint.
      const hints =
        error instanceof ListPrefixError && isDenied(labels) ? (this.config.failureHints?.(labels) ?? []) : [];
      const text = [
        `Route cache clean-up for build ${keep} stopped (${reason}); ${next}. Objects left behind are not served.`,
        ...hints,
      ].join(' ');
      // A permission problem stops every run the same way, so the bucket only grows until someone fixes it.
      if (isDenied(labels)) {
        log.error(text);
      } else {
        log.warn(text);
      }
    }
  }

  /**
   * Remove the tags map's route keys whose entries are not `keep`'s. Each key
   * is decided when the listing page covering its object's name arrives, and
   * removals are written as the map's flush interval allows. Keys added to the
   * map after it was read here are never removed.
   *
   * The new build is serving meanwhile. When it caches a page after that
   * page's key was decided, its own add finds the key still in the map (from
   * the earlier build) and writes nothing, and the removal then drops it. So
   * once the removals are stored, a second listing finds those pages and adds
   * their keys back; a page cached after that adds its key itself.
   */
  private async pruneTagsMap(keep: string, check: () => Promise<void>): Promise<void> {
    const { tagsMap } = this.config;
    const keysByObject = await tagsMap.routeKeysByObject();
    // Listings return names in this order (they are ASCII).
    const names = [...keysByObject.keys()].sort();
    const removedByObject = new Map<string, string[]>();
    let next = 0;
    let removed = 0;
    const removeUpTo = async (lastListed: string | undefined, kept: Set<string>) => {
      const stale: string[] = [];
      while (next < names.length && (lastListed === undefined || names[next] <= lastListed)) {
        if (!kept.has(names[next])) {
          const keys = keysByObject.get(names[next])!;
          stale.push(...keys);
          removedByObject.set(names[next], keys);
        }
        next++;
      }
      removed += stale.length;
      await tagsMap.remove(stale);
    };

    for await (const files of listPrefixPages(this.config.bucket, this.config.prefix, this.config.pageSize)) {
      const kept = new Set(files.filter((file) => this.config.generationOf(file) === keep).map((file) => file.name));
      if (files.length > 0) {
        await removeUpTo(files.at(-1)!.name, kept);
      }
      await check();
    }
    // Names after the last listed one have no object at all.
    await removeUpTo(undefined, new Set());
    if (!(await tagsMap.flush())) {
      throw new Error(`removing ${removed} route keys from ${tagsMap.location} is not stored yet`);
    }
    if (removed === 0) {
      return;
    }

    const cached = new Map<string, string[]>();
    for await (const files of listPrefixPages(this.config.bucket, this.config.prefix, this.config.pageSize)) {
      for (const file of files) {
        const keys = removedByObject.get(file.name);
        if (keys && this.config.generationOf(file) === keep) {
          cached.set(file.name, keys);
        }
      }
      await check();
    }
    // Not retried by a later run: its read of the map no longer has these keys.
    let restored = 0;
    if (cached.size > 0) {
      restored = await tagsMap.restore(cached);
      if (!(await tagsMap.flush())) {
        this.config.log.warn(
          `Adding back ${restored} route keys this build cached during the prune to ${tagsMap.location} is not ` +
            `stored yet; until it is, tag revalidations do not purge the CDN for those pages`
        );
      }
    }
    this.config.log.warn(
      `Removed ${removed - restored} route keys of earlier builds from ${tagsMap.location}` +
        (restored > 0 ? ` (and added back ${restored} whose pages this build cached during the prune)` : '')
    );
  }

  /** Take the lock on `keep`'s job, or null when there is none, it is another build's, or it is held. */
  private async acquire(keep: string): Promise<{ job: CleanupJob; generation: string | number } | null> {
    const { jobBucket, jobKey, log } = this.config;
    const { value, generation } = await readJsonObject<CleanupJob>(jobBucket, jobKey);
    if (!value) {
      if (String(generation) !== '0') {
        // Not valid JSON: nothing can resume it, so remove it; the next deploy deletes what it left.
        log.warn(`Route cache clean-up job ${jobKey} is not valid JSON; removing it`);
        await jobBucket
          .file(jobKey)
          .delete({ ifGenerationMatch: generation } as DeleteFileOptions)
          .catch(() => {});
      }
      return null;
    }
    if (value.keep !== keep) {
      log.debug(`Route cache clean-up job is for build ${value.keep}, not ${keep}; leaving it`);
      return null;
    }
    if (value.pruned && value.purgePending && (value.purgeRetryAt ?? 0) > this.now()) {
      // Only the purge is left, and it is not due: taking the lock would only write the job.
      log.debug(`Route cache clean-up for build ${keep}: the CDN purge retry is not due yet`);
      return null;
    }
    if (value.owner && value.owner !== this.owner && (value.expiresAt ?? 0) > this.now()) {
      log.debug(`Route cache clean-up for build ${keep} is running on ${value.owner}`);
      return null;
    }
    const expiredOwner = value.owner && value.owner !== this.owner ? value.owner : undefined;
    const totals = { ...emptyTotals(), ...value.totals };
    totals.runs++;
    const job: CleanupJob = {
      ...value,
      totals,
      owner: this.owner,
      expiresAt: this.now() + LOCK_TTL_MS,
    };
    try {
      await writeJsonObject(jobBucket, jobKey, job, generation);
    } catch (error) {
      if (isPreconditionFailure(error)) {
        return null; // another instance took it first
      }
      throw error;
    }
    const reread = await readJsonObject<CleanupJob>(jobBucket, jobKey);
    if (reread.value?.owner !== this.owner) {
      return null;
    }
    if (expiredOwner) {
      log.warn(`Route cache clean-up lock held by ${expiredOwner} expired; took it over`);
    }
    return { job: reread.value, generation: reread.generation };
  }

  private report(keep: string, deleteEntries: boolean, t: CleanupTotals): void {
    const runs = `in ${t.durationMs}ms over ${t.runs} run${t.runs === 1 ? '' : 's'}`;
    if (!deleteEntries) {
      this.config.log.warn(
        `Route cache clean-up for build ${keep} finished: nothing deleted (CACHE_BUILD_INVALIDATION=off), ` +
          `tags map pruned, ${runs}`
      );
      return;
    }
    // `deleted` includes objects already gone (404).
    const summary =
      `Route cache clean-up for build ${keep} finished: deleted ${t.deleted} objects of earlier builds ` +
      `(${t.listed} listed, ${t.kept} of this build kept, ${t.changed} rewritten during the delete kept), ` +
      `${t.failed} failed, ${runs}`;
    if (t.failed === 0) {
      this.config.log.warn(summary);
      return;
    }
    const text = [
      `${summary} (${describeFailures(t.failures)}). The objects left behind are not served; the next ` +
        `deploy deletes them.`,
      ...(this.config.failureHints?.(Object.keys(t.failures)) ?? []),
    ].join(' ');
    if (isDenied(Object.keys(t.failures))) {
      this.config.log.error(text);
    } else {
      this.config.log.warn(text);
    }
  }
}
