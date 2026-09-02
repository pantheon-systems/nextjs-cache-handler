import { createLogger } from './logger.js';

/**
 * Buffered tags manager for GCS to avoid rate limiting.
 * GCS has a rate limit of 1 write per second per object.
 * This buffer collects tag updates and flushes them periodically.
 */

export interface TagsBufferConfig {
  /** Minimum interval between flushes in milliseconds. Default: 1000ms */
  flushIntervalMs?: number;
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

/**
 * Buffers tag mapping updates to avoid GCS rate limiting.
 * Collects updates in memory and flushes them at most once per second.
 */
export class TagsBuffer {
  private readonly flushIntervalMs: number;
  private readonly readTagsMapping: () => Promise<Record<string, string[]>>;
  private readonly writeTagsMapping: (tagsMapping: Record<string, string[]>) => Promise<void>;
  private readonly log: ReturnType<typeof createLogger>;

  private pendingUpdates: PendingUpdate[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private lastFlushTime = 0;
  private isFlushing = false;
  private flushPromise: Promise<void> | null = null;

  constructor(config: TagsBufferConfig) {
    this.flushIntervalMs = config.flushIntervalMs ?? 1000;
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
      this.scheduleFlush();
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

    // Take all pending updates
    const updates = this.pendingUpdates;
    this.pendingUpdates = [];

    try {
      // Read current state
      const tagsMapping = await this.readTagsMapping();

      // Apply all updates
      this.applyUpdates(tagsMapping, updates);

      // Write back
      await this.writeTagsMapping(tagsMapping);

      this.lastFlushTime = Date.now();
      this.log.debug(`Flushed ${updates.length} tag updates`);
    } catch (error) {
      // On failure, put updates back for retry
      this.pendingUpdates = [...updates, ...this.pendingUpdates];
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
  }
}
