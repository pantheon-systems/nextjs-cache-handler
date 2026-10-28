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
  /** `i18n.defaultLocale` and each `i18n.domains` default: Next serves these pages without the prefix. */
  defaultLocales: string[];
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
  const defaultLocales = new Set<string>();
  try {
    const { config } = JSON.parse(fs.readFileSync(path.join(distDir, 'required-server-files.json'), 'utf-8'));
    basePath = typeof config?.basePath === 'string' ? config.basePath : '';
    trailingSlash = config?.trailingSlash === true;
    const i18n = config?.i18n;
    for (const locale of [
      i18n?.defaultLocale,
      ...(Array.isArray(i18n?.domains) ? i18n.domains : []).map((d: { defaultLocale?: unknown }) => d?.defaultLocale),
    ]) {
      if (typeof locale === 'string' && locale !== '') {
        defaultLocales.add(locale);
      }
    }
  } catch (error) {
    const assumed = 'assuming no basePath, trailingSlash or i18n default locales for CDN purge paths';
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      log.debug(`No required-server-files.json in ${distDir}; ${assumed}`);
    } else {
      log.warn(`Could not read required-server-files.json in ${distDir}; ${assumed}:`, error);
    }
  }

  let buildId: string | null = null;
  try {
    buildId = fs.readFileSync(path.join(distDir, 'BUILD_ID'), 'utf-8').trim() || null;
  } catch {
    // Pages Router data routes are then not purged
  }

  return { basePath, trailingSlash, buildId, defaultLocales: [...defaultLocales] };
}

/**
 * `urlPath` with the trailing slash Next serves it with: added under `trailingSlash`
 * unless the last segment has a `.` or the path is under `/.well-known`
 * (lib/load-custom-routes.ts), otherwise removed. A `?` or `#` is part of the path.
 */
export function withServedTrailingSlash(urlPath: string, trailingSlash: boolean): string {
  if (urlPath === '') {
    return urlPath;
  }
  const bare = urlPath.length > 1 && urlPath.endsWith('/') ? urlPath.slice(0, -1) : urlPath;
  const lastSegment = bare.slice(bare.lastIndexOf('/') + 1);
  if (trailingSlash && bare !== '/' && !lastSegment.includes('.') && !/^\/\.well-known(\/|$)/.test(bare)) {
    return `${bare}/`;
  }
  return bare;
}

/**
 * The path to purge for a URL a caller passes in: withServedTrailingSlash of its
 * pathname, without a query string or fragment. The CDN keys a page by its path
 * alone, and edge-cache-clearer would hash a query as part of the path, so it
 * would match nothing. Route paths from cache keys have no query, so a `?` or `#`
 * in them is part of the path and must not go through this.
 */
export function urlToPurgePath(url: string, trailingSlash: boolean): string {
  const suffixStart = url.search(/[?#]/);
  const pathname = suffixStart === -1 ? url : url.slice(0, suffixStart);
  return withServedTrailingSlash(pathname === '' && suffixStart !== -1 ? '/' : pathname, trailingSlash);
}

/**
 * The URL a route path is served at: with `basePath`, and with the slash
 * `trailingSlash` adds. Next adds it only when the last segment has no `.`,
 * and never under `/.well-known` (lib/load-custom-routes.ts).
 */
export function toPublicPath(routePath: string, config: SiteUrlConfig): string {
  const publicPath = withServedTrailingSlash(routePath, config.trailingSlash);

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
  // As Next's getAssetPathFromRoute: `/` -> `/index`, `/index/foo` -> `/index/index/foo`.
  const assetPath = routePath === '/' ? '/index' : /^\/index(\/|$)/.test(routePath) ? `/index${routePath}` : routePath;
  return `${config.basePath}/_next/data/${config.buildId}${assetPath}.json`;
}

/**
 * The path a Pages Router route path under a default locale is also served at,
 * without the locale prefix (`/en/blog` -> `/blog`, `/en` -> `/`), or null.
 * Next keys such pages with the locale but serves the default locale unprefixed.
 */
export function withoutDefaultLocale(routePath: string, config: SiteUrlConfig): string | null {
  const [, locale, ...rest] = routePath.split('/');
  if (!locale || !config.defaultLocales.includes(locale)) {
    return null;
  }
  return `/${rest.join('/')}`;
}
