import * as fs from 'fs';
import * as path from 'path';
import type { UseCacheEntry, UseCacheHandler, UseCacheStats, UseCacheEntryInfo } from './types.js';
import {
  serializeUseCacheEntry,
  deserializeUseCacheEntry,
} from './stream-serialization.js';
import { createLogger } from '../utils/logger.js';
import { createEdgeCacheClearer, type EdgeCacheClear } from '../edge/edge-cache-clear.js';

const log = createLogger('UseCacheFileHandler');

/**
 * Next.js internal prefix for path-based cache tags.
 */
const NEXTJS_PATH_TAG_PREFIX = '_N_T_';

/**
 * Symbol for path→surrogate-key registry on globalThis.
 */
const PATH_TAGS_REGISTRY_SYMBOL = Symbol.for('@nextjs-cache-handler/path-tags-registry');

/**
 * Symbol used to access CacheTagContext from globalThis.
 * This matches the Symbol.for pattern used by Next.js for @next/request-context.
 */
const CACHE_TAG_CONTEXT_SYMBOL = Symbol.for('@nextjs-cache-handler/tag-context');

interface CacheTagContextData {
  tags: string[];
  requestId: string;
  startTime: number;
}

interface CacheTagContextAccessor {
  get(): CacheTagContextData | undefined;
}

/**
 * Access the CacheTagContext via globalThis using Symbol.for.
 * This allows cross-context access without direct module imports.
 */
function getCacheTagContext(): CacheTagContextData | undefined {
  const accessor = (globalThis as Record<symbol, unknown>)[CACHE_TAG_CONTEXT_SYMBOL] as
    | CacheTagContextAccessor
    | undefined;
  return accessor?.get();
}

/**
 * Add tags to the CacheTagContext if available.
 * Falls back to global store if CacheTagContext is not active.
 */
function captureTags(tags: string[]): { captured: boolean; source: string } {
  if (tags.length === 0) {
    return { captured: false, source: 'none' };
  }

  // Primary: Try CacheTagContext (Symbol.for pattern)
  const context = getCacheTagContext();
  if (context) {
    context.tags.push(...tags);
    log.debug(`Captured ${tags.length} tags via CacheTagContext: ${tags.join(', ')}`);
    return { captured: true, source: 'CacheTagContext' };
  }

  // Fallback: Use global store (for environments where Symbol.for doesn't propagate)
  let globalTags = (globalThis as Record<string, unknown>).__pantheonSurrogateKeyTags as
    | string[]
    | undefined;
  if (!globalTags) {
    globalTags = [];
    (globalThis as Record<string, unknown>).__pantheonSurrogateKeyTags = globalTags;
  }
  globalTags.push(...tags);
  log.debug(`Captured ${tags.length} tags via globalStore fallback: ${tags.join(', ')}`);
  return { captured: true, source: 'globalStore' };
}

/**
 * Configuration for UseCacheFileHandler.
 */
export interface UseCacheFileHandlerConfig {
  /**
   * Directory to store cache files.
   * Defaults to .next/cache/use-cache
   */
  cacheDir?: string;
}

/**
 * File-based cache handler for Next.js 16 'use cache' directive.
 * Implements the cacheHandlers (plural) interface.
 *
 * Suitable for:
 * - Local development
 * - Single-instance deployments
 * - Testing
 */
export class UseCacheFileHandler implements UseCacheHandler {
  private readonly cacheDir: string;
  private readonly tagsFile: string;
  private tagTimestamps: Map<string, number> = new Map();
  private pathToSurrogateKeys: Map<string, string[]> = new Map();
  private readonly edgeCacheClearer: EdgeCacheClear | null;

  constructor(config: UseCacheFileHandlerConfig = {}) {
    this.cacheDir = config.cacheDir ?? path.join(process.cwd(), '.next', 'cache', 'use-cache');
    this.tagsFile = path.join(this.cacheDir, '_tags.json');

    this.ensureCacheDir();
    this.loadTagTimestamps();

    // Initialize edge cache clearer if OUTBOUND_PROXY_ENDPOINT is configured
    this.edgeCacheClearer = createEdgeCacheClearer();
    if (this.edgeCacheClearer) {
      log.debug('Edge cache clearing enabled');
    }

    // Expose registerPathTags on globalThis for withSurrogateKey integration
    (globalThis as Record<symbol, unknown>)[PATH_TAGS_REGISTRY_SYMBOL] =
      (p: string, t: string[]) => this.registerPathTags(p, t);

    log.debug('Initialized with cache dir:', this.cacheDir);
  }

  private ensureCacheDir(): void {
    try {
      fs.mkdirSync(this.cacheDir, { recursive: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        log.error('Error creating cache directory:', error);
      }
    }
  }

  private loadTagTimestamps(): void {
    try {
      if (fs.existsSync(this.tagsFile)) {
        const data = fs.readFileSync(this.tagsFile, 'utf-8');
        const parsed = JSON.parse(data);
        this.tagTimestamps = new Map(Object.entries(parsed));
      }
    } catch (error) {
      log.warn('Error loading tag timestamps:', error);
      this.tagTimestamps = new Map();
    }
  }

  private saveTagTimestamps(): void {
    try {
      const obj = Object.fromEntries(this.tagTimestamps);
      fs.writeFileSync(this.tagsFile, JSON.stringify(obj, null, 2), 'utf-8');
    } catch (error) {
      log.error('Error saving tag timestamps:', error);
    }
  }

  private getCacheFilePath(cacheKey: string): string {
    // Sanitize cache key for filesystem
    const safeKey = cacheKey.replace(/[^a-zA-Z0-9-]/g, '_');
    return path.join(this.cacheDir, `${safeKey}.json`);
  }

  /**
   * Check if an entry is expired based on revalidate time.
   */
  private isExpired(entry: UseCacheEntry): boolean {
    const now = Date.now();
    const age = now - entry.timestamp;
    const revalidateMs = entry.revalidate * 1000;

    // Entry is expired if it's older than revalidate time
    if (age > revalidateMs) {
      return true;
    }

    // Also check if any of the entry's tags have been invalidated
    for (const tag of entry.tags) {
      const tagTimestamp = this.tagTimestamps.get(tag);
      if (tagTimestamp && tagTimestamp > entry.timestamp) {
        return true;
      }
    }

    return false;
  }

  /**
   * Retrieve a cache entry.
   */
  async get(cacheKey: string, softTags: string[]): Promise<UseCacheEntry | undefined> {
    log.debug(`GET: ${cacheKey}`);

    try {
      const filePath = this.getCacheFilePath(cacheKey);

      if (!fs.existsSync(filePath)) {
        log.debug(`MISS: ${cacheKey} (not found)`);
        return undefined;
      }

      const data = fs.readFileSync(filePath, 'utf-8');
      const stored = JSON.parse(data);
      const entry = deserializeUseCacheEntry(stored);

      // Check expiration
      if (this.isExpired(entry)) {
        log.debug(`MISS: ${cacheKey} (expired)`);
        // Optionally delete expired entry
        try {
          fs.unlinkSync(filePath);
        } catch {
          // Ignore deletion errors
        }
        return undefined;
      }

      log.debug(`HIT: ${cacheKey}`);

      // Capture tags for Surrogate-Key header propagation
      // Uses Symbol.for pattern to access PantheonContext across async boundaries
      const storedTags = entry.tags ?? [];
      const { captured, source } = captureTags(storedTags);

      if (captured) {
        log.debug(`HIT ${cacheKey}: Captured ${storedTags.length} tags via ${source}`);
      } else if (storedTags.length === 0) {
        // TODO: Remove this diagnostic logging once Next.js fixes the empty tags bug
        // See: https://github.com/vercel/next.js/issues/78864
        log.info(`HIT ${cacheKey}: No tags to capture (Next.js empty tags bug)`);
      }

      return entry;
    } catch (error) {
      log.error(`Error reading cache for key ${cacheKey}:`, error);
      return undefined;
    }
  }

  /**
   * Store a cache entry.
   * CRITICAL: Must await pendingEntry before storing.
   */
  async set(cacheKey: string, pendingEntry: Promise<UseCacheEntry>): Promise<void> {
    log.debug(`SET: ${cacheKey}`);

    try {
      // CRITICAL: Await the pending entry
      const entry = await pendingEntry;

      // TODO: Remove this diagnostic logging once Next.js fixes the empty tags bug
      // Diagnostic logging for empty tags issue
      // See: https://github.com/vercel/next.js/issues/78864
      // See: docs/known-issues-nextjs16.md
      const tagsLength = entry.tags?.length ?? 0;
      if (tagsLength === 0) {
        // Use info level so this is gated behind CACHE_DEBUG
        log.info(`[EMPTY_TAGS_BUG] SET ${cacheKey}: Next.js passed empty tags array. ` +
          `This is a known Next.js bug - cacheTag() values are not propagated to cacheHandlers.set(). ` +
          `See: https://github.com/vercel/next.js/issues/78864`);
      }
      log.info(`SET entry structure for ${cacheKey}:`, {
        hasTags: !!entry.tags,
        tags: entry.tags,
        tagsLength,
        stale: entry.stale,
        revalidate: entry.revalidate,
        expire: entry.expire,
        timestamp: entry.timestamp,
        hasValue: !!entry.value,
        entryKeys: Object.keys(entry),
      });

      const serialized = await serializeUseCacheEntry(entry);
      const filePath = this.getCacheFilePath(cacheKey);

      fs.writeFileSync(filePath, JSON.stringify(serialized, null, 2), 'utf-8');

      log.debug(`Cached ${cacheKey}`);
    } catch (error) {
      log.error(`Error setting cache for key ${cacheKey}:`, error);
    }
  }

  /**
   * Synchronize tag state from external source.
   * For file-based handler, this reloads from disk.
   */
  async refreshTags(): Promise<void> {
    log.debug('REFRESH TAGS');
    this.loadTagTimestamps();
  }

  /**
   * Return maximum revalidation timestamp for given tags.
   */
  async getExpiration(tags: string[]): Promise<number> {
    let maxTimestamp = 0;

    for (const tag of tags) {
      const timestamp = this.tagTimestamps.get(tag) ?? 0;
      if (timestamp > maxTimestamp) {
        maxTimestamp = timestamp;
      }
    }

    log.debug(`GET EXPIRATION for [${tags.join(', ')}]: ${maxTimestamp}`);
    return maxTimestamp;
  }

  /**
   * Register the surrogate keys associated with a path.
   * Called by withSurrogateKey via globalThis Symbol.
   */
  registerPathTags(path: string, surrogateKeys: string[]): void {
    this.pathToSurrogateKeys.set(path, surrogateKeys);
    log.debug(`Registered path tags: ${path} → [${surrogateKeys.join(', ')}]`);
  }

  /**
   * Invalidate cache entries with matching tags.
   * Also triggers CDN edge cache clearing via Surrogate-Key if configured.
   */
  async updateTags(tags: string[], durations: number[]): Promise<void> {
    log.debug(`UPDATE TAGS: [${tags.join(', ')}]`);

    if (tags.length === 0) {
      return;
    }

    const now = Date.now();

    for (const tag of tags) {
      this.tagTimestamps.set(tag, now);
    }

    this.saveTagTimestamps();

    // Clear edge cache if configured
    if (this.edgeCacheClearer) {
      const explicitTags: string[] = [];
      const pathTags: string[] = [];

      for (const tag of tags) {
        if (tag.startsWith(NEXTJS_PATH_TAG_PREFIX)) {
          pathTags.push(tag);
        } else {
          explicitTags.push(tag);
        }
      }

      if (explicitTags.length > 0) {
        this.edgeCacheClearer.clearKeysInBackground(explicitTags, `use-cache tag invalidation: ${explicitTags.join(', ')}`);
      }

      if (pathTags.length > 0) {
        const resolvedKeys: string[] = [];
        const unresolvedPaths: string[] = [];

        for (const pathTag of pathTags) {
          const p = pathTag.substring(NEXTJS_PATH_TAG_PREFIX.length);
          const surrogateKeys = this.pathToSurrogateKeys.get(p);

          if (surrogateKeys && surrogateKeys.length > 0) {
            resolvedKeys.push(...surrogateKeys);
          } else {
            unresolvedPaths.push(p);
          }
        }

        if (resolvedKeys.length > 0) {
          this.edgeCacheClearer.clearKeysInBackground(resolvedKeys, `path revalidation (resolved): ${resolvedKeys.join(', ')}`);
        }

        if (unresolvedPaths.length > 0) {
          this.edgeCacheClearer.clearPathsInBackground(unresolvedPaths, `path revalidation (fallback): ${unresolvedPaths.join(', ')}`);
        }
      }
    }
  }

  /**
   * Get cache statistics for the use-cache entries.
   * Returns information about all valid (non-expired) cache entries.
   */
  async getStats(): Promise<UseCacheStats> {
    log.debug('GET STATS');

    const entries: UseCacheEntryInfo[] = [];
    const keys: string[] = [];

    try {
      if (!fs.existsSync(this.cacheDir)) {
        return { size: 0, entries: [], keys: [] };
      }

      const files = fs.readdirSync(this.cacheDir);

      for (const file of files) {
        // Skip tags file and non-JSON files
        if (file === '_tags.json' || !file.endsWith('.json')) {
          continue;
        }

        try {
          const filePath = path.join(this.cacheDir, file);
          const data = fs.readFileSync(filePath, 'utf-8');
          const stored = JSON.parse(data);

          // Reconstruct the key from the filename (reverse of sanitization)
          const key = file.replace('.json', '');

          // Deserialize to check expiration
          const entry = deserializeUseCacheEntry(stored);

          // Skip expired entries
          if (this.isExpired(entry)) {
            continue;
          }

          // Get file stats for size
          const fileStat = fs.statSync(filePath);

          const entryInfo: UseCacheEntryInfo = {
            key,
            tags: stored.tags || [],
            type: 'use-cache',
            lastModified: new Date(entry.timestamp).toISOString(),
            size: fileStat.size,
            revalidate: entry.revalidate,
            stale: entry.stale,
            expire: entry.expire,
          };

          entries.push(entryInfo);
          keys.push(key);
        } catch (error) {
          log.warn(`Error reading cache file ${file}:`, error);
        }
      }
    } catch (error) {
      log.error('Error getting cache stats:', error);
    }

    log.debug(`Found ${entries.length} valid cache entries`);

    return {
      size: entries.length,
      entries,
      keys,
    };
  }
}

export default UseCacheFileHandler;
