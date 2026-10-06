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
}

/**
 * Tag revalidations shared by every instance through one GCS object, applied
 * to Next's process-wide tagsManifest. Next and the handlers check route and
 * fetch entries against that manifest, which otherwise only knows the
 * revalidations this process made.
 */
export class SharedRevalidations {
  private readonly refreshIntervalMs: number;
  private readonly recordTimeoutMs: number;
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
      this.writing ??= this.writeOnce().finally(() => {
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
      await new Promise((resolve) => setTimeout(resolve, Math.min(remaining, 1000 + Math.random() * 500)));
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
          if (!merged[tag] || merged[tag].at < entry.at) {
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
      return true;
    } catch (error) {
      const code = getErrorStatusCode(error);
      log.debug(`Writing shared revalidations failed (${code === 429 ? 'rate limited (429)' : (code ?? 'error')})`);
      return false;
    }
  }

  /** Keep the latest revalidation per tag and mirror it into tagsManifest. */
  private learn(entries: SharedRevalidationMap): void {
    for (const [tag, entry] of Object.entries(entries)) {
      const current = this.known.get(tag);
      if (current && current.at >= entry.at) {
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

/** @internal Test hook. */
export function resetSharedRevalidationsForTests(): void {
  stores.clear();
}
