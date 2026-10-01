import { createLogger } from './logger.js';
import { isPreconditionFailure, getErrorStatusCode } from './gcs-json-object.js';

/**
 * Buffers tag-mapping updates so a shared GCS object is rewritten at most once
 * per interval per process (GCS allows one write per second per object).
 * Share one per process, not per handler (see GcsCacheHandler).
 */

export type TagsMapping = Record<string, string[]>;

export interface TagsMappingSnapshot {
  mapping: TagsMapping;
  /** Generation the mapping was read at; 0 when the object does not exist yet. */
  generation: string | number;
}

export interface TagsBufferConfig {
  /** Minimum interval between flushes in milliseconds. Default: DEFAULT_TAGS_FLUSH_INTERVAL_MS */
  flushIntervalMs?: number;
  /** Read the current tags mapping and its generation from storage. */
  readTagsMapping: () => Promise<TagsMappingSnapshot>;
  /**
   * Write the mapping, conditional on the generation still matching. Must
   * reject with an error whose `code` is 412 when it does not.
   */
  writeTagsMapping: (tagsMapping: TagsMapping, generation: string | number) => Promise<void>;
  /** Handler name for logging */
  handlerName?: string;
  /** Longest delay between retries after failures. Default: 60s */
  maxBackoffMs?: number;
  /**
   * How long updates may stay pending through failed flushes before the batch
   * is dropped (with an error log). Default: 10 minutes. Age-based rather than
   * attempt-based so a fast retry loop (e.g. a shutdown flush) cannot trip it.
   */
  maxPendingAgeMs?: number;
  /** How many 412 conflicts a single flush re-reads and retries through. Default: 3 */
  maxPreconditionRetries?: number;
  /**
   * Fraction by which each interval is randomly lengthened (0 to 1). Default: 0.25.
   * Processes that start together would otherwise flush the shared object in the
   * same second forever; upward-only jitter keeps the "at most once per interval"
   * guarantee while spreading them out.
   */
  intervalJitter?: number;
}

interface PendingBatch {
  adds: Map<string, Set<string>>;
  deletes: Set<string>;
}

export const DEFAULT_TAGS_FLUSH_INTERVAL_MS = 5000;
export const MIN_TAGS_FLUSH_INTERVAL_MS = 1000;

/** Flush interval from CACHE_TAGS_FLUSH_INTERVAL_MS, clamped to the GCS per-object write rate. */
export function resolveTagsFlushIntervalMs(raw: string | undefined = process.env.CACHE_TAGS_FLUSH_INTERVAL_MS): number {
  const parsed = raw === undefined || raw.trim() === '' ? NaN : Number(raw);
  if (!Number.isFinite(parsed)) {
    return DEFAULT_TAGS_FLUSH_INTERVAL_MS;
  }
  return Math.max(MIN_TAGS_FLUSH_INTERVAL_MS, Math.floor(parsed));
}

export class TagsBuffer {
  private readonly flushIntervalMs: number;
  private readonly maxBackoffMs: number;
  private readonly maxPendingAgeMs: number;
  private readonly maxPreconditionRetries: number;
  private readonly intervalJitter: number;
  private readonly readTagsMapping: TagsBufferConfig['readTagsMapping'];
  private readonly writeTagsMapping: TagsBufferConfig['writeTagsMapping'];
  private readonly log: ReturnType<typeof createLogger>;

  private pending: PendingBatch = { adds: new Map(), deletes: new Set() };
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private flushPromise: Promise<void> | null = null;
  private lastFlushTime = 0;
  /** Earliest time the next flush may start (interval pacing or failure backoff). */
  private nextFlushTime = 0;
  private consecutiveFailures = 0;
  /** When the oldest currently-pending update was queued. */
  private oldestPendingSince = 0;
  private droppedUpdatesTotal = 0;

  constructor(config: TagsBufferConfig) {
    this.flushIntervalMs = config.flushIntervalMs ?? DEFAULT_TAGS_FLUSH_INTERVAL_MS;
    this.maxBackoffMs = config.maxBackoffMs ?? 60_000;
    this.maxPendingAgeMs = config.maxPendingAgeMs ?? 600_000;
    this.maxPreconditionRetries = config.maxPreconditionRetries ?? 3;
    this.intervalJitter = Math.min(1, Math.max(0, config.intervalJitter ?? 0.25));
    this.readTagsMapping = config.readTagsMapping;
    this.writeTagsMapping = config.writeTagsMapping;
    this.log = createLogger(config.handlerName ?? 'TagsBuffer');
    // Let the first flush collect a full interval's worth of updates.
    this.nextFlushTime = Date.now() + this.nextInterval();
  }

  /** The configured interval, lengthened by up to `intervalJitter`. */
  private nextInterval(): number {
    return Math.round(this.flushIntervalMs * (1 + this.intervalJitter * Math.random()));
  }

  /** Queue a tag addition for a cache key. */
  addTags(cacheKey: string, tags: string[]): void {
    if (tags.length === 0) {
      return;
    }

    this.markPending();
    let set = this.pending.adds.get(cacheKey);
    if (!set) {
      set = new Set();
      this.pending.adds.set(cacheKey, set);
    }
    for (const tag of tags) {
      set.add(tag);
    }

    this.scheduleFlush();
  }

  /** Queue a cache key's removal from every tag. */
  deleteKey(cacheKey: string): void {
    this.markPending();
    this.pending.deletes.add(cacheKey);
    this.scheduleFlush();
  }

  /** Queue several cache keys for removal from every tag. */
  deleteKeys(cacheKeys: string[]): void {
    if (cacheKeys.length > 0) {
      this.markPending();
    }
    for (const cacheKey of cacheKeys) {
      this.pending.deletes.add(cacheKey);
    }
    if (cacheKeys.length > 0) {
      this.scheduleFlush();
    }
  }

  /** Number of cache keys with queued updates. */
  get pendingCount(): number {
    return this.pending.adds.size + this.pending.deletes.size;
  }

  get hasPending(): boolean {
    return this.pendingCount > 0;
  }

  /** Total updates dropped after exceeding maxPendingAgeMs (see onFlushFailure). */
  get droppedUpdates(): number {
    return this.droppedUpdatesTotal;
  }

  private markPending(): void {
    if (!this.hasPending) {
      this.oldestPendingSince = Date.now();
    }
  }

  /**
   * The mapping as it will look once pending updates land, without writing.
   * Lets readers see queued updates without forcing a flush (and a write).
   */
  overlay(mapping: TagsMapping): TagsMapping {
    const copy: TagsMapping = {};
    for (const [tag, keys] of Object.entries(mapping)) {
      copy[tag] = [...keys];
    }
    applyBatch(copy, this.pending);
    return copy;
  }

  /**
   * Start a flush if one is due (interval elapsed, not backing off, nothing in
   * flight). Returns the flush promise so a caller running inside a request can
   * await it; Cloud Run may not grant CPU to timers between requests.
   */
  flushIfDue(): Promise<void> | null {
    if (!this.hasPending || this.flushPromise || Date.now() < this.nextFlushTime) {
      return null;
    }
    return this.flush();
  }

  /** Flush pending updates now, regardless of the interval. Never rejects. */
  async flush(): Promise<void> {
    if (this.flushPromise) {
      await this.flushPromise;
      if (this.hasPending) {
        return this.flush();
      }
      return;
    }

    if (!this.hasPending) {
      return;
    }

    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }

    this.flushPromise = this.doFlush();
    try {
      await this.flushPromise;
    } finally {
      this.flushPromise = null;
    }

    // Updates queued during the flush (or restored after a failure) wait for
    // the next slot: nextFlushTime already holds the interval or the backoff.
    if (this.hasPending) {
      this.scheduleFlush();
    }
  }

  private scheduleFlush(): void {
    if (this.flushTimer || this.flushPromise) {
      return;
    }

    const delay = Math.max(0, this.nextFlushTime - Date.now());
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flush().catch((error) => {
        this.log.error('Error during scheduled flush:', error);
      });
    }, delay);
    // A pending flush must not keep the process alive on its own.
    this.flushTimer.unref?.();
  }

  private async doFlush(): Promise<void> {
    const batch = this.pending;
    const batchSince = this.oldestPendingSince;
    this.pending = { adds: new Map(), deletes: new Set() };
    const batchSize = batch.adds.size + batch.deletes.size;

    try {
      let changed = false;
      for (let attempt = 0; ; attempt++) {
        const { mapping, generation } = await this.readTagsMapping();
        changed = applyBatch(mapping, batch);

        if (!changed) {
          break;
        }

        try {
          await this.writeTagsMapping(mapping, generation);
          break;
        } catch (error) {
          if (isPreconditionFailure(error) && attempt < this.maxPreconditionRetries) {
            this.log.debug(`Tags mapping changed underneath us (generation ${generation}), re-reading`);
            continue;
          }
          throw error;
        }
      }

      this.onFlushSuccess(batchSize, changed);
    } catch (error) {
      this.restorePending(batch);
      this.oldestPendingSince = this.hasPending ? Math.min(batchSince, this.oldestPendingSince || batchSince) : 0;
      this.onFlushFailure(error);
    }
  }

  private onFlushSuccess(batchSize: number, changed: boolean): void {
    const now = Date.now();
    this.lastFlushTime = now;
    this.nextFlushTime = now + this.nextInterval();

    if (this.consecutiveFailures > 0) {
      this.log.warn(`Tags mapping write recovered after ${this.consecutiveFailures} failed attempt(s)`);
      this.consecutiveFailures = 0;
    }

    this.log.debug(
      changed ? `Flushed ${batchSize} tag updates` : `Skipped write: ${batchSize} tag updates changed nothing`
    );
  }

  private onFlushFailure(error: unknown): void {
    this.consecutiveFailures++;
    const code = getErrorStatusCode(error);
    const reason = code === 429 ? 'rate limited (429)' : code ? `HTTP ${code}` : 'error';

    const pendingForMs = Date.now() - this.oldestPendingSince;
    if (pendingForMs > this.maxPendingAgeMs) {
      const dropped = this.pendingCount;
      this.pending = { adds: new Map(), deletes: new Set() };
      this.droppedUpdatesTotal += dropped;
      this.consecutiveFailures = 0;
      this.oldestPendingSince = 0;
      this.nextFlushTime = Date.now() + this.nextInterval();
      this.log.error(
        `Dropping ${dropped} pending tag update(s): writes have failed for ${Math.round(pendingForMs / 1000)}s ` +
          `(last: ${reason}). Revalidating tags may not purge the CDN for the affected pages.`,
        error
      );
      return;
    }

    const delay = this.backoffDelay();
    this.nextFlushTime = Date.now() + delay;

    if (this.consecutiveFailures === 1) {
      this.log.warn(
        `Tags mapping write failed (${reason}); ${this.pendingCount} update(s) pending, retrying in ${delay}ms. ` +
          `Repeated 429s mean more instances are writing than the flush interval absorbs ` +
          `(raise CACHE_TAGS_FLUSH_INTERVAL_MS).`,
        error
      );
    } else {
      this.log.debug(
        `Tags mapping write failed again (${reason}, attempt ${this.consecutiveFailures}), retrying in ${delay}ms`
      );
    }
  }

  /** Exponential backoff with jitter that only pulls earlier, so instances de-synchronize. */
  private backoffDelay(): number {
    const base = Math.min(this.flushIntervalMs * 2 ** this.consecutiveFailures, this.maxBackoffMs);
    return Math.round(base * (0.75 + Math.random() * 0.25));
  }

  private restorePending(batch: PendingBatch): void {
    for (const [cacheKey, tags] of batch.adds) {
      let set = this.pending.adds.get(cacheKey);
      if (!set) {
        set = new Set();
        this.pending.adds.set(cacheKey, set);
      }
      for (const tag of tags) {
        set.add(tag);
      }
    }
    for (const cacheKey of batch.deletes) {
      this.pending.deletes.add(cacheKey);
    }
  }

  /** Cancel any pending flush timer. Call this when shutting down. */
  destroy(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
  }
}

/**
 * Apply a batch in place: deletions first, then additions. Returns whether
 * the mapping actually changed, so unchanged mappings are not rewritten.
 */
function applyBatch(tagsMapping: TagsMapping, batch: PendingBatch): boolean {
  let changed = false;

  if (batch.deletes.size > 0) {
    for (const tag of Object.keys(tagsMapping)) {
      const before = tagsMapping[tag].length;
      const remaining = tagsMapping[tag].filter((key) => !batch.deletes.has(key));
      if (remaining.length !== before) {
        changed = true;
        if (remaining.length === 0) {
          delete tagsMapping[tag];
        } else {
          tagsMapping[tag] = remaining;
        }
      }
    }
  }

  for (const [cacheKey, tags] of batch.adds) {
    for (const tag of tags) {
      if (!tagsMapping[tag]) {
        tagsMapping[tag] = [];
      }
      if (!tagsMapping[tag].includes(cacheKey)) {
        tagsMapping[tag].push(cacheKey);
        changed = true;
      }
    }
  }

  return changed;
}
