import { createLogger } from './logger.js';

/**
 * Buffered tags manager for GCS to avoid rate limiting.
 * GCS has a rate limit of 1 write per second per object.
 * This buffer collects tag updates and flushes them periodically.
 */

export interface TagsBufferConfig {
  /** Minimum interval between flushes in milliseconds. Default: 1000ms */
  flushIntervalMs?: number;
  /**
   * Upper bound on how long {@link TagsBuffer.awaitDurable} will wait for a
   * queued update to reach storage before giving up and returning. Default:
   * 5000ms. Set to 0 to wait indefinitely.
   */
  durabilityTimeoutMs?: number;
  /** Read the current tags mapping from storage */
  readTagsMapping: () => Promise<Record<string, string[]>>;
  /** Write the tags mapping to storage */
  writeTagsMapping: (tagsMapping: Record<string, string[]>) => Promise<void>;
  /** Handler name for logging */
  handlerName?: string;
}

interface PendingUpdate {
  type: 'add' | 'delete';
  cacheKey: string;
  tags?: string[];
}

/** A promise plus its resolver, used to signal that a batch reached storage. */
interface Durability {
  promise: Promise<void>;
  resolve: () => void;
}

function createDurability(): Durability {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/**
 * Buffers tag mapping updates to avoid GCS rate limiting.
 * Collects updates in memory and flushes them at most once per second.
 */
export class TagsBuffer {
  private readonly flushIntervalMs: number;
  private readonly durabilityTimeoutMs: number;
  private readonly readTagsMapping: () => Promise<Record<string, string[]>>;
  private readonly writeTagsMapping: (tagsMapping: Record<string, string[]>) => Promise<void>;
  private readonly log: ReturnType<typeof createLogger>;

  private pendingUpdates: PendingUpdate[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private lastFlushTime = 0;
  private isFlushing = false;
  private flushPromise: Promise<void> | null = null;

  /**
   * Resolves once the currently-queued batch has been written to storage.
   * Null when nothing is pending (i.e. everything queued so far is durable).
   */
  private durability: Durability | null = null;

  constructor(config: TagsBufferConfig) {
    this.flushIntervalMs = config.flushIntervalMs ?? 1000;
    this.durabilityTimeoutMs = config.durabilityTimeoutMs ?? 5000;
    this.readTagsMapping = config.readTagsMapping;
    this.writeTagsMapping = config.writeTagsMapping;
    this.log = createLogger(config.handlerName ?? 'TagsBuffer');
  }

  /**
   * Queue a tag addition for a cache key.
   * The update will be flushed to storage at most once per second.
   */
  addTags(cacheKey: string, tags: string[]): void {
    if (tags.length === 0) {
      return;
    }

    this.pendingUpdates.push({
      type: 'add',
      cacheKey,
      tags,
    });

    this.ensureDurability();
    this.scheduleFlush();
  }

  /**
   * Queue a cache key deletion from all tags.
   * The update will be flushed to storage at most once per second.
   */
  deleteKey(cacheKey: string): void {
    this.pendingUpdates.push({
      type: 'delete',
      cacheKey,
    });

    this.ensureDurability();
    this.scheduleFlush();
  }

  /**
   * Queue multiple cache keys for deletion from all tags.
   */
  deleteKeys(cacheKeys: string[]): void {
    for (const cacheKey of cacheKeys) {
      this.pendingUpdates.push({
        type: 'delete',
        cacheKey,
      });
    }

    if (cacheKeys.length > 0) {
      this.ensureDurability();
      this.scheduleFlush();
    }
  }

  /**
   * Wait until everything queued so far has actually been written to storage.
   *
   * This is the durability guarantee callers need before they can treat a
   * queued tag mapping as visible to OTHER processes. `flush()` forces an
   * immediate write and so defeats the once-per-interval coalescing this
   * buffer exists to provide; `awaitDurable()` instead waits for the already
   * scheduled flush, so GCS still sees at most one write per interval per
   * object. When the buffer is idle (nothing pending, last flush long enough
   * ago) the scheduled delay is 0 and this resolves after a single round trip.
   *
   * Never rejects: a storage failure is retried by the buffer itself, and the
   * caller has already durably written the cache entry this mapping describes,
   * so surfacing the error here would only mask an otherwise successful write.
   * Bounded by `durabilityTimeoutMs` so a request can never hang on storage.
   */
  async awaitDurable(): Promise<void> {
    const durability = this.durability;
    if (!durability) {
      // Nothing pending -- everything queued so far already reached storage.
      return;
    }

    if (this.durabilityTimeoutMs <= 0) {
      await durability.promise;
      return;
    }

    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), this.durabilityTimeoutMs);
    });

    try {
      const outcome = await Promise.race([durability.promise.then(() => 'durable' as const), timedOut]);
      if (outcome === 'timeout') {
        this.log.warn(
          `Tag mapping did not reach storage within ${this.durabilityTimeoutMs}ms (pending: ${this.pendingCount}) -- ` +
            'continuing; the buffer will keep retrying, but a revalidateTag() in this window may not see these keys'
        );
      }
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Force an immediate flush of pending updates.
   * Use this when you need to ensure updates are persisted (e.g., before reading).
   */
  async flush(): Promise<void> {
    // If already flushing, wait for that to complete
    if (this.flushPromise) {
      await this.flushPromise;
      // After waiting, check if there are still pending updates
      if (this.pendingUpdates.length > 0) {
        return this.flush();
      }
      return;
    }

    if (this.pendingUpdates.length === 0) {
      return;
    }

    this.flushPromise = this.doFlush();
    try {
      await this.flushPromise;
    } finally {
      this.flushPromise = null;
    }
  }

  /**
   * Get the number of pending updates.
   */
  get pendingCount(): number {
    return this.pendingUpdates.length;
  }

  /**
   * Re-attach the durability signal of a batch that failed to write. If newer
   * enqueues already opened a signal, chain onto it so awaiters of the failed
   * batch resolve when the retry carrying their updates succeeds.
   */
  private restoreDurability(durability: Durability): void {
    const newer = this.durability;
    if (newer) {
      newer.promise.then(durability.resolve, durability.resolve);
    } else {
      this.durability = durability;
    }
  }

  /** Open a durability signal for the current batch if one isn't already open. */
  private ensureDurability(): void {
    if (!this.durability) {
      this.durability = createDurability();
    }
  }

  private scheduleFlush(): void {
    // If a timer is already scheduled, let it handle the flush
    if (this.flushTimer) {
      return;
    }

    const timeSinceLastFlush = Date.now() - this.lastFlushTime;
    const delay = Math.max(0, this.flushIntervalMs - timeSinceLastFlush);

    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flush().catch((error) => {
        this.log.error('Error during scheduled flush:', error);
      });
    }, delay);
  }

  private async doFlush(): Promise<void> {
    if (this.isFlushing || this.pendingUpdates.length === 0) {
      return;
    }

    this.isFlushing = true;

    // Take all pending updates, and the durability signal that covers them
    const updates = this.pendingUpdates;
    this.pendingUpdates = [];
    const durability = this.durability;
    this.durability = null;

    try {
      // Read current state
      const tagsMapping = await this.readTagsMapping();

      // Apply all updates
      this.applyUpdates(tagsMapping, updates);

      // Write back
      await this.writeTagsMapping(tagsMapping);

      this.lastFlushTime = Date.now();
      durability?.resolve();
      this.log.debug(`Flushed ${updates.length} tag updates`);
    } catch (error) {
      // On failure, put updates back for retry
      this.pendingUpdates = [...updates, ...this.pendingUpdates];
      // These updates are not durable yet, so keep their signal unresolved and
      // attached to whichever batch will carry them. Enqueues that landed
      // during this flush opened a newer signal; chain onto it so awaiters of
      // the older one resolve when the retry that includes them succeeds.
      if (durability) {
        this.restoreDurability(durability);
      }
      this.log.error('Error flushing tags, will retry:', error);

      // Schedule a retry with backoff
      if (!this.flushTimer) {
        this.flushTimer = setTimeout(() => {
          this.flushTimer = null;
          this.flush().catch((e) => {
            this.log.error('Retry flush failed:', e);
          });
        }, this.flushIntervalMs * 2);
      }
    } finally {
      this.isFlushing = false;
    }
  }

  private applyUpdates(tagsMapping: Record<string, string[]>, updates: PendingUpdate[]): void {
    // Collect all keys to delete for efficient removal
    const keysToDelete = new Set<string>();

    for (const update of updates) {
      if (update.type === 'delete') {
        keysToDelete.add(update.cacheKey);
      }
    }

    // Remove deleted keys from all tags
    if (keysToDelete.size > 0) {
      for (const tag of Object.keys(tagsMapping)) {
        tagsMapping[tag] = tagsMapping[tag].filter((key) => !keysToDelete.has(key));
        if (tagsMapping[tag].length === 0) {
          delete tagsMapping[tag];
        }
      }
    }

    // Add new tag mappings
    for (const update of updates) {
      if (update.type === 'add' && update.tags) {
        for (const tag of update.tags) {
          if (!tagsMapping[tag]) {
            tagsMapping[tag] = [];
          }
          if (!tagsMapping[tag].includes(update.cacheKey)) {
            tagsMapping[tag].push(update.cacheKey);
          }
        }
      }
    }
  }

  /**
   * Cancel any pending flush timer.
   * Call this when shutting down.
   */
  destroy(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    // Nothing will flush after this, so release anyone in awaitDurable()
    // rather than making them wait out the full durability timeout.
    this.durability?.resolve();
    this.durability = null;
  }
}
