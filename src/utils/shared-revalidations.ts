import type { Bucket } from '@google-cloud/storage';
import { tagsManifest } from 'next/dist/server/lib/incremental-cache/tags-manifest.external.js';
import { createLogger } from './logger.js';
import {
  getErrorStatusCode,
  isNotFound,
  isPreconditionFailure,
  readJsonObject,
  writeJsonObject,
} from './gcs-json-object.js';

const log = createLogger('SharedRevalidations');

/** A tag's revalidation, as Next's tagsManifest records it, plus when it happened. */
export interface SharedRevalidation {
  stale?: number;
  expired?: number;
  at: number;
}

export type SharedRevalidationMap = Record<string, SharedRevalidation>;

export const DEFAULT_TAGS_REFRESH_INTERVAL_MS = 1000;
const MAX_PRECONDITION_RETRIES = 5;

/** Refresh interval from CACHE_TAGS_REFRESH_INTERVAL_MS (minimum 100 ms). */
export function resolveTagsRefreshIntervalMs(
  raw: string | undefined = process.env.CACHE_TAGS_REFRESH_INTERVAL_MS
): number {
  const parsed = raw === undefined || raw.trim() === '' ? NaN : Number(raw);
  return Number.isFinite(parsed) ? Math.max(100, Math.floor(parsed)) : DEFAULT_TAGS_REFRESH_INTERVAL_MS;
}

export interface SharedRevalidationsConfig {
  refreshIntervalMs?: number;
  /** How long record() keeps retrying a failed write. Default 5000 ms. */
  recordTimeoutMs?: number;
  /** How long a write waits so near-simultaneous revalidations share it. Default 250 ms. */
  batchWindowMs?: number;
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Tag revalidations shared by every instance through one GCS object, applied
 * to Next's process-wide tagsManifest. Next and the handlers check route and
 * fetch entries against that manifest, which otherwise only knows the
 * revalidations this process made.
 */
export class SharedRevalidations {
  readonly refreshIntervalMs: number;
  private readonly recordTimeoutMs: number;
  private readonly batchWindowMs: number;
  private storedCallbacks: { tags: string[]; callback: () => void }[] = [];
  private readonly known = new Map<string, SharedRevalidation>();
  private readonly unwritten = new Map<string, SharedRevalidation>();
  private version = 0;
  private writtenVersion = 0;
  private writing: Promise<boolean> | null = null;
  private refreshing: Promise<void> | null = null;
  private nextRefreshAt = 0;
  private lastGeneration: string | number | null = null;
  private refreshFailing = false;

  constructor(
    private readonly bucket: Bucket,
    private readonly key: string,
    config: SharedRevalidationsConfig = {}
  ) {
    this.refreshIntervalMs = config.refreshIntervalMs ?? resolveTagsRefreshIntervalMs();
    this.recordTimeoutMs = config.recordTimeoutMs ?? 5000;
    this.batchWindowMs = config.batchWindowMs ?? 250;
  }

  /** Whether revalidations are waiting to be stored (an earlier record() gave up). */
  get hasUnwritten(): boolean {
    return this.unwritten.size > 0;
  }

  /**
   * Run `callback` once none of `tags` is waiting to be stored: now if they
   * are stored, otherwise after the retry that stores them.
   */
  whenStored(tags: string[], callback: () => void): void {
    if (tags.some((tag) => this.unwritten.has(tag))) {
      this.storedCallbacks.push({ tags, callback });
    } else {
      callback();
    }
  }

  /**
   * Publish revalidations and wait until they are stored, so another instance
   * reading after this resolves sees them. Returns false if the write kept
   * failing until the timeout; the entries are retried on later calls.
   */
  async record(entries: SharedRevalidationMap): Promise<boolean> {
    this.learn(entries);
    for (const [tag, entry] of Object.entries(entries)) {
      this.unwritten.set(tag, entry);
    }
    const mine = ++this.version;
    const deadline = Date.now() + this.recordTimeoutMs;

    while (this.writtenVersion < mine) {
      // The window lets revalidations from the same moment (Next calls once per
      // cacheLife profile, in parallel) and from other requests share a write.
      this.writing ??= delay(this.batchWindowMs)
        .then(() => this.writeOnce())
        .finally(() => {
          this.writing = null;
        });
      if (await this.writing) {
        continue;
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        log.warn(
          `Could not store revalidation of ${Object.keys(entries).join(', ')}; other instances may serve stale entries until it is stored`
        );
        return false;
      }
      // The object takes about one write per second.
      await delay(Math.min(remaining, 1000 + Math.random() * 500));
    }
    return true;
  }

  /** Load revalidations from other instances, at most once per interval unless forced. */
  async refresh(force = false): Promise<void> {
    if (!force && Date.now() < this.nextRefreshAt) {
      return;
    }
    if (!this.refreshing) {
      this.refreshing = this.doRefresh().finally(() => {
        this.refreshing = null;
      });
    }
    await this.refreshing;
    if (this.unwritten.size > 0 && !this.writing) {
      // Retry entries an earlier record() gave up on.
      this.record({}).catch(() => {});
    }
  }

  /**
   * Remove stored revalidations older than `cutoff`, after `beforeRemove` has
   * handled what they still affect (it receives their tags; if it throws,
   * nothing is removed). Removing last means a reader that has not seen the
   * outcome of `beforeRemove` still sees the revalidation. Safe to run from
   * several instances at once. Returns the number of revalidations removed.
   */
  async prune(cutoff: number, beforeRemove: (tags: string[]) => Promise<void>): Promise<number> {
    const { value: initial } = await readJsonObject<SharedRevalidationMap>(this.bucket, this.key);
    const stale = Object.entries(initial ?? {})
      .filter(([, entry]) => !isRevalidation(entry) || entry.at < cutoff)
      .map(([tag]) => tag);
    if (stale.length === 0) {
      return 0;
    }

    await beforeRemove(stale);

    for (let attempt = 0; ; attempt++) {
      const { value: stored, generation } = await readJsonObject<SharedRevalidationMap>(this.bucket, this.key);
      const kept: SharedRevalidationMap = {};
      let removed = 0;
      for (const [tag, entry] of Object.entries(stored ?? {})) {
        // A tag revalidated again since the first read is kept.
        if (stale.includes(tag) && (!isRevalidation(entry) || entry.at < cutoff)) {
          removed++;
        } else {
          kept[tag] = entry;
        }
      }
      if (removed === 0) {
        return 0;
      }
      try {
        await writeJsonObject(this.bucket, this.key, kept, generation);
        log.info(`Pruned ${removed} revalidation(s) older than the previous build`);
        return removed;
      } catch (error) {
        if (isPreconditionFailure(error) && attempt < MAX_PRECONDITION_RETRIES) {
          continue;
        }
        throw error;
      }
    }
  }

  /** Revalidations known to this process (after a refresh, every instance's). */
  get(tag: string): SharedRevalidation | undefined {
    return this.known.get(tag);
  }

  private async doRefresh(): Promise<void> {
    this.nextRefreshAt = Date.now() + this.refreshIntervalMs;
    try {
      let generation: string | number;
      try {
        const [metadata] = await this.bucket.file(this.key).getMetadata();
        generation = metadata.generation ?? 0;
      } catch (error) {
        if (isNotFound(error)) {
          return;
        }
        throw error;
      }
      if (generation === this.lastGeneration) {
        return;
      }

      const { value, generation: readGeneration } = await readJsonObject<SharedRevalidationMap>(this.bucket, this.key);
      if (value) {
        this.learn(value);
      }
      this.lastGeneration = readGeneration;
      if (this.refreshFailing) {
        log.warn('Reading shared revalidations recovered');
        this.refreshFailing = false;
      }
    } catch (error) {
      if (!this.refreshFailing) {
        log.warn('Error reading shared revalidations; revalidations from other instances are not applied:', error);
        this.refreshFailing = true;
      }
    }
  }

  private async writeOnce(): Promise<boolean> {
    const snapshotVersion = this.version;
    const batch = new Map(this.unwritten);
    try {
      for (let attempt = 0; ; attempt++) {
        const { value: stored, generation } = await readJsonObject<SharedRevalidationMap>(this.bucket, this.key);
        if (stored) {
          this.learn(stored);
        }
        const merged: SharedRevalidationMap = { ...stored };
        let changed = false;
        for (const [tag, entry] of batch) {
          if (!isRevalidation(merged[tag]) || merged[tag].at < entry.at) {
            merged[tag] = entry;
            changed = true;
          }
        }
        if (!changed) {
          break;
        }
        try {
          await writeJsonObject(this.bucket, this.key, merged, generation);
          break;
        } catch (error) {
          if (isPreconditionFailure(error) && attempt < MAX_PRECONDITION_RETRIES) {
            continue;
          }
          throw error;
        }
      }

      for (const [tag, entry] of batch) {
        if (this.unwritten.get(tag) === entry) {
          this.unwritten.delete(tag);
        }
      }
      this.writtenVersion = Math.max(this.writtenVersion, snapshotVersion);
      this.runStoredCallbacks();
      return true;
    } catch (error) {
      const code = getErrorStatusCode(error);
      log.debug(`Writing shared revalidations failed (${code === 429 ? 'rate limited (429)' : (code ?? 'error')})`);
      return false;
    }
  }

  private runStoredCallbacks(): void {
    const ready = this.storedCallbacks.filter(({ tags }) => !tags.some((tag) => this.unwritten.has(tag)));
    this.storedCallbacks = this.storedCallbacks.filter((entry) => !ready.includes(entry));
    for (const { callback } of ready) {
      try {
        callback();
      } catch (error) {
        log.error('Error after storing revalidations:', error);
      }
    }
  }

  /** Keep the latest revalidation per tag and mirror it into tagsManifest. */
  private learn(entries: SharedRevalidationMap): void {
    for (const [tag, entry] of Object.entries(entries)) {
      const current = this.known.get(tag);
      if (!isRevalidation(entry) || (current && current.at >= entry.at)) {
        continue;
      }
      this.known.set(tag, entry);
      tagsManifest.set(tag, {
        ...(entry.stale !== undefined ? { stale: entry.stale } : {}),
        ...(entry.expired !== undefined ? { expired: entry.expired } : {}),
      });
    }
  }
}

/** Stored data is read back from GCS, so check its shape before trusting it. */
function isRevalidation(value: unknown): value is SharedRevalidation {
  return typeof value === 'object' && value !== null && typeof (value as SharedRevalidation).at === 'number';
}

const stores = new Map<string, SharedRevalidations>();

/** One store per (bucket, object) per process; handlers are constructed per request. */
export function getSharedRevalidations(bucketName: string, bucket: Bucket, key: string): SharedRevalidations {
  const id = `${bucketName}/${key}`;
  let store = stores.get(id);
  if (!store) {
    store = new SharedRevalidations(bucket, key);
    stores.set(id, store);
  }
  return store;
}

/**
 * Store revalidations an earlier record() gave up on, for shutdown. Returns
 * whether every store has nothing left to write.
 */
export async function flushSharedRevalidations(timeoutMs: number): Promise<boolean> {
  const pending = [...stores.values()].filter((store) => store.hasUnwritten);
  const deadline = Date.now() + timeoutMs;
  await Promise.all(
    pending.map(async (store) => {
      while (store.hasUnwritten && Date.now() < deadline) {
        await store.record({});
      }
    })
  );
  return pending.every((store) => !store.hasUnwritten);
}

/** @internal Test hook. */
export function resetSharedRevalidationsForTests(): void {
  stores.clear();
}
