import type { EdgeCacheClear } from '../edge/edge-cache-clear.js';
import { createLogger } from './logger.js';

const log = createLogger('DelayedPurges');

/**
 * How long past its due time a purge may wait so purges due close together go
 * out as one batch: at most about one batch per second per process.
 */
export const MERGE_WINDOW_MS = 1000;

export interface DelayedPurge {
  keys?: string[];
  paths?: string[];
  /** Purge the whole site (revalidatePath('/', 'layout')). */
  purgeAll?: boolean;
}

interface Pending extends Required<DelayedPurge> {
  clearer: EdgeCacheClear;
  due: number;
  context: string;
}

/**
 * CDN purges that must wait until every instance has applied a revalidation.
 * Run on a timer, not awaited, so the request that revalidated does not wait.
 * A timer starved of CPU (Cloud Run between requests) fires once the instance
 * runs again, at its next request.
 */
export class DelayedPurges {
  private pending: Pending[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private timerAt = Infinity;

  /** Purge no earlier than `due`; merged with others due within MERGE_WINDOW_MS. */
  schedule(clearer: EdgeCacheClear, purge: DelayedPurge, due: number, context: string): void {
    this.pending.push({
      clearer,
      keys: purge.keys ?? [],
      paths: purge.paths ?? [],
      purgeAll: purge.purgeAll ?? false,
      due,
      context,
    });
    this.arm();
  }

  get size(): number {
    return this.pending.length;
  }

  /** Send every purge now, waiting until it is due if that is before `deadline`. For shutdown. */
  async flush(deadline: number): Promise<void> {
    if (this.pending.length === 0) {
      return;
    }
    const lastDue = Math.max(...this.pending.map(({ due }) => due));
    const wait = Math.min(lastDue, deadline) - Date.now();
    if (wait > 0) {
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
    await this.send(this.take(() => true));
  }

  /** @internal Test hook. */
  reset(): void {
    if (this.timer) {
      clearTimeout(this.timer);
    }
    this.timer = null;
    this.timerAt = Infinity;
    this.pending = [];
  }

  private arm(): void {
    if (this.pending.length === 0) {
      return;
    }
    const at = Math.min(...this.pending.map(({ due }) => due)) + MERGE_WINDOW_MS;
    if (this.timer && this.timerAt <= at) {
      return;
    }
    if (this.timer) {
      clearTimeout(this.timer);
    }
    this.timerAt = at;
    this.timer = setTimeout(() => this.runDue(), Math.max(0, at - Date.now()));
    // Never keeps a process (or `next build`) alive; flush() covers shutdown.
    this.timer.unref?.();
  }

  private runDue(): void {
    this.timer = null;
    this.timerAt = Infinity;
    const now = Date.now();
    const due = this.take((purge) => purge.due <= now);
    this.arm();
    this.send(due).catch((error) => log.warn('Delayed CDN purge failed:', error));
  }

  private take(predicate: (purge: Pending) => boolean): Pending[] {
    const taken = this.pending.filter(predicate);
    this.pending = this.pending.filter((purge) => !predicate(purge));
    return taken;
  }

  /**
   * One purge per target, each path and key once. By target, not instance:
   * Next constructs a handler, and so a clearer, per request.
   */
  private async send(purges: Pending[]): Promise<void> {
    const byTarget = new Map<string, Pending[]>();
    for (const purge of purges) {
      byTarget.set(purge.clearer.target, [...(byTarget.get(purge.clearer.target) ?? []), purge]);
    }
    await Promise.all(
      [...byTarget.values()].map(async (group) => {
        const { clearer } = group[0];
        const keys = [...new Set(group.flatMap((purge) => purge.keys))];
        const paths = [...new Set(group.flatMap((purge) => purge.paths))];
        const purgeAll = group.some((purge) => purge.purgeAll);
        log.debug(`Delayed CDN purge for ${group.map((purge) => purge.context).join('; ')}`);
        const sends: Promise<unknown>[] = [];
        if (keys.length > 0) {
          sends.push(clearer.clearKeys(keys));
        }
        sends.push(purgeAll ? clearer.nukeCache() : clearer.clearPaths(paths));
        await Promise.all(sends);
      })
    );
  }
}
