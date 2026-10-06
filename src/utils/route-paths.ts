/**
 * Maps cache keys and Next.js implicit tags to the URL paths the CDN caches
 * them under, for edge-cache path purges.
 */

const IMPLICIT_TAG_PREFIX = '_N_T_';

// A `[param]` segment: a route pattern (partial-fallback shell), not a URL.
const DYNAMIC_SEGMENT = /\[[^/]+\]/;

export function isDynamicRoutePath(routePath: string): boolean {
  return DYNAMIC_SEGMENT.test(routePath);
}

/**
 * Inverse of Next's normalizePagePath, which IncrementalCache applies to every
 * route key: `/index` -> `/`, `/index/foo` -> `/foo`.
 */
export function denormalizePagePath(page: string): string {
  if (page === '/index') {
    return '/';
  }
  return page.startsWith('/index/') && !isDynamicRoutePath(page) ? page.slice(6) : page;
}

/**
 * The URL path a route cache key is served at, or null when it has none.
 * Route keys always start with `/`; fetch keys are hashes. Partial-fallback
 * shell keys (`/prefix/c/[two]`) match no URL, so purging them clears nothing.
 */
export function cacheKeyToPurgePath(cacheKey: string): string | null {
  const pagePath = routeCacheKeyToPagePath(cacheKey);
  if (!pagePath.startsWith('/') || isDynamicRoutePath(pagePath)) {
    return null;
  }
  return denormalizePagePath(pagePath);
}

/**
 * Next 16.3.8+ keys routes as `/route-cache/<kind>/<sha256>/$<page path>`
 * (server/lib/route-cache-key.ts); earlier versions use the page path alone.
 * Split at `/$/` as Next's FileSystemCache does.
 */
function routeCacheKeyToPagePath(cacheKey: string): string {
  if (!cacheKey.startsWith('/route-cache/')) {
    return cacheKey;
  }
  const marker = cacheKey.indexOf('/$/');
  return marker === -1 ? '' : cacheKey.slice(marker + 2);
}

export interface ImplicitTagPurge {
  paths: string[];
  /** `revalidatePath('/', 'layout')`: every page on the site is affected. */
  purgeAll: boolean;
}

/**
 * Paths named by revalidatePath's `_N_T_` tags, so they can be purged even
 * when no cache key is recorded under the tag. A `/page` or `/layout` suffix
 * is revalidatePath's `type` form; dynamic patterns are skipped.
 */
export function implicitTagsToPurgePaths(tags: readonly string[]): ImplicitTagPurge {
  const paths = new Set<string>();
  let purgeAll = false;

  for (const tag of tags) {
    if (!tag.startsWith(IMPLICIT_TAG_PREFIX)) {
      continue;
    }

    // Next percent-encodes non-ASCII runs (encodeHeaderSafe); the CDN key uses the decoded path.
    let routePath = safeDecode(tag.slice(IMPLICIT_TAG_PREFIX.length));
    const typed = /^(.*?)\/(page|layout)$/.exec(routePath);
    if (typed) {
      if (typed[1] === '' && typed[2] === 'layout') {
        purgeAll = true;
        continue;
      }
      routePath = typed[1] || '/';
    }

    if (!routePath.startsWith('/') || isDynamicRoutePath(routePath)) {
      continue;
    }
    paths.add(routePath === '/index' ? '/' : routePath);
  }

  return { paths: [...paths], purgeAll };
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
