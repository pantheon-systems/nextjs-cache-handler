import { randomUUID } from 'crypto';
import type { Bucket, DeleteFileOptions, File } from '@google-cloud/storage';
import {
  ListPrefixError,
  deletePrefix,
  describeFailures,
  errorLabel,
  errorMessage,
  listPrefixPages,
  type DeletePrefixResult,
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
  /** The CDN purge for the new build failed and is still owed. */
  purgePending?: boolean;
  /** Lock holder, and when the lock lapses without renewal. */
  owner?: string;
  expiresAt?: number;
  /** Last object name processed; the next run lists from it. */
  cursor?: string;
  /** All objects are deleted; only the tags map pruning is left. */
  deleted?: boolean;
  totals: CleanupTotals;
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
  /**
   * Remove the tags map's route keys whose entries are gone, given the names
   * of the objects under `prefix` that belong to the kept generation.
   * Resolves to whether the update was stored.
   */
  pruneTagsMap: (keptNames: Set<string>) => Promise<boolean>;
  /** What an operator can do about failed deletes, from their error labels. */
  failureHints?: (labels: string[]) => string[];
  log: Logger;
  /** @internal Test hooks. */
  now?: () => number;
  owner?: string;
  pageSize?: number;
}

/** The job object was replaced (another instance took over, or a newer build created its own job). */
class LostJobError extends Error {
  constructor() {
    super('the clean-up job was taken over or replaced');
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

function addFailures(into: Record<string, number>, from: Record<string, number>): void {
  for (const [label, count] of Object.entries(from)) {
    into[label] = (into[label] ?? 0) + count;
  }
}

/**
 * Record that `keep`'s clean-up is pending, replacing a job for another build
 * (which also deletes everything not of `keep`, so its progress does not
 * carry over). Leaves a job for `keep` as it is: another instance created it.
 * Throws when the job can't be read or written.
 */
export async function createCleanupJob(
  jobBucket: Bucket,
  jobKey: string,
  keep: string,
  opts: { deleteEntries: boolean; purgePending: boolean; now?: number }
): Promise<'created' | 'exists'> {
  for (let attempt = 1; ; attempt++) {
    const { value, generation } = await readJsonObject<CleanupJob>(jobBucket, jobKey);
    if (value?.keep === keep) {
      return 'exists';
    }
    const job: CleanupJob = {
      keep,
      createdAt: opts.now ?? Date.now(),
      deleteEntries: opts.deleteEntries,
      ...(opts.purgePending ? { purgePending: true } : {}),
      totals: emptyTotals(),
    };
    try {
      await writeJsonObject(jobBucket, jobKey, job, generation);
      return 'created';
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
      .catch((error) => this.config.log.error('Route cache clean-up failed; a later instance retries it:', error))
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
    log.warn(
      `Route cache clean-up for build ${keep} ${job.totals.runs === 1 ? 'started' : 'resumed'}` +
        (job.cursor ? ` after ${job.cursor}` : '') +
        ` (run ${job.totals.runs})`
    );

    // Write the job at the generation we hold, then learn the new one; a 412 means we lost it.
    const save = async (update: Partial<CleanupJob>) => {
      job = { ...job, ...update };
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
    const renew = (update: Partial<CleanupJob> = {}) => save({ ...update, expiresAt: this.now() + LOCK_TTL_MS });
    // Give up the lock, keeping the progress, so a later instance resumes without waiting for it to expire.
    const release = (update: Partial<CleanupJob>) =>
      writeJsonObject(jobBucket, jobKey, { ...job, ...update, owner: undefined, expiresAt: 0 }, generation);

    // Fails fast once someone else changed the job; renews when due.
    const check = async (update: Partial<CleanupJob> = {}) => {
      if (this.now() - lastRenew >= RENEW_INTERVAL_MS) {
        await renew(update);
        return;
      }
      const [metadata] = await jobBucket.file(jobKey).getMetadata();
      if (String(metadata.generation) !== String(generation)) {
        throw new LostJobError();
      }
    };

    // Run totals are added to job.totals once, when the run ends.
    let run: DeletePrefixResult | null = null;
    let deletedThisRun = 0;
    // Saved at each renewal, and when the lock is released.
    let cursor = job.cursor;
    const withRun = (): CleanupTotals => {
      const totals = { ...job.totals, failures: { ...job.totals.failures } };
      totals.durationMs += this.now() - started;
      if (run) {
        totals.listed += run.listed;
        totals.deleted += run.deleted;
        totals.kept += run.skipped;
        totals.changed += run.changed;
        totals.failed += run.failed;
        addFailures(totals.failures, run.failures);
      }
      return totals;
    };

    try {
      if (job.purgePending && this.config.purge) {
        if (await this.config.purge()) {
          log.warn(`CDN purge for build ${keep}, which failed when the build was recorded, has now been sent`);
          await renew({ purgePending: false });
        }
      }

      if (job.deleteEntries && !job.deleted) {
        try {
          run = await deletePrefix(this.config.bucket, this.config.prefix, {
            concurrency: this.config.concurrency(),
            pageSize: this.config.pageSize,
            startOffset: job.cursor,
            ifUnchanged: true,
            shouldDelete: (file) => this.config.generationOf(file) !== keep,
            onPage: async (p) => {
              deletedThisRun = p.deleted;
              cursor = p.lastName;
              await check({ cursor });
            },
          });
        } catch (error) {
          if (error instanceof ListPrefixError && error.progress) {
            run = { ...error.progress, skipped: 0, changed: 0, durationMs: 0 };
          }
          throw error;
        }
        const totals = withRun();
        run = null;
        await renew({ deleted: true, cursor: undefined, totals });
      }

      // After the delete, so what is left under the prefix is the kept build's.
      await check();
      const keptNames = new Set<string>();
      for await (const files of listPrefixPages(this.config.bucket, this.config.prefix, this.config.pageSize)) {
        for (const file of files) {
          if (this.config.generationOf(file) === keep) {
            keptNames.add(file.name);
          }
        }
        await check();
      }
      await renew();
      const pruned = await this.config.pruneTagsMap(keptNames);
      if (!pruned) {
        // A later run prunes again, without deleting again.
        await release({ totals: withRun() });
        log.warn(`Route cache clean-up for build ${keep}: pruning the tags map failed; a later instance retries it`);
        return;
      }

      const totals = withRun();
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
      this.report(keep, totals);
    } catch (error) {
      if (error instanceof LostJobError) {
        log.warn(
          `Route cache clean-up for build ${keep} stopped: ${error.message} (${location}); ` +
            `this run deleted ${run?.deleted ?? deletedThisRun} objects`
        );
        return;
      }
      const reason = error instanceof ListPrefixError ? error.message : `${errorLabel(error)}: ${errorMessage(error)}`;
      try {
        await release({ cursor, totals: withRun() });
      } catch {
        // The lock expires on its own.
      }
      const labels = [errorLabel(error instanceof ListPrefixError ? error.reason : error)];
      const text = [
        `Route cache clean-up for build ${keep} stopped (${reason}); a later instance resumes it from ` +
          `${cursor ?? 'the start'}. Objects left behind are not served.`,
        ...(this.config.failureHints?.(labels) ?? []),
      ].join(' ');
      // A permission problem stops every run the same way, so the bucket only grows until someone fixes it.
      if (isDenied(labels)) {
        log.error(text);
      } else {
        log.warn(text);
      }
    }
  }

  /** Take the lock on `keep`'s job, or null when there is none, it is another build's, or it is held. */
  private async acquire(keep: string): Promise<{ job: CleanupJob; generation: string | number } | null> {
    const { jobBucket, jobKey, log } = this.config;
    const { value, generation } = await readJsonObject<CleanupJob>(jobBucket, jobKey);
    if (!value) {
      return null;
    }
    if (value.keep !== keep) {
      log.debug(`Route cache clean-up job is for build ${value.keep}, not ${keep}; leaving it`);
      return null;
    }
    if (value.owner && value.owner !== this.owner && (value.expiresAt ?? 0) > this.now()) {
      log.debug(`Route cache clean-up for build ${keep} is running on ${value.owner}`);
      return null;
    }
    if (value.owner && value.owner !== this.owner) {
      log.warn(`Route cache clean-up lock held by ${value.owner} expired; taking over`);
    }
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
    return { job: reread.value, generation: reread.generation };
  }

  private report(keep: string, t: CleanupTotals): void {
    const summary =
      `Route cache clean-up for build ${keep} finished: deleted ${t.deleted} objects of earlier builds ` +
      `(${t.listed} listed, ${t.kept} of this build kept, ${t.changed} rewritten during the delete kept), ` +
      `${t.failed} failed, in ${t.durationMs}ms over ${t.runs} run${t.runs === 1 ? '' : 's'}`;
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
