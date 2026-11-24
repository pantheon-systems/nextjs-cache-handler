import { createLogger } from '../utils/logger.js';
import { parseRetryAfter, purgeQueueFor, resolvePurgeMaxPaths, type PurgeOutcome } from './purge-queue.js';

const edgeLog = createLogger('EdgeCacheClear');

const PATH_OR_KEY_TIMEOUT_MS = 5000;
const FULL_PURGE_TIMEOUT_MS = 10000;

/**
 * How long a request, or a process starting up, waits for a purge it asked for.
 * A purge waits its turn in the queue, and through any pause while the purge
 * service is overloaded, so without this a caller could wait as long as that
 * lasts. The purge is still sent; only the waiting stops. A full purge's own
 * timeout: the longest a caller could wait before purges were queued.
 */
export const PURGE_WAIT_MS = FULL_PURGE_TIMEOUT_MS;

/** What a caller that needs a result reports for a purge that outlasted PURGE_WAIT_MS. */
export const PURGE_NOT_CONFIRMED: CacheClearResult = {
  success: false,
  error: `no answer within ${PURGE_WAIT_MS / 1000} s; the purge is still waiting or in flight`,
};

/** `work`'s result, or undefined if it has not settled within `ms`. `work` keeps running. */
export async function settledWithin<T>(work: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), ms);
  });
  try {
    return await Promise.race([work, timedOut]);
  } finally {
    clearTimeout(timer);
  }
}

// Purge values partly come from the build output (routes, build ID, tags), so
// only path- and tag-shaped strings leave the process. Next caps a tag at 256
// characters and a revalidatePath path at 1024 (lib/constants.ts); a path also
// carries basePath and, for a data route, `/_next/data/<buildId>/...json`.
const MAX_PATH_LENGTH = 2048;
const MAX_KEY_LENGTH = 1024 + 32;
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

function isSendable(value: string, maxLength: number): boolean {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength && !CONTROL_CHARS.test(value);
}

function withLeadingSlash(routePath: string): string {
  return routePath.startsWith('/') ? routePath : `/${routePath}`;
}

/**
 * Result of a cache clear operation.
 */
export interface CacheClearResult {
  success: boolean;
  error?: string;
  statusCode?: number;
  duration?: number;
  paths?: string[];
  /** The paths were over CACHE_PURGE_MAX_PATHS, so the whole edge cache was purged instead. */
  fullPurge?: boolean;
}

/**
 * Edge cache clearer for clearing CDN cache via the outbound proxy.
 * This is an internal class not exposed in the public API.
 * @internal
 */
export class EdgeCacheClear {
  private baseUrl: string;

  constructor(endpoint?: string) {
    const proxyEndpoint = endpoint || process.env.OUTBOUND_PROXY_ENDPOINT;
    if (!proxyEndpoint) {
      throw new Error('OUTBOUND_PROXY_ENDPOINT environment variable is required for edge cache clearing');
    }
    this.baseUrl = `http://${proxyEndpoint}/rest/v0alpha1/cache`;
  }

  /** Where purges go. Clearers with the same target are interchangeable. */
  get target(): string {
    return this.baseUrl;
  }

  /**
   * How long a request should wait for a purge it asks for now. Not at all when
   * the purge service has refused a request and the pause that follows outlasts
   * the limit: nothing would be sent before the request stopped waiting. Through
   * a shorter pause it does wait, because on Cloud Run the timer that ends the
   * pause may not run once no request is being served.
   */
  get waitMs(): number {
    return purgeQueueFor(this.baseUrl).pauseLeftMs >= PURGE_WAIT_MS ? 0 : PURGE_WAIT_MS;
  }

  /**
   * One DELETE to the outbound proxy, as the queue's `send`. A failure is logged
   * here, once per request, and not by the callers: many of them can share one request.
   */
  private request(what: string, url: string, timeoutMs: number): () => Promise<PurgeOutcome> {
    return async () => {
      const outcome = await this.sendDelete(url, timeoutMs);
      if (outcome.ok) {
        return outcome;
      }
      if (outcome.status === undefined) {
        edgeLog.warn(`Error clearing ${what}:`, outcome.cause ?? outcome.error);
      } else {
        edgeLog.warn(`Failed to clear ${what}: HTTP ${outcome.status}`);
      }
      return outcome;
    };
  }

  /** The timeout runs from when the request starts, not from when it was queued. */
  private async sendDelete(url: string, timeoutMs: number): Promise<PurgeOutcome> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, {
        method: 'DELETE',
        headers: {
          'Content-Type': 'application/json',
        },
        signal: controller.signal,
      });
      if (response.ok) {
        return { ok: true, status: response.status };
      }
      return {
        ok: false,
        status: response.status,
        retryAfterMs: parseRetryAfter(response.headers.get('retry-after')),
        error: await response.text().catch(() => 'Unknown error'),
      };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : 'Unknown error', cause: error };
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * Clear the entire edge cache (nuclear option).
   */
  async nukeCache(): Promise<CacheClearResult> {
    return this.fullPurgeResult(this.enqueueFullPurge().settled);
  }

  /**
   * A full purge for a caller that must not wait through its retries: a new
   * build, which holds its first request on the purge. `firstAnswer` is the
   * answer to the first request sent for it; `settled` is what nukeCache()
   * returns. They differ only when that request is refused and sent again.
   */
  nukeCacheWithFirstAnswer(): { firstAnswer: Promise<CacheClearResult>; settled: Promise<CacheClearResult> } {
    const { firstAnswer, settled } = this.enqueueFullPurge();
    return { firstAnswer: this.fullPurgeResult(firstAnswer), settled: this.fullPurgeResult(settled) };
  }

  private enqueueFullPurge(): { firstAnswer: Promise<PurgeOutcome>; settled: Promise<PurgeOutcome> } {
    // The request logs its own failure: several callers start a full purge without reading the result.
    return purgeQueueFor(this.baseUrl).enqueueFullPurge(
      this.request('the whole edge cache', this.baseUrl, FULL_PURGE_TIMEOUT_MS)
    );
  }

  private async fullPurgeResult(answer: Promise<PurgeOutcome>): Promise<CacheClearResult> {
    const startTime = Date.now();
    const outcome = await answer;
    const duration = Date.now() - startTime;

    if (outcome.ok) {
      edgeLog.debug(`Cleared entire edge cache in ${duration}ms`);
      return { success: true, statusCode: outcome.status, duration };
    }
    const error = outcome.status === undefined ? outcome.error : `HTTP ${outcome.status}: ${outcome.error}`;
    return { success: false, error, statusCode: outcome.status, duration };
  }

  /**
   * Clear specific paths from the edge cache (granular invalidation).
   * @param paths Array of paths to clear (e.g., ['/blogs/my-post', '/blogs'])
   */
  async clearPaths(paths: string[]): Promise<CacheClearResult> {
    if (paths.length === 0) {
      return { success: true, duration: 0, paths: [] };
    }

    const startTime = Date.now();

    // Each path once: `a` and `/a` are the same request (clearSinglePath adds the slash).
    const seen = new Set<unknown>();
    const unique = paths.filter((routePath) => {
      const key =
        typeof routePath === 'string' && routePath !== '' && !routePath.startsWith('/') ? `/${routePath}` : routePath;
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    });

    // Paths other purges still have waiting count too, or many purges just under the limit
    // would add up to the flood the limit is there to stop.
    // Paths already queued are not counted again: their purge is shared, not repeated.
    const maxPaths = resolvePurgeMaxPaths();
    const queue = purgeQueueFor(this.baseUrl);
    const alreadyWaiting = queue.waitingPaths;
    const added = queue.newPaths(
      unique.filter((routePath) => isSendable(routePath, MAX_PATH_LENGTH)).map(withLeadingSlash)
    );
    if (added + alreadyWaiting > maxPaths) {
      edgeLog.warn(
        `One purge added ${added} paths` +
          (alreadyWaiting > 0 ? `, with ${alreadyWaiting} path purges already waiting` : '') +
          `, over CACHE_PURGE_MAX_PATHS (${maxPaths}): purging the whole edge cache instead`
      );
      return { ...(await this.nukeCache()), paths: [], fullPurge: true };
    }

    const cleared = await Promise.all(unique.map((routePath) => this.clearSinglePath(routePath)));
    const clearedPaths = unique.filter((_, index) => cleared[index]);
    const duration = Date.now() - startTime;

    edgeLog.debug(`Cleared ${clearedPaths.length}/${unique.length} paths in ${duration}ms`);

    return { success: clearedPaths.length > 0, duration, paths: clearedPaths };
  }

  /** Whether the path was purged. */
  private async clearSinglePath(routePath: string): Promise<boolean> {
    if (!isSendable(routePath, MAX_PATH_LENGTH)) {
      edgeLog.warn(`Not purging a malformed path (${String(routePath).length} characters)`);
      return false;
    }
    // Kept exactly, trailing slash included: with `trailingSlash` that is the URL the CDN caches.
    const normalizedPath = withLeadingSlash(routePath);
    const pathSegment = normalizedPath === '/' ? '/' : normalizedPath.substring(1);
    // Double-encode because the edge-cache-clearer expects URL-encoded values.
    const encodedPathSegment = encodeURIComponent(encodeURIComponent(pathSegment));
    const url = `${this.baseUrl}/paths/${encodedPathSegment}`;
    edgeLog.debug(`Clearing path from edge cache: ${routePath} (encoded: ${encodedPathSegment}, url: ${url})`);

    const outcome = await purgeQueueFor(this.baseUrl).enqueue(
      'path',
      normalizedPath,
      this.request(`path ${routePath}`, url, PATH_OR_KEY_TIMEOUT_MS)
    );
    return outcome.ok;
  }

  /**
   * Clear a single path from the edge cache.
   */
  async clearPath(routePath: string): Promise<CacheClearResult> {
    return this.clearPaths([routePath]);
  }

  /**
   * Clear paths in the background (non-blocking).
   */
  clearPathsInBackground(paths: string[], context: string): void {
    if (paths.length === 0) return;

    this.clearPaths(paths)
      .then((result) => {
        if (result.success) {
          const cleared = result.fullPurge ? 'whole edge cache' : `${result.paths?.length} paths`;
          edgeLog.debug(`Background path clear for ${context}: ${cleared} cleared`);
        } else {
          edgeLog.warn(
            `Background path clear failed for ${context}: ${result.error ?? 'no path cleared (see the warnings above)'}`
          );
        }
      })
      .catch((error) => {
        edgeLog.error(`Background path clear error for ${context}:`, error);
      });
  }

  /**
   * Clear a single path in the background (non-blocking).
   */
  clearPathInBackground(routePath: string, context: string): void {
    this.clearPathsInBackground([routePath], context);
  }

  /**
   * Clear cache entries by key/tag.
   * @param keys Array of cache keys/tags to clear
   */
  async clearKeys(keys: string[]): Promise<CacheClearResult> {
    if (keys.length === 0) {
      return { success: true, duration: 0, paths: [] };
    }

    const startTime = Date.now();
    const cleared = await Promise.all(keys.map((key) => this.clearSingleKey(key)));
    const clearedKeys = keys.filter((_, index) => cleared[index]);
    const duration = Date.now() - startTime;

    edgeLog.debug(`Cleared ${clearedKeys.length}/${keys.length} keys in ${duration}ms`);

    return { success: clearedKeys.length > 0, duration, paths: clearedKeys };
  }

  /** Whether the key was purged. */
  private async clearSingleKey(key: string): Promise<boolean> {
    if (!isSendable(key, MAX_KEY_LENGTH)) {
      edgeLog.warn(`Not purging a malformed key (${String(key).length} characters)`);
      return false;
    }
    // Double-encode because the edge-cache-clearer expects URL-encoded values.
    const url = `${this.baseUrl}/keys/${encodeURIComponent(encodeURIComponent(key))}`;

    const outcome = await purgeQueueFor(this.baseUrl).enqueue(
      'key',
      key,
      this.request(`key ${key}`, url, PATH_OR_KEY_TIMEOUT_MS)
    );
    return outcome.ok;
  }

  /**
   * Clear keys in the background (non-blocking).
   */
  clearKeysInBackground(keys: string[], context: string): void {
    if (keys.length === 0) return;

    this.clearKeys(keys)
      .then((result) => {
        if (result.success) {
          edgeLog.debug(`Background key clear for ${context}: ${result.paths?.length} keys cleared`);
        } else {
          edgeLog.warn(
            `Background key clear failed for ${context}: ${result.error ?? 'no key cleared (see the warnings above)'}`
          );
        }
      })
      .catch((error) => {
        edgeLog.error(`Background key clear error for ${context}:`, error);
      });
  }

  /**
   * Clear entire cache in the background (non-blocking).
   */
  nukeCacheInBackground(context: string): void {
    this.nukeCache()
      .then((result) => {
        if (result.success) {
          edgeLog.debug(`Background nuke successful for ${context} (${result.duration}ms)`);
        } else {
          edgeLog.warn(`Background nuke failed for ${context}: ${result.error}`);
        }
      })
      .catch((error) => {
        edgeLog.error(`Background nuke error for ${context}:`, error);
      });
  }
}

/**
 * Creates an EdgeCacheClear instance if the environment is configured.
 * Returns null if edge cache clearing is not available.
 * @internal
 */
export function createEdgeCacheClearer(): EdgeCacheClear | null {
  try {
    return new EdgeCacheClear();
  } catch {
    return null;
  }
}
