import * as fs from 'fs';
import * as path from 'path';
import { promisify } from 'util';
import type {
  CacheEntryType,
  CacheStats,
  CacheEntryInfo,
  CacheHandlerValue,
  FileSystemCacheContext,
} from '../types.js';
import { BaseCacheHandler, type BuildMeta } from './base.js';
import { getStaticRoutes } from '../utils/static-routes.js';
import { TagsBuffer } from '../utils/tags-buffer.js';
import { createLogger } from '../utils/logger.js';
import { safeJoin } from '../utils/path-safety.js';
import { getTagsManifestRetentionMs, pruneTagsManifest, type TagsManifestRecord } from '../utils/tags-manifest-sync.js';

const fileLog = createLogger('FileCacheHandler');

const writeFile = promisify(fs.writeFile);
const readFile = promisify(fs.readFile);
const mkdir = promisify(fs.mkdir);
const rename = promisify(fs.rename);

/**
 * File-based cache handler for local development.
 * Stores cache entries in the .next/cache directory.
 */
export class FileCacheHandler extends BaseCacheHandler {
  private readonly baseDir: string;
  private readonly fetchCacheDir: string;
  private readonly routeCacheDir: string;
  private readonly imageCacheDir: string;
  private readonly buildMetaFile: string;
  private readonly tagsDir: string;
  private readonly tagsMapFile: string;
  private readonly tagsManifestFile: string;
  private readonly tagsBuffer: TagsBuffer;

  constructor(context: FileSystemCacheContext) {
    super(context, 'FileCacheHandler');

    this.baseDir = path.join(process.cwd(), '.next', 'cache');
    this.fetchCacheDir = path.join(this.baseDir, 'fetch-cache');
    this.routeCacheDir = path.join(this.baseDir, 'route-cache');
    this.imageCacheDir = path.join(this.baseDir, 'image-cache');
    // Store build-meta.json outside .next/ to survive Next.js cache clearing during builds
    this.buildMetaFile = path.join(process.cwd(), '.cache', 'build-meta.json');
    this.tagsDir = path.join(this.baseDir, 'tags');
    this.tagsMapFile = path.join(this.tagsDir, 'tags.json');
    this.tagsManifestFile = path.join(this.tagsDir, 'manifest.json');

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
      fs.mkdirSync(this.imageCacheDir, { recursive: true });
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
   * Read the shared tags-manifest snapshot (tag staleness, not tag -> keys --
   * see `updateTagsManifest`). Used by `BaseCacheHandler.maybeSyncTagsManifest()`
   * to fold another replica's `revalidateTag()` into this process's own
   * in-memory state.
   *
   * Always returns a record (never the "unchanged" null the GCS handler can
   * return): this handler backs single-instance/dev deployments where the file
   * is local, so there's no body-transfer cost worth optimising away.
   */
  protected async readTagsManifest(): Promise<TagsManifestRecord | null> {
    try {
      if (!fs.existsSync(this.tagsManifestFile)) {
        return {};
      }
      const data = await readFile(this.tagsManifestFile, 'utf-8');
      return JSON.parse(data);
    } catch (error) {
      this.log.warn('Error reading tags manifest:', error);
      return {};
    }
  }

  /**
   * Read-modify-write the shared tags-manifest. Called directly (not buffered)
   * from `revalidateTag()` -- see that method's own comment for why.
   *
   * Writes via a temp file + rename so a concurrent reader never observes a
   * half-written JSON document. The read-modify-write itself isn't guarded by
   * a lock the way the GCS handler's generation precondition guards its own:
   * this handler serves the single-instance/dev case, where there is no second
   * writer to race with.
   */
  protected async updateTagsManifest(mutate: (current: TagsManifestRecord) => TagsManifestRecord): Promise<void> {
    try {
      await mkdir(this.tagsDir, { recursive: true });

      const current = (await this.readTagsManifest()) ?? {};
      const { pruned, dropped } = pruneTagsManifest(mutate(current), getTagsManifestRetentionMs());
      if (dropped > 0) {
        this.log.debug(`Pruned ${dropped} tags-manifest entr${dropped === 1 ? 'y' : 'ies'} older than retention`);
      }

      const tmpFile = `${this.tagsManifestFile}.${process.pid}.tmp`;
      await writeFile(tmpFile, JSON.stringify(pruned, null, 2), 'utf-8');
      await rename(tmpFile, this.tagsManifestFile);
    } catch (error) {
      this.log.error('Error writing tags manifest:', error);
      throw error;
    }
  }

  /**
   * Override to use buffered updates instead of immediate writes.
   *
   * Queue-and-return, same as the GCS handler (see the comment on its
   * `updateTagsMapping`). Single-process anyway, and `readTagsMapping()`
   * flushes the buffer before reading, so a queued mapping is already visible
   * to this process's own `revalidateTag()`.
   */
  protected override updateTagsMapping(cacheKey: string, tags: string[], isDelete = false): Promise<void> {
    if (isDelete) {
      this.tagsBuffer.deleteKey(cacheKey);
    } else if (tags.length > 0) {
      this.tagsBuffer.addTags(cacheKey, tags);
    }
    this.log.debug(`Queued tags update for ${cacheKey} (pending: ${this.tagsBuffer.pendingCount})`);
    return Promise.resolve();
  }

  // ============================================================================
  // Cache entry implementation
  // ============================================================================

  private getCacheFilePath(cacheKey: string, cacheType: CacheEntryType): string {
    const safeKey = cacheKey.replace(/[^a-zA-Z0-9-]/g, '_');
    const dir =
      cacheType === 'fetch' ? this.fetchCacheDir : cacheType === 'image' ? this.imageCacheDir : this.routeCacheDir;
    // safeJoin guarantees the resolved path stays within the cache directory,
    // in addition to the character sanitization applied to the key above.
    return safeJoin(dir, `${safeKey}.json`);
  }

  protected async readCacheEntry(cacheKey: string, cacheType: CacheEntryType): Promise<CacheHandlerValue | null> {
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
    cacheType: CacheEntryType
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
  const imageCacheDir = path.join(process.cwd(), '.next', 'cache', 'image-cache');

  const keys: string[] = [];
  const entries: CacheEntryInfo[] = [];

  try {
    await processCacheDirectory(fetchCacheDir, 'fetch', keys, entries);
    await processCacheDirectory(routeCacheDir, 'route', keys, entries);
    await processCacheDirectory(imageCacheDir, 'image', keys, entries);

    fileLog.debug(
      `Found ${keys.length} cache entries ` +
        `(${keys.filter((k) => k.startsWith('fetch:')).length} fetch, ` +
        `${keys.filter((k) => k.startsWith('route:')).length} route, ` +
        `${keys.filter((k) => k.startsWith('image:')).length} image)`
    );

    return { size: keys.length, keys, entries };
  } catch (error) {
    fileLog.error('Error reading cache directories:', error);
    return { size: 0, keys: [], entries: [] };
  }
}

async function processCacheDirectory(
  dir: string,
  cacheType: CacheEntryType,
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
  cacheType: CacheEntryType,
  keys: string[],
  entries: CacheEntryInfo[]
): Promise<void> {
  const cacheKey = file.replace('.json', '').replace(/_/g, '-');
  const displayKey = `${cacheType}:${cacheKey}`;
  keys.push(displayKey);

  try {
    const filePath = safeJoin(dir, file);
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
  const imageCacheDir = path.join(process.cwd(), '.next', 'cache', 'image-cache');
  const tagsFilePath = path.join(process.cwd(), '.next', 'cache', 'tags', 'tags.json');
  const tagsManifestPath = path.join(process.cwd(), '.next', 'cache', 'tags', 'manifest.json');

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

    // Clear image cache (content-derived, no build/static-route scoping needed)
    clearedCount += await clearFetchCache(imageCacheDir);

    // Clear tags mapping and the shared tags-manifest (staleness state)
    await clearTagsMapping(tagsFilePath);
    await clearTagsMapping(tagsManifestPath);

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
      await fs.promises.unlink(safeJoin(dir, file));
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

      await fs.promises.unlink(safeJoin(dir, file));
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
