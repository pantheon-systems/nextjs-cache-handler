import * as fs from 'fs';
import * as path from 'path';

/** Writes a build output shaped like `next build`'s (verified against a Next 16.3.8 build). */
export function writeBuildOutput(
  serverDistDir: string,
  prerenders: Record<string, { key: string; tags?: string[]; router?: 'app' | 'pages' }>
): void {
  const routes: Record<string, object> = {};
  for (const [route, { key, tags, router = 'app' }] of Object.entries(prerenders)) {
    routes[route] = { initialRevalidateSeconds: false };
    const metaPath = path.join(serverDistDir, router, `${key}.meta`);
    fs.mkdirSync(path.dirname(metaPath), { recursive: true });
    const meta = router === 'app' ? { status: 200, headers: { 'x-next-cache-tags': (tags ?? []).join(',') } } : {};
    fs.writeFileSync(metaPath, JSON.stringify(meta));
  }
  fs.writeFileSync(
    path.join(serverDistDir, '..', 'prerender-manifest.json'),
    JSON.stringify({ version: 4, routes, dynamicRoutes: {} })
  );
}
