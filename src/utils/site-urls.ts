import * as fs from 'fs';
import * as path from 'path';
import { createLogger } from './logger.js';

const log = createLogger('SiteUrls');

/** The parts of the build that decide which URL the CDN caches a page under. */
export interface SiteUrlConfig {
  basePath: string;
  trailingSlash: boolean;
  /** For Pages Router data routes (`/_next/data/<buildId>/...`). */
  buildId: string | null;
}

const cache = new Map<string, SiteUrlConfig>();

/**
 * Read once per process from the build output beside `serverDistDir`
 * (`required-server-files.json` and `BUILD_ID`, both in the standalone output).
 */
export function loadSiteUrlConfig(serverDistDir: string | undefined): SiteUrlConfig {
  const distDir = serverDistDir ? path.join(serverDistDir, '..') : path.join(process.cwd(), '.next');
  let config = cache.get(distDir);
  if (!config) {
    config = readSiteUrlConfig(distDir);
    cache.set(distDir, config);
  }
  return config;
}

/** @internal Test hook. */
export function resetSiteUrlConfigForTests(): void {
  cache.clear();
}

function readSiteUrlConfig(distDir: string): SiteUrlConfig {
  let basePath = '';
  let trailingSlash = false;
  try {
    const { config } = JSON.parse(fs.readFileSync(path.join(distDir, 'required-server-files.json'), 'utf-8'));
    basePath = typeof config?.basePath === 'string' ? config.basePath : '';
    trailingSlash = config?.trailingSlash === true;
  } catch {
    log.debug(`No required-server-files.json in ${distDir}; assuming no basePath or trailingSlash`);
  }

  let buildId: string | null = null;
  try {
    buildId = fs.readFileSync(path.join(distDir, 'BUILD_ID'), 'utf-8').trim() || null;
  } catch {
    // Pages Router data routes are then not purged
  }

  return { basePath, trailingSlash, buildId };
}

/**
 * The URL a route path is served at: with `basePath`, and with the slash
 * `trailingSlash` adds. Next adds it only when the last segment has no `.`,
 * and never under `/.well-known` (lib/load-custom-routes.ts).
 */
export function toPublicPath(routePath: string, config: SiteUrlConfig): string {
  let publicPath = routePath;
  const lastSegment = publicPath.slice(publicPath.lastIndexOf('/') + 1);
  if (
    config.trailingSlash &&
    publicPath !== '/' &&
    !publicPath.endsWith('/') &&
    !lastSegment.includes('.') &&
    !/^\/\.well-known(\/|$)/.test(publicPath)
  ) {
    publicPath += '/';
  }

  if (!config.basePath) {
    return publicPath;
  }
  if (publicPath === '/') {
    return config.trailingSlash ? `${config.basePath}/` : config.basePath;
  }
  return `${config.basePath}${publicPath}`;
}

/** The Pages Router data route a page's client-side navigations fetch, or null without a build ID. */
export function pagesDataRoute(routePath: string, config: SiteUrlConfig): string | null {
  if (!config.buildId) {
    return null;
  }
  return `${config.basePath}/_next/data/${config.buildId}${routePath === '/' ? '/index' : routePath}.json`;
}
