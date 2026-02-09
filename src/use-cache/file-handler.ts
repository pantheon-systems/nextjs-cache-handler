import * as fs from 'fs';
import * as path from 'path';
import type { UseCacheEntry, UseCacheHandler } from './types.js';
import {
  serializeUseCacheEntry,
  deserializeUseCacheEntry,
} from './stream-serialization.js';
import { createLogger } from '../utils/logger.js';

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
}

export default UseCacheFileHandler;
