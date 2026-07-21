import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { FileCacheHandler } from '../../src/handlers/file.js';
import { tagsManifest } from 'next/dist/server/lib/incremental-cache/tags-manifest.external.js';

/**
 * Regression test for the build-time prerender read-through (BaseCacheHandler.get).
 *
 * A statically prerendered route/handler is emitted at build to
 * `<serverDistDir>/app/<key>.body` + `.meta` and never written through our
 * handler. Before the fix our store missed those and Next regenerated the route
 * at runtime, discarding build-time `'use cache'` values (the
 * use-cache-metadata-route-handler e2e case: `sentinel=runtime` instead of
 * `buildtime`). We now read-through to Next's built-in FileSystemCache on a miss.
 */
describe('BaseCacheHandler build-prerender fallback', () => {
  let tempDir: string;
  let serverDistDir: string;
  let originalCwd: string;
  let handler: FileCacheHandler;

  // Minimal CacheFs the built-in FileSystemCache expects from the context.
  const cacheFs = {
    readFile: (p: string, enc?: BufferEncoding) => fs.promises.readFile(p, enc),
    readFileSync: (p: string, enc?: BufferEncoding) => fs.readFileSync(p, enc),
    writeFile: (p: string, data: string | Buffer) => fs.promises.writeFile(p, data),
    mkdir: (p: string) => fs.promises.mkdir(p, { recursive: true }).then(() => undefined),
    stat: (p: string) => fs.promises.stat(p),
  };

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prerender-fallback-'));
    fs.mkdirSync(path.join(tempDir, '.next', 'cache', 'route-cache'), { recursive: true });
    fs.mkdirSync(path.join(tempDir, '.next', 'cache', 'fetch-cache'), { recursive: true });
    fs.mkdirSync(path.join(tempDir, '.next', 'cache', 'tags'), { recursive: true });

    serverDistDir = path.join(tempDir, '.next', 'server');
    fs.mkdirSync(path.join(serverDistDir, 'app'), { recursive: true });

    originalCwd = process.cwd();
    vi.spyOn(process, 'cwd').mockReturnValue(tempDir);

    tagsManifest.clear();

    handler = new FileCacheHandler({
      serverDistDir,
      fs: cacheFs,
      revalidatedTags: [],
    } as any);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    tagsManifest.clear();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function writeBuildPrerender(key: string, body: string, tags: string[], mtime?: Date) {
    const bodyPath = path.join(serverDistDir, 'app', `${key}.body`);
    const metaPath = path.join(serverDistDir, 'app', `${key}.meta`);
    fs.writeFileSync(bodyPath, body);
    fs.writeFileSync(
      metaPath,
      JSON.stringify({
        status: 200,
        headers: { 'content-type': 'application/xml', 'x-next-cache-tags': tags.join(',') },
      })
    );
    if (mtime) {
      fs.utimesSync(bodyPath, mtime, mtime);
    }
  }

  it('serves the build-time prerender when our own store misses', async () => {
    writeBuildPrerender('sitemap.xml', '<loc>sentinel=buildtime</loc>', ['tagA']);

    const result = await handler.get('/sitemap.xml', { kind: 'APP_ROUTE' } as any);

    expect(result).not.toBeNull();
    expect((result?.value as any)?.kind).toBe('APP_ROUTE');
    expect(Buffer.from((result?.value as any).body).toString('utf8')).toContain('sentinel=buildtime');
  });

  it('prefers a runtime store entry over the build prerender', async () => {
    writeBuildPrerender('sitemap.xml', '<loc>sentinel=buildtime</loc>', ['tagA']);

    // A runtime-written entry in our own store should win.
    await handler.set(
      '/sitemap.xml',
      { kind: 'APP_ROUTE', status: 200, body: Buffer.from('<loc>sentinel=fresh</loc>'), headers: {} } as any,
      { tags: ['tagA'] } as any
    );

    const result = await handler.get('/sitemap.xml', { kind: 'APP_ROUTE' } as any);
    expect(Buffer.from((result?.value as any).body).toString('utf8')).toContain('sentinel=fresh');
  });

  it('does not resurrect a build prerender whose tag was revalidated', async () => {
    // Prerender emitted an hour ago so a revalidation stamped "now" is strictly later.
    const anHourAgo = new Date(Date.now() - 60 * 60 * 1000);
    writeBuildPrerender('sitemap.xml', '<loc>sentinel=buildtime</loc>', ['tagA'], anHourAgo);

    // Sanity: served before revalidation.
    expect(await handler.get('/sitemap.xml', { kind: 'APP_ROUTE' } as any)).not.toBeNull();

    await handler.revalidateTag('tagA');

    // After revalidation the stale build prerender must be suppressed (miss),
    // so Next regenerates rather than serving stale content.
    const afterRevalidate = await handler.get('/sitemap.xml', { kind: 'APP_ROUTE' } as any);
    expect(afterRevalidate).toBeNull();
  });

  it('returns null when there is no store entry and no build prerender', async () => {
    const result = await handler.get('/nonexistent', { kind: 'APP_ROUTE' } as any);
    expect(result).toBeNull();
  });
});
