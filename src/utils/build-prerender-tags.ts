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

const cache = new Map<string, Promise<BuildPrerenderTags>>();

/**
 * Tags of the routes prerendered at build, read once per process from the
 * build output. Build prerenders are served from disk (see
 * BaseCacheHandler.getBuildPrerender) and never pass through set(), so the
 * shared tags map has no keys for them until they regenerate. Every instance
 * ships the same build output, so this needs no shared storage.
 */
export function loadBuildPrerenderTags(serverDistDir: string | undefined): Promise<BuildPrerenderTags> {
  if (!serverDistDir) {
    return Promise.resolve({});
  }
  let promise = cache.get(serverDistDir);
  if (!promise) {
    promise = readBuildPrerenderTags(serverDistDir).catch((error) => {
      log.warn('Could not read build prerender tags:', error);
      return {};
    });
    cache.set(serverDistDir, promise);
  }
  return promise;
}

/** @internal Test hook. */
export function resetBuildPrerenderTagsForTests(): void {
  cache.clear();
}

async function readBuildPrerenderTags(serverDistDir: string): Promise<BuildPrerenderTags> {
  const manifestPath = path.join(serverDistDir, '..', 'prerender-manifest.json');
  let manifest: PrerenderManifest;
  try {
    manifest = JSON.parse(await fs.promises.readFile(manifestPath, 'utf-8'));
  } catch {
    log.debug(`No prerender manifest at ${manifestPath}`);
    return {};
  }

  const appDir = path.join(serverDistDir, 'app');
  const cacheKeys = Object.keys(manifest.routes ?? {}).map(toCacheKey);
  const tagsByKey: [string, string[]][] = [];

  for (let i = 0; i < cacheKeys.length; i += READ_BATCH_SIZE) {
    const batch = cacheKeys.slice(i, i + READ_BATCH_SIZE);
    const results = await Promise.all(batch.map((key) => readMetaTags(appDir, key)));
    batch.forEach((key, j) => tagsByKey.push([key, results[j]]));
  }

  const mapping: BuildPrerenderTags = {};
  for (const [key, tags] of tagsByKey) {
    for (const tag of tags) {
      (mapping[tag] ??= []).push(key);
    }
  }
  log.debug(`Indexed ${Object.keys(mapping).length} tags across ${cacheKeys.length} build prerenders`);
  return mapping;
}

/** Next's normalizePagePath, which IncrementalCache applies to route keys. */
function toCacheKey(route: string): string {
  if (route === '/') {
    return '/index';
  }
  return /^\/index(\/|$)/.test(route) && !isDynamicRoutePath(route) ? `/index${route}` : route;
}

// App Router pages and route handlers only: Pages Router `.meta` files carry no tags.
async function readMetaTags(appDir: string, cacheKey: string): Promise<string[]> {
  const metaPath = path.join(appDir, `${cacheKey}.meta`);
  if (!metaPath.startsWith(appDir + path.sep)) {
    return [];
  }
  try {
    const meta = JSON.parse(await fs.promises.readFile(metaPath, 'utf-8'));
    const header = meta?.headers?.['x-next-cache-tags'];
    return typeof header === 'string' && header ? header.split(',') : [];
  } catch {
    return [];
  }
}
