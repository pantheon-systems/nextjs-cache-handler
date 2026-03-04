import { createLogger } from '../utils/logger.js';

const edgeLog = createLogger('EdgeCacheClear');

/**
 * Result of a cache clear operation.
 */
export interface CacheClearResult {
  success: boolean;
  error?: string;
  statusCode?: number;
  duration?: number;
  paths?: string[];
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

  /**
   * Clear the entire edge cache (nuclear option).
   */
  async nukeCache(): Promise<CacheClearResult> {
    const startTime = Date.now();

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10000);

      const response = await fetch(this.baseUrl, {
        method: 'DELETE',
        headers: {
          'Content-Type': 'application/json',
        },
        signal: controller.signal,
      });

      clearTimeout(timeoutId);
      const duration = Date.now() - startTime;

      if (!response.ok) {
        const errorText = await response.text().catch(() => 'Unknown error');
        return {
          success: false,
          error: `HTTP ${response.status}: ${errorText}`,
          statusCode: response.status,
          duration,
        };
      }

      edgeLog.debug(`Cleared entire edge cache in ${duration}ms`);
      return { success: true, statusCode: response.status, duration };
    } catch (error) {
      const duration = Date.now() - startTime;
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      return { success: false, error: errorMessage, duration };
    }
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
    const results: { path: string; success: boolean }[] = [];

    try {
      const clearPromises = paths.map((routePath) => this.clearSinglePath(routePath, results));
      await Promise.all(clearPromises);

      const duration = Date.now() - startTime;
      const successCount = results.filter((r) => r.success).length;
      const clearedPaths = results.filter((r) => r.success).map((r) => r.path);

      edgeLog.debug(`Cleared ${successCount}/${paths.length} paths in ${duration}ms`);

      return {
        success: successCount > 0,
        duration,
        paths: clearedPaths,
      };
    } catch (error) {
      const duration = Date.now() - startTime;
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      return { success: false, error: errorMessage, duration, paths: [] };
    }
  }

  private async clearSinglePath(routePath: string, results: { path: string; success: boolean }[]): Promise<void> {
    try {
      const normalizedPath = routePath.startsWith('/') ? routePath : `/${routePath}`;
      const cleanPath = normalizedPath.replace(/\/$/, '') || '/';
      const pathSegment = cleanPath === '/' ? '/' : cleanPath.substring(1);
      // Double-encode because the edge-cache-clearer expects URL-encoded values.
      const encodedPathSegment = encodeURIComponent(encodeURIComponent(pathSegment));
      const url = `${this.baseUrl}/paths/${encodedPathSegment}`;
      edgeLog.debug(`Clearing path from edge cache: ${routePath} (encoded: ${encodedPathSegment}, url: ${url})`);

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000);

      const response = await fetch(url, {
        method: 'DELETE',
        headers: {
          'Content-Type': 'application/json',
        },
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (response.ok) {
        results.push({ path: routePath, success: true });
      } else {
        edgeLog.warn(`Failed to clear path ${routePath}: HTTP ${response.status}`);
        results.push({ path: routePath, success: false });
      }
    } catch (error) {
      edgeLog.warn(`Error clearing path ${routePath}:`, error);
      results.push({ path: routePath, success: false });
    }
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
          edgeLog.debug(`Background path clear for ${context}: ${result.paths?.length} paths cleared`);
        } else {
          edgeLog.warn(`Background path clear failed for ${context}: ${result.error}`);
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
    const results: { key: string; success: boolean }[] = [];

    try {
      const clearPromises = keys.map((key) => this.clearSingleKey(key, results));
      await Promise.all(clearPromises);

      const duration = Date.now() - startTime;
      const successCount = results.filter((r) => r.success).length;
      const clearedKeys = results.filter((r) => r.success).map((r) => r.key);

      edgeLog.debug(`Cleared ${successCount}/${keys.length} keys in ${duration}ms`);

      return {
        success: successCount > 0,
        duration,
        paths: clearedKeys,
      };
    } catch (error) {
      const duration = Date.now() - startTime;
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      return { success: false, error: errorMessage, duration, paths: [] };
    }
  }

  private async clearSingleKey(key: string, results: { key: string; success: boolean }[]): Promise<void> {
    try {
      // Double-encode because the edge-cache-clearer expects URL-encoded values.
      const url = `${this.baseUrl}/keys/${encodeURIComponent(encodeURIComponent(key))}`;

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000);

      const response = await fetch(url, {
        method: 'DELETE',
        headers: {
          'Content-Type': 'application/json',
        },
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (response.ok) {
        results.push({ key, success: true });
      } else {
        edgeLog.warn(`Failed to clear key ${key}: HTTP ${response.status}`);
        results.push({ key, success: false });
      }
    } catch (error) {
      edgeLog.warn(`Error clearing key ${key}:`, error);
      results.push({ key, success: false });
    }
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
          edgeLog.warn(`Background key clear failed for ${context}: ${result.error}`);
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
