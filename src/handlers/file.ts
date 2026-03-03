import * as fs from 'fs';
import * as path from 'path';
import { promisify } from 'util';
import type { CacheStats, CacheEntryInfo, CacheHandlerValue, FileSystemCacheContext } from '../types.js';
import { BaseCacheHandler, type BuildMeta } from './base.js';
import { getStaticRoutes } from '../utils/static-routes.js';
import { TagsBuffer } from '../utils/tags-buffer.js';
import { createLogger } from '../utils/logger.js';

const fileLog = createLogger('FileCacheHandler');

const writeFile = promisify(fs.writeFile);
const readFile = promisify(fs.readFile);
const mkdir = promisify(fs.mkdir);

/**
 * File-based cache handler for local development.
 * Stores cache entries in the .next/cache directory.
 */
export class FileCacheHandler extends BaseCacheHandler {
  private readonly baseDir: string;
  private readonly fetchCacheDir: string;
  private readonly routeCacheDir: string;
  private readonly buildMetaFile: string;
  private readonly tagsDir: string;
  private readonly tagsMapFile: string;
  private readonly tagsBuffer: TagsBuffer;

  constructor(context: FileSystemCacheContext) {
    super(context, 'FileCacheHandler');

    this.baseDir = path.join(process.cwd(), '.next', 'cache');
    this.fetchCacheDir = path.join(this.baseDir, 'fetch-cache');
    this.routeCacheDir = path.join(this.baseDir, 'route-cache');
    // Store build-meta.json outside .next/ to survive Next.js cache clearing during builds
    this.buildMetaFile = path.join(process.cwd(), '.cache', 'build-meta.json');
    this.tagsDir = path.join(this.baseDir, 'tags');
    this.tagsMapFile = path.join(this.tagsDir, 'tags.json');

    // Create tags buffer for batched writes (improves performance)
    this.tagsBuffer = new TagsBuffer({
      flushIntervalMs: 100, // File system can handle faster flushes than GCS
      readTagsMapping: () => Promise.resolve(this.readTagsMappingDirect()),
      writeTagsMapping: (mapping) => {
        this.writeTagsMappingDirect(mapping);
        return Promise.resolve();
      },
      handlerName: 'FileCacheHandler',
    });

    this.ensureCacheDir();
    // Initialize asynchronously (don't await to avoid blocking constructor)
    this.initialize().catch(() => {});
  }

  private ensureCacheDir(): void {
    try {
      fs.mkdirSync(this.fetchCacheDir, { recursive: true });
      fs.mkdirSync(this.routeCacheDir, { recursive: true });
      fs.mkdirSync(this.tagsDir, { recursive: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        this.log.error('Error creating cache directories:', error);
      }
    }
  }

  // ============================================================================
  // Tags mapping implementation (buffered for improved performance)
  // ============================================================================

  protected async initializeTagsMapping(): Promise<void> {
    try {
      if (!fs.existsSync(this.tagsMapFile)) {
        fs.writeFileSync(this.tagsMapFile, JSON.stringify({}, null, 2), 'utf-8');
      }
    } catch {
      // Silently fail - tags mapping will be created on first write
    }
  }

  /**
   * Read tags mapping, flushing any pending updates first to ensure accuracy.
   */
  protected async readTagsMapping(): Promise<Record<string, string[]>> {
    // Flush pending updates before reading to ensure we have accurate data
    await this.tagsBuffer.flush();
    return this.readTagsMappingDirect();
  }

  /**
   * Direct read from file system without flushing buffer.
   * Used internally by the buffer.
   */
  private readTagsMappingDirect(): Record<string, string[]> {
    try {
      if (!fs.existsSync(this.tagsMapFile)) {
        return {};
      }
      const data = fs.readFileSync(this.tagsMapFile, 'utf-8');
      return JSON.parse(data);
    } catch (error) {
      this.log.warn('Error reading tags mapping:', error);
      return {};
    }
  }

  /**
   * Write tags mapping directly to file system.
   * Used by the buffer for batched writes.
   */
  protected async writeTagsMapping(tagsMapping: Record<string, string[]>): Promise<void> {
    this.writeTagsMappingDirect(tagsMapping);
  }

  /**
   * Direct write to file system (sync).
   * Used internally by the buffer.
   */
  private writeTagsMappingDirect(tagsMapping: Record<string, string[]>): void {
    try {
      fs.writeFileSync(this.tagsMapFile, JSON.stringify(tagsMapping, null, 2), 'utf-8');
    } catch (error) {
      this.log.error('Error writing tags mapping:', error);
      throw error; // Re-throw so buffer can retry
    }
  }

  /**
   * Override to use buffered updates instead of immediate writes.
   */
  protected override async updateTagsMapping(cacheKey: string, tags: string[], isDelete = false): Promise<void> {
    if (isDelete) {
      this.tagsBuffer.deleteKey(cacheKey);
    } else if (tags.length > 0) {
      this.tagsBuffer.addTags(cacheKey, tags);
    }
    // Updates are queued and will be flushed automatically
    this.log.debug(`Queued tags update for ${cacheKey} (pending: ${this.tagsBuffer.pendingCount})`);
  }

  /**
   * Override to use buffered deletes instead of immediate writes.
   */
  protected override async updateTagsMappingBulkDelete(
    cacheKeysToDelete: string[],
    _tagsMapping: Record<string, string[]>
  ): Promise<void> {
    this.tagsBuffer.deleteKeys(cacheKeysToDelete);
    // Force flush after bulk delete to ensure consistency for revalidation
    await this.tagsBuffer.flush();
  }

  // ============================================================================
  // Cache entry implementation
  // ============================================================================

  private getCacheFilePath(cacheKey: string, cacheType: 'fetch' | 'route'): string {
    const safeKey = cacheKey.replace(/[^a-zA-Z0-9-]/g, '_');
    const dir = cacheType === 'fetch' ? this.fetchCacheDir : this.routeCacheDir;
    return path.join(dir, `${safeKey}.json`);
  }

  protected async readCacheEntry(cacheKey: string, cacheType: 'fetch' | 'route'): Promise<CacheHandlerValue | null> {
    try {
      const filePath = this.getCacheFilePath(cacheKey, cacheType);
      const data = await readFile(filePath, 'utf-8');
      const parsedData = JSON.parse(data);
      return (this.deserializeFromStorage({ [cacheKey]: parsedData })[cacheKey] as CacheHandlerValue) || null;
    } catch {
      return null;
    }
  }

  protected async writeCacheEntry(
    cacheKey: string,
    cacheValue: CacheHandlerValue,
    cacheType: 'fetch' | 'route'
  ): Promise<void> {
    try {
      this.ensureCacheDir();
      const filePath = this.getCacheFilePath(cacheKey, cacheType);
      const serializedData = this.serializeForStorage({ [cacheKey]: cacheValue });
      await writeFile(filePath, JSON.stringify(serializedData[cacheKey], null, 2), 'utf-8');
    } catch (error) {
      this.log.error(`Error writing cache entry ${cacheKey}:`, error);
    }
  }

  protected async deleteCacheEntry(cacheKey: string, cacheType: 'fetch' | 'route'): Promise<void> {
    try {
      const filePath = this.getCacheFilePath(cacheKey, cacheType);
      await fs.promises.unlink(filePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.log.error(`Error deleting cache entry ${cacheKey}:`, error);
      }
      throw error;
    }
  }

  // ============================================================================
  // Build meta implementation
  // ============================================================================

  protected async readBuildMeta(): Promise<BuildMeta> {
    const data = await readFile(this.buildMetaFile, 'utf-8');
    return JSON.parse(data);
  }

  protected async writeBuildMeta(meta: BuildMeta): Promise<void> {
    const buildMetaDir = path.dirname(this.buildMetaFile);
    await mkdir(buildMetaDir, { recursive: true });
    await writeFile(this.buildMetaFile, JSON.stringify(meta), 'utf-8');
  }

  protected async invalidateRouteCache(): Promise<void> {
    try {
      await fs.promises.rm(this.routeCacheDir, { recursive: true, force: true });
      await fs.promises.mkdir(this.routeCacheDir, { recursive: true });
    } catch {
      // Directory might not exist or can't be created - not critical
    }
  }
}

// ============================================================================
// Standalone functions for API usage
// ============================================================================

/**
 * Get cache statistics for the file-based cache.
 */
export async function getSharedCacheStats(): Promise<CacheStats> {
  const fetchCacheDir = path.join(process.cwd(), '.next', 'cache', 'fetch-cache');
  const routeCacheDir = path.join(process.cwd(), '.next', 'cache', 'route-cache');

  const keys: string[] = [];
  const entries: CacheEntryInfo[] = [];

  try {
    await processCacheDirectory(fetchCacheDir, 'fetch', keys, entries);
    await processCacheDirectory(routeCacheDir, 'route', keys, entries);

    fileLog.debug(
      `Found ${keys.length} cache entries ` +
        `(${keys.filter((k) => k.startsWith('fetch:')).length} fetch, ` +
        `${keys.filter((k) => k.startsWith('route:')).length} route)`
    );

    return { size: keys.length, keys, entries };
  } catch (error) {
    fileLog.error('Error reading cache directories:', error);
    return { size: 0, keys: [], entries: [] };
  }
}

async function processCacheDirectory(
  dir: string,
  cacheType: 'fetch' | 'route',
  keys: string[],
  entries: CacheEntryInfo[]
): Promise<void> {
  try {
    const files = await fs.promises.readdir(dir);
    const jsonFiles = files.filter((file) => file.endsWith('.json'));

    for (const file of jsonFiles) {
      await processJsonCacheFile(dir, file, cacheType, keys, entries);
    }
  } catch {
    // Directory might not exist
  }
}

async function processJsonCacheFile(
  dir: string,
  file: string,
  cacheType: 'fetch' | 'route',
  keys: string[],
  entries: CacheEntryInfo[]
): Promise<void> {
  const cacheKey = file.replace('.json', '').replace(/_/g, '-');
  const displayKey = `${cacheType}:${cacheKey}`;
  keys.push(displayKey);

  try {
    const filePath = path.join(dir, file);
    const data = await fs.promises.readFile(filePath, 'utf-8');
    const cacheData = JSON.parse(data);

    entries.push({
      key: displayKey,
      tags: cacheData.tags || [],
      lastModified: cacheData.lastModified || Date.now(),
      type: cacheType,
    });
  } catch {
    entries.push({
      key: displayKey,
      tags: [],
      type: cacheType,
    });
  }
}

/**
 * Clear all cache entries for the file-based cache.
 */
export async function clearSharedCache(): Promise<number> {
  const fetchCacheDir = path.join(process.cwd(), '.next', 'cache', 'fetch-cache');
  const routeCacheDir = path.join(process.cwd(), '.next', 'cache', 'route-cache');
  const tagsFilePath = path.join(process.cwd(), '.next', 'cache', 'tags', 'tags.json');

  const staticRoutes = getStaticRoutes();
  let clearedCount = 0;
  let preservedCount = 0;

  try {
    // Clear fetch cache (data cache - always clearable)
    clearedCount += await clearFetchCache(fetchCacheDir);

    // Clear route cache (skip static routes)
    const routeResult = await clearRouteCache(routeCacheDir, staticRoutes);
    clearedCount += routeResult.cleared;
    preservedCount = routeResult.preserved;

    // Clear tags mapping
    await clearTagsMapping(tagsFilePath);

    fileLog.info(`Total cleared: ${clearedCount} cache entries`);
    return clearedCount;
  } catch (error) {
    fileLog.error('Error clearing cache directories:', error);
    return 0;
  }
}

async function clearFetchCache(dir: string): Promise<number> {
  try {
    const files = await fs.promises.readdir(dir);
    const jsonFiles = files.filter((file) => file.endsWith('.json'));

    for (const file of jsonFiles) {
      await fs.promises.unlink(path.join(dir, file));
    }

    fileLog.debug(`Cleared ${jsonFiles.length} fetch cache entries`);
    return jsonFiles.length;
  } catch {
    return 0;
  }
}

async function clearRouteCache(
  dir: string,
  staticRoutes: Set<string>
): Promise<{ cleared: number; preserved: number }> {
  let cleared = 0;
  let preserved = 0;

  try {
    const files = await fs.promises.readdir(dir);
    const jsonFiles = files.filter((file) => file.endsWith('.json'));

    for (const file of jsonFiles) {
      const cacheKey = file.replace('.json', '');

      if (staticRoutes.has(cacheKey)) {
        preserved++;
        continue;
      }

      await fs.promises.unlink(path.join(dir, file));
      cleared++;
    }

    fileLog.debug(`Route cache: cleared ${cleared}, preserved ${preserved} static routes`);
  } catch {
    // Directory might not exist
  }

  return { cleared, preserved };
}

async function clearTagsMapping(tagsFilePath: string): Promise<void> {
  try {
    const exists = await fs.promises
      .access(tagsFilePath)
      .then(() => true)
      .catch(() => false);
    if (exists) {
      await fs.promises.unlink(tagsFilePath);
    }
  } catch {
    // Ignore errors
  }
}

export default FileCacheHandler;
