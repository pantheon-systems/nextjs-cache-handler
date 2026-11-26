import { createLogger } from '../utils/logger.js';

const log = createLogger('EdgeCacheClear');

export const DEFAULT_PURGE_CONCURRENCY = 10;
export const MAX_PURGE_CONCURRENCY = 200;
export const DEFAULT_PURGE_MAX_PATHS = 200;

/** The first pause after a refusal, and the shortest. It doubles for each refusal that follows. Tests set it to 0. */
let backoffBaseMs = 1000;

/** @internal Test hook. */
export function setPurgeBackoffBaseForTests(ms: number): void {
  backoffBaseMs = ms;
}

/** Longest pause after a refusal (429 or 5xx), whether it named a Retry-After or not. */
export const MAX_BACKOFF_MS = 30_000;
/**
 * The purges still waiting are given up on once the pauses of refusals in a row
 * add up to this. With the default doubling that is the eighth refusal. It is a
 * sum of the pauses asked for, not time that has passed, so a timer that fires
 * late on a throttled instance cannot trigger it.
 */
export const GIVE_UP_AFTER_PAUSED_MS = 120_000;
/** Times a full purge is sent before a refusal fails it. It can stand for hundreds of paths. */
export const FULL_PURGE_ATTEMPTS = 3;

function parseCount(raw: string | undefined): number {
  return raw === undefined || raw.trim() === '' ? NaN : Number(raw);
}

/** Purge requests in flight at once per purge target, from CACHE_PURGE_CONCURRENCY, clamped to 1..200. */
export function resolvePurgeConcurrency(raw: string | undefined = process.env.CACHE_PURGE_CONCURRENCY): number {
  const parsed = parseCount(raw);
  if (!Number.isFinite(parsed)) {
    return DEFAULT_PURGE_CONCURRENCY;
  }
  return Math.min(MAX_PURGE_CONCURRENCY, Math.max(1, Math.floor(parsed)));
}

/** Most path purges outstanding before a full purge replaces them, from CACHE_PURGE_MAX_PATHS (at least 1). */
export function resolvePurgeMaxPaths(raw: string | undefined = process.env.CACHE_PURGE_MAX_PATHS): number {
  const parsed = parseCount(raw);
  if (!Number.isFinite(parsed)) {
    return DEFAULT_PURGE_MAX_PATHS;
  }
  return Math.max(1, Math.floor(parsed));
}

/** A Retry-After header as milliseconds: delta-seconds or an HTTP date. */
export function parseRetryAfter(value: string | null | undefined, now: number = Date.now()): number | undefined {
  if (!value) {
    return undefined;
  }
  const seconds = Number(value);
  if (Number.isFinite(seconds)) {
    return Math.max(0, seconds * 1000);
  }
  const at = Date.parse(value);
  return Number.isNaN(at) ? undefined : Math.max(0, at - now);
}

export interface PurgeOutcome {
  ok: boolean;
  status?: number;
  retryAfterMs?: number;
  error?: string;
  /** What `fetch` threw, for the log line. */
  cause?: unknown;
}

export type PurgeKind = 'path' | 'key' | 'full';

type Send = () => Promise<PurgeOutcome>;

interface Job {
  id: string;
  kind: PurgeKind;
  send: Send;
  running: boolean;
  attempts: number;
  settled: Promise<PurgeOutcome>;
  /** Settles `settled`, and `nextAnswer` if it is still open. */
  resolve: (outcome: PurgeOutcome) => void;
  /**
   * The answer to the next request sent for this purge. The same as `settled`
   * except for a full purge that is refused and sent again: then this settles
   * with the refusal, and is replaced for the next attempt.
   */
  nextAnswer: Deferred;
  /** Requested again while this one was in flight: sent once, after it. */
  followUp?: Job;
}

interface Deferred {
  promise: Promise<PurgeOutcome>;
  resolve: (outcome: PurgeOutcome) => void;
}

function deferred(): Deferred {
  let resolve!: (outcome: PurgeOutcome) => void;
  const promise = new Promise<PurgeOutcome>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const jobId = (kind: PurgeKind, value: string): string => `${kind}:${value}`;
const FULL_PURGE_ID = jobId('full', '');

function isRefusal(outcome: PurgeOutcome): boolean {
  return outcome.status === 429 || (outcome.status !== undefined && outcome.status >= 500);
}

/**
 * Every purge request one process sends to one purge target goes through here.
 *
 * Sending them unbounded took sites down: a tag on most of a site's pages meant
 * tens of thousands of requests started together, and the process could not
 * open a socket for anything else until they finished.
 *
 * A purge waits for a free slot, or for a pause to end, for as long as that
 * takes, so callers that must not wait that long put their own limit on the
 * wait (settledWithin in edge-cache-clear.ts). What keeps the queue short is the
 * caller's cap on waiting paths: see `waitingPathCount`. Purges are given up on only
 * when the purge service has kept refusing through GIVE_UP_AFTER_PAUSED_MS of pauses.
 *
 * A repeat of a purge that has not started yet shares that request. A repeat
 * of one already in flight is sent once more after it, never joined: the
 * request in flight may have reached the CDN before the change it is repeated for.
 */
export class PurgeQueue {
  /** Waiting or in flight, by id. */
  private readonly jobs = new Map<string, Job>();
  private waiting: Job[] = [];
  private pathJobsWaiting = 0;
  private inFlight = 0;
  private pausedUntil = 0;
  /** Refusals in a row; above 0 the queue is recovering and sends one request at a time. */
  private backoffLevel = 0;
  /**
   * The pauses those refusals started, added up. A pause lengthened by a response
   * from the same burst, or forced before a full purge is sent again, adds nothing:
   * both are bounded, by the burst and by FULL_PURGE_ATTEMPTS.
   */
  private refusedPauseMs = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly concurrency: number = resolvePurgeConcurrency()) {}

  /** Resolves with the outcome of the request that covered this purge. Never rejects. */
  enqueue(kind: PurgeKind, value: string, send: Send): Promise<PurgeOutcome> {
    return this.jobFor(kind, value, send).settled;
  }

  /**
   * A full purge, for a caller that must not wait through its retries.
   * `firstAnswer` is the answer to the first request sent for it after this
   * call; `settled` is what enqueue() returns. They differ only when that
   * request is refused and the full purge is sent again.
   */
  enqueueFullPurge(send: Send): { firstAnswer: Promise<PurgeOutcome>; settled: Promise<PurgeOutcome> } {
    const job = this.jobFor('full', '', send);
    return { firstAnswer: job.nextAnswer.promise, settled: job.settled };
  }

  /** The purge that covers this request: one already queued, or a new one. */
  private jobFor(kind: PurgeKind, value: string, send: Send): Job {
    this.forgetOldRefusal();
    const fullPurge = this.nextFullPurge();
    if (kind === 'path' && fullPurge) {
      return fullPurge;
    }

    const id = jobId(kind, value);
    const existing = this.jobs.get(id);
    if (!existing) {
      const job = this.createJob(id, kind, send);
      this.addToWaiting(job);
      this.startWaiting();
      return job;
    }
    if (!existing.running) {
      return existing;
    }
    // Not shared: the request in flight may have reached the CDN before the change this one is for.
    if (!existing.followUp) {
      existing.followUp = this.createJob(id, kind, send);
      if (kind === 'full') {
        this.absorbWaitingPaths(existing.followUp);
      }
    }
    return existing.followUp;
  }

  /**
   * How many path purges have not started yet. Callers count these against CACHE_PURGE_MAX_PATHS
   * and send a full purge instead of adding to them, which empties the list.
   */
  get waitingPathCount(): number {
    return this.pathJobsWaiting;
  }

  /** How long until anything is sent: a purge requested now waits at least this long. 0 when not paused. */
  get pauseLeftMs(): number {
    return Math.max(0, this.pausedUntil - Date.now());
  }

  /** How many of these path purges would add to `waitingPathCount`: the rest join a purge already queued. */
  countNewPaths(values: string[]): number {
    if (this.nextFullPurge()) {
      return 0;
    }
    // New when sending it means one more request: nothing is queued for it, or one is in
    // flight with no follow-up booked yet.
    return [...new Set(values)].filter((value) => {
      const existing = this.jobs.get(jobId('path', value));
      return !existing || (existing.running && !existing.followUp);
    }).length;
  }

  /** @internal Test hook. Fails what has not started; requests in flight finish but start nothing more. */
  stop(): void {
    if (this.timer) {
      clearTimeout(this.timer);
    }
    this.timer = null;
    const stopped: PurgeOutcome = { ok: false, error: 'purge queue stopped' };
    for (const job of this.jobs.values()) {
      (job.running ? job.followUp : job)?.resolve(stopped);
    }
    this.jobs.clear();
    this.waiting = [];
    this.pathJobsWaiting = 0;
  }

  private createJob(id: string, kind: PurgeKind, send: Send): Job {
    const settled = deferred();
    const job: Job = {
      id,
      kind,
      send,
      running: false,
      attempts: 0,
      settled: settled.promise,
      resolve: (outcome) => {
        job.nextAnswer.resolve(outcome);
        settled.resolve(outcome);
      },
      nextAnswer: deferred(),
    };
    return job;
  }

  /** The full purge that has not started yet, if there is one: it covers any path purge requested before it starts. */
  private nextFullPurge(): Job | undefined {
    const fullPurge = this.jobs.get(FULL_PURGE_ID);
    return fullPurge?.running ? fullPurge.followUp : fullPurge;
  }

  private addToWaiting(job: Job): void {
    // Reached only by the follow-up of a path that was in flight: jobFor() joins new paths itself.
    const fullPurge = this.nextFullPurge();
    if (job.kind === 'path' && fullPurge) {
      void fullPurge.settled.then(job.resolve);
      return;
    }

    this.jobs.set(job.id, job);
    if (job.kind === 'full') {
      this.absorbWaitingPaths(job);
      // Ahead of the keys still waiting: a new build's purge must not wait behind them.
      this.waiting.unshift(job);
      return;
    }
    if (job.kind === 'path') {
      this.pathJobsWaiting++;
    }
    this.waiting.push(job);
  }

  private absorbWaitingPaths(fullPurge: Job): void {
    if (this.pathJobsWaiting === 0) {
      return;
    }
    const absorbed = this.waiting.filter((job) => job.kind === 'path');
    this.waiting = this.waiting.filter((job) => job.kind !== 'path');
    this.pathJobsWaiting = 0;
    for (const job of absorbed) {
      this.jobs.delete(job.id);
      void fullPurge.settled.then(job.resolve);
    }
    log.debug(`A full purge covers ${absorbed.length} path purges that were waiting`);
  }

  /**
   * A refusal long ago says nothing about the service now. Without this a queue
   * left empty after one would stay in recovery, and a refusal a day later would
   * count as the next in a row.
   *
   * Only when nothing is waiting or in flight: a pause timer that fired late, or
   * requests that timed out, leave purges behind that belong to the same
   * recovery, and those still go one at a time.
   */
  private forgetOldRefusal(): void {
    const idle = this.jobs.size === 0;
    if (idle && this.backoffLevel > 0 && Date.now() - this.pausedUntil > MAX_BACKOFF_MS) {
      this.endRecovery();
    }
  }

  /** Starts the purges that are waiting, up to the limit. During a pause it starts none and sets the timer that ends it. */
  private startWaiting(): void {
    const now = Date.now();
    const pauseLeft = this.pausedUntil - now;
    if (pauseLeft > 0) {
      this.resumeIn(pauseLeft);
      return;
    }
    const limit = this.backoffLevel > 0 ? 1 : this.concurrency;
    while (this.inFlight < limit && this.waiting.length > 0) {
      const job = this.waiting.shift()!;
      if (job.kind === 'path') {
        this.pathJobsWaiting--;
      }
      void this.run(job);
    }
  }

  /** A timer that fires early, because the pause grew after it was set, sets itself again through startWaiting(). */
  private resumeIn(wait: number): void {
    if (this.timer || this.waiting.length === 0) {
      return;
    }
    // Not unref'd: it keeps the process alive for purges that are waiting, which
    // a script awaiting them needs. Set only while purges wait, so the process stays
    // up until they are sent or, after GIVE_UP_AFTER_PAUSED_MS of pauses, given up on.
    this.timer = setTimeout(() => {
      this.timer = null;
      this.startWaiting();
    }, wait);
  }

  private async run(job: Job): Promise<void> {
    job.running = true;
    this.inFlight++;
    const startedAt = Date.now();
    let outcome: PurgeOutcome;
    try {
      outcome = await job.send();
    } catch (error) {
      outcome = { ok: false, error: error instanceof Error ? error.message : 'Unknown error', cause: error };
    }
    this.inFlight--;
    job.attempts++;
    const gaveUp = this.applyBackoff(outcome, startedAt);

    // Not this job's entry any more if stop() emptied the queue while it was in flight.
    const stillQueued = this.jobs.get(job.id) === job;
    const sendAgain =
      stillQueued &&
      job.kind === 'full' &&
      isRefusal(outcome) &&
      job.attempts < FULL_PURGE_ATTEMPTS &&
      // Giving up on what is waiting and keeping this one going would contradict each other.
      !gaveUp;
    if (sendAgain) {
      job.nextAnswer.resolve(outcome);
      job.nextAnswer = deferred();
      this.sendFullPurgeAgain(job);
    } else {
      job.resolve(outcome);
      if (stillQueued) {
        this.jobs.delete(job.id);
        if (job.followUp) {
          this.addToWaiting(job.followUp);
        }
      }
    }
    this.startWaiting();
  }

  /** Back to the front of the queue, to be sent after a pause. Path and key purges are not sent again. */
  private sendFullPurgeAgain(job: Job): void {
    job.running = false;
    // Its refusal may have arrived after the pause it belongs to had ended, and so started none.
    this.pausedUntil = Math.max(this.pausedUntil, Date.now() + backoffBaseMs);
    // The next attempt starts after any full purge requested meanwhile, so it serves as that one too.
    if (job.followUp) {
      void job.nextAnswer.promise.then(job.followUp.nextAnswer.resolve);
      void job.settled.then(job.followUp.resolve);
      job.followUp = undefined;
    }
    this.absorbWaitingPaths(job);
    this.waiting.unshift(job);
  }

  /**
   * Pause after 429 or 5xx, for Retry-After if the response names one, else
   * 1 s doubling up to MAX_BACKOFF_MS. Only a full purge is sent again (see run()).
   * Purges keep being accepted and merged during the pause, and are sent after it.
   * Returns whether it gave up on what was waiting.
   */
  private applyBackoff(outcome: PurgeOutcome, startedAt: number): boolean {
    // Sent before the current pause began: part of the burst that caused it, so it
    // neither starts another pause nor, if it was answered normally, ends the recovery.
    const sentBeforePause = startedAt < this.pausedUntil;

    if (!isRefusal(outcome)) {
      // A timeout or network error is no answer, so it does not end the recovery either.
      if (!sentBeforePause && outcome.status !== undefined) {
        this.endRecovery();
      }
      return false;
    }

    const now = Date.now();
    if (sentBeforePause) {
      if (outcome.retryAfterMs !== undefined) {
        this.pausedUntil = Math.max(this.pausedUntil, now + Math.min(outcome.retryAfterMs, MAX_BACKOFF_MS));
      }
      return false;
    }

    // At least the base delay: a Retry-After of 0 would otherwise start a recovery with no pause.
    const requested = outcome.retryAfterMs ?? backoffBaseMs * 2 ** this.backoffLevel;
    const delay = Math.min(Math.max(requested, backoffBaseMs), MAX_BACKOFF_MS);
    this.backoffLevel++;
    this.refusedPauseMs += delay;
    this.pausedUntil = now + delay;

    const pausing = `Purge service answered HTTP ${outcome.status}: pausing edge purges for ${delay} ms`;
    if (this.refusedPauseMs < GIVE_UP_AFTER_PAUSED_MS) {
      log.warn(
        `${pausing} (${this.waiting.length} waiting, sent after the pause, ` +
          `one at a time until the service answers normally)`
      );
      return false;
    }
    this.giveUpOnWaiting(pausing);
    return true;
  }

  private endRecovery(): void {
    this.backoffLevel = 0;
    this.refusedPauseMs = 0;
  }

  /**
   * Fails the purges that are waiting; if none are, only logs the pause.
   *
   * Without this a service that never recovers would be sent one request per
   * pause for as long as purges waited, and the pause timer would hold the
   * process open, and any caller awaiting a purge, for all of it.
   *
   * What is requested afterwards is given the same patience: the sum starts
   * again, while the pauses stay as long as they had become.
   */
  private giveUpOnWaiting(pausing: string): void {
    const refusals = this.backoffLevel;
    const pausedFor = Math.round(this.refusedPauseMs / 1000);
    this.refusedPauseMs = 0;
    if (this.waiting.length === 0) {
      log.warn(pausing);
      return;
    }

    const givenUp = this.waiting;
    this.waiting = [];
    this.pathJobsWaiting = 0;
    const outcome: PurgeOutcome = {
      ok: false,
      error: `not sent: the purge service refused ${refusals} requests in a row`,
    };
    for (const job of givenUp) {
      this.jobs.delete(job.id);
      job.resolve(outcome);
    }
    log.warn(
      `${pausing}. It has refused ${refusals} requests in a row through ${pausedFor} s of pauses: ` +
        `gave up on ${givenUp.length} edge purges that were waiting. ` +
        `The CDN keeps those entries until they expire or are purged again`
    );
  }
}

/** One queue per purge target, not per clearer: Next constructs a handler, and so a clearer, per request. */
const queues = new Map<string, PurgeQueue>();

export function purgeQueueFor(target: string): PurgeQueue {
  let queue = queues.get(target);
  if (!queue) {
    queue = new PurgeQueue();
    queues.set(target, queue);
  }
  return queue;
}

/** @internal Test hook. */
export function resetPurgeQueuesForTests(): void {
  for (const queue of queues.values()) {
    queue.stop();
  }
  queues.clear();
}
