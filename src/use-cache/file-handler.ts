import * as fs from 'fs';
import * as path from 'path';
import type { UseCacheEntry, UseCacheHandler, UseCacheStats, UseCacheEntryInfo } from './types.js';
import {
  serializeUseCacheEntry,
  deserializeUseCacheEntry,
} from './stream-serialization.js';
import { createLogger } from '../utils/logger.js';
import { RequestContext } from '../utils/request-context.js';

const log = createLogger('UseCacheFileHandler');

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

  constructor(config: UseCacheFileHandlerConfig = {}) {
    this.cacheDir = config.cacheDir ?? path.join(process.cwd(), '.next', 'cache', 'use-cache');
    this.tagsFile = path.join(this.cacheDir, '_tags.json');

    this.ensureCacheDir();
    this.loadTagTimestamps();

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
      const storedTagsLength = entry.tags?.length ?? 0;
      const contextActive = RequestContext.isActive();

      if (storedTagsLength > 0 && contextActive) {
        RequestContext.addTags(entry.tags);
        log.debug(`Captured ${storedTagsLength} tags for Surrogate-Key: ${entry.tags.join(', ')}`);
      } else {
        // TODO: Remove this diagnostic logging once Next.js fixes the empty tags bug
        // See: https://github.com/vercel/next.js/issues/78864
        // Log why tags weren't propagated
        log.info(`GET ${cacheKey} - Tag propagation status:`, {
          storedTags: entry.tags,
          storedTagsLength,
          requestContextActive: contextActive,
          reason: storedTagsLength === 0
            ? 'No tags stored (Next.js empty tags bug)'
            : 'RequestContext not active'
        });
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
   * Invalidate cache entries with matching tags.
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
