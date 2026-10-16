import * as fs from 'fs';
import * as path from 'path';
import { toObjectName } from './object-names.js';

interface PrerenderManifest {
  routes?: Record<
    string,
    {
      initialRevalidateSeconds?: false | number;
    }
  >;
}

/**
 * Gets static routes from prerender-manifest.json.
 * Static routes have initialRevalidateSeconds: false (never revalidate).
 * These should not be cleared as they are built during build time.
 */
export function getStaticRoutes(): Set<string> {
  const staticRoutes = new Set<string>();

  try {
    const manifest = readPrerenderManifest();
    if (!manifest) {
      return staticRoutes;
    }

    const routes = manifest.routes || {};

    for (const [route, config] of Object.entries(routes)) {
      // initialRevalidateSeconds: false means truly static (SSG)
      // initialRevalidateSeconds: number means ISR (can be cleared)
      if (config.initialRevalidateSeconds === false) {
        staticRoutes.add(toObjectName(routeToCacheKey(route)));
        // Next 16.3.8+ keys routes by source too; the `.meta` file records the exact key.
        const routeCacheKey = readRouteCacheKey(route);
        if (routeCacheKey) {
          staticRoutes.add(toObjectName(routeCacheKey));
        }
      }
    }
  } catch {
    // If we can't read the manifest, don't preserve any routes
  }

  return staticRoutes;
}

function readPrerenderManifest(): PrerenderManifest | null {
  try {
    const manifestPath = path.join(process.cwd(), '.next', 'prerender-manifest.json');
    if (!fs.existsSync(manifestPath)) {
      return null;
    }
    return JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
  } catch {
    return null;
  }
}

/** `routeCache.key` from the route's build `.meta` file (Next 16.3.8+), if any. */
function readRouteCacheKey(route: string): string | null {
  const page = route === '/' ? '/index' : /^\/index(\/|$)/.test(route) ? `/index${route}` : route;
  for (const dir of ['app', 'pages']) {
    try {
      const metaPath = path.join(process.cwd(), '.next', 'server', dir, `${page}.meta`);
      const key = JSON.parse(fs.readFileSync(metaPath, 'utf-8'))?.routeCache?.key;
      if (typeof key === 'string') {
        return key;
      }
    } catch {
      // Not built under this router, or no .meta
    }
  }
  return null;
}

/**
 * The cache key Next used for a route before 16.3.8 (and 15.5.x before route
 * keys): its path, with `/` stored as `/index`.
 */
function routeToCacheKey(route: string): string {
  return route === '/' ? '/index' : route;
}
