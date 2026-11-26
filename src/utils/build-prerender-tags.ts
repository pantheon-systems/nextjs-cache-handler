import * as fs from 'fs';
import * as path from 'path';
import { createLogger } from './logger.js';
import { isDynamicRoutePath } from './route-paths.js';

const log = createLogger('BuildPrerenderTags');

/** tag -> route cache keys, for the routes prerendered at build. */
export type BuildPrerenderTags = Record<string, string[]>;

interface PrerenderManifest {
  routes?: Record<string, unknown>;
}

// Reads per batch, so a site with thousands of prerenders cannot hit EMFILE.
const READ_BATCH_SIZE = 64;

// A prerender's `.meta` is written next to its `.html`/`.body`, whose mtime
// Next uses as the entry's age; this allows for the gap between them.
const BUILT_AT_MARGIN_MS = 60_000;

// A file mtime older than this was normalized, not written by the build.
// Cloud Native Buildpacks set every mtime in an image to 1980-01-01 for
// reproducible builds. Next.js takes a build prerender's age from its mtime,
// so 16.4+ treats each one as past its `expire` (a year by default), re-renders
// it in the foreground and returns `x-nextjs-cache: REVALIDATED`, discarding
// the build-time output.
export const NORMALIZED_MTIME_BEFORE = Date.UTC(2000, 0, 1);

interface BuildPrerenderIndex {
  tags: BuildPrerenderTags;
  /** Lower bound on every App Router prerender's age as Next sees it, or null. */
  builtAt: number | null;
}

const cache = new Map<string, Promise<BuildPrerenderIndex>>();

/**
 * Tags of the routes prerendered at build, read once per process from the
 * build output. Build prerenders are served from disk (see
 * BaseCacheHandler.getBuildPrerender) and never pass through set(), so the
 * shared tags map has no keys for them until they regenerate. Every instance
 * ships the same build output, so this needs no shared storage.
 */
export async function loadBuildPrerenderTags(serverDistDir: string | undefined): Promise<BuildPrerenderTags> {
  return (await loadIndex(serverDistDir)).tags;
}

/**
 * When the build's App Router prerenders were written, as Next measures their
 * age (file mtime), minus a margin; null without prerenders. A revalidation
 * older than this cannot affect them.
 *
 * When the mtimes were normalized (see NORMALIZED_MTIME_BEFORE) they say
 * nothing about the build, and a 1980 time would keep every revalidation from
 * ever being pruned. `recordedAt`, when the build was first recorded (the time
 * BaseCacheHandler.getBuildPrerender dates the prerenders to), stands in.
 */
export async function loadBuildTime(serverDistDir: string | undefined, recordedAt: number): Promise<number | null> {
  const { builtAt } = await loadIndex(serverDistDir);
  if (builtAt === null) return null;
  return builtAt + BUILT_AT_MARGIN_MS < NORMALIZED_MTIME_BEFORE ? recordedAt - BUILT_AT_MARGIN_MS : builtAt;
}

function loadIndex(contextServerDistDir: string | undefined): Promise<BuildPrerenderIndex> {
  // Some handler instances get no serverDistDir (seen with a bundled copy on
  // Next 16.3.8); the standalone server runs from the directory holding `.next`.
  const serverDistDir = contextServerDistDir ?? path.join(process.cwd(), '.next', 'server');
  let promise = cache.get(serverDistDir);
  if (!promise) {
    promise = readBuildPrerenderIndex(serverDistDir).catch((error) => {
      log.warn('Could not read build prerender tags or build time:', error);
      return { tags: {}, builtAt: null };
    });
    cache.set(serverDistDir, promise);
  }
  return promise;
}

/** @internal Test hook. */
export function resetBuildPrerenderTagsForTests(): void {
  cache.clear();
}

async function readBuildPrerenderIndex(serverDistDir: string): Promise<BuildPrerenderIndex> {
  const manifestPath = path.join(serverDistDir, '..', 'prerender-manifest.json');
  let manifest: PrerenderManifest;
  try {
    manifest = JSON.parse(await fs.promises.readFile(manifestPath, 'utf-8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      log.warn(
        `Could not read ${manifestPath}; build prerenders are not purged by tag, and revalidations are not ` +
          `pruned at the next deploy:`,
        error
      );
    } else {
      log.debug(`No prerender manifest at ${manifestPath}`);
    }
    return { tags: {}, builtAt: null };
  }

  const appDir = path.join(serverDistDir, 'app');
  const cacheKeys = Object.keys(manifest.routes ?? {}).map(toCacheKey);
  const tagsByKey: [string, string[]][] = [];
  let oldest = Infinity;

  for (let i = 0; i < cacheKeys.length; i += READ_BATCH_SIZE) {
    const batch = cacheKeys.slice(i, i + READ_BATCH_SIZE);
    const results = await Promise.all(batch.map((key) => readMeta(appDir, key)));
    batch.forEach((key, j) => {
      tagsByKey.push([key, results[j].tags]);
      oldest = Math.min(oldest, results[j].mtimeMs);
    });
  }

  const mapping: BuildPrerenderTags = {};
  for (const [key, tags] of tagsByKey) {
    for (const tag of tags) {
      (mapping[tag] ??= []).push(key);
    }
  }
  log.debug(`Indexed ${Object.keys(mapping).length} tags across ${cacheKeys.length} build prerenders`);
  return { tags: mapping, builtAt: Number.isFinite(oldest) ? oldest - BUILT_AT_MARGIN_MS : null };
}

/** Next's normalizePagePath, which IncrementalCache applies to route keys. */
function toCacheKey(route: string): string {
  if (route === '/') {
    return '/index';
  }
  return /^\/index(\/|$)/.test(route) && !isDynamicRoutePath(route) ? `/index${route}` : route;
}

// App Router pages and route handlers only: Pages Router `.meta` files carry no tags.
async function readMeta(appDir: string, cacheKey: string): Promise<{ tags: string[]; mtimeMs: number }> {
  const metaPath = path.join(appDir, `${cacheKey}.meta`);
  if (!metaPath.startsWith(appDir + path.sep)) {
    return { tags: [], mtimeMs: Infinity };
  }
  try {
    const [data, stat] = await Promise.all([fs.promises.readFile(metaPath, 'utf-8'), fs.promises.stat(metaPath)]);
    const header = JSON.parse(data)?.headers?.['x-next-cache-tags'];
    return { tags: typeof header === 'string' && header ? header.split(',') : [], mtimeMs: stat.mtimeMs };
  } catch {
    return { tags: [], mtimeMs: Infinity };
  }
}
