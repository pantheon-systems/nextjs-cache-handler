import * as fs from 'fs';
import * as path from 'path';

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
        const cacheKey = routeToCacheKey(route);
        staticRoutes.add(cacheKey);
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

/**
 * Converts a route path to cache key format.
 * Example: "/ssg-demo" -> "_ssg-demo", "/" -> "_index"
 */
function routeToCacheKey(route: string): string {
  if (route === '/') {
    return '_index';
  }
  return route.replace(/\//g, '_');
}
