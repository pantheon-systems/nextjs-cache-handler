import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import {
  createCacheHandler,
  createUseCacheHandler,
  getSharedCacheStats,
  getUseCacheStats,
  clearSharedCache,
  clearEdgeCache,
  clearEdgeCachePaths,
} from '../src/index.edge.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.join(here, '..', 'src');

// The edge entry is resolved by Next's edge bundler via the `edge-light`/`worker`
// export conditions. It MUST NOT pull in `fs`, `net`, or `@google-cloud/storage`,
// or edge routes/middleware fail to build ("edge runtime does not support Node.js
// 'fs'" / "Can't resolve 'net'"). These tests lock that contract in.

describe('edge entry — static safety', () => {
  const edgeEntries = [path.join(srcDir, 'index.edge.ts'), path.join(srcDir, 'handlers', 'use-cache', 'index.edge.ts')];

  for (const file of edgeEntries) {
    const rel = path.relative(srcDir, file);

    it(`${rel} has no runtime (value) imports`, () => {
      const source = fs.readFileSync(file, 'utf-8');
      const importLines = source.split('\n').filter((line) => /^\s*import\b/.test(line) && !/^\s*\/\//.test(line));
      // Every import must be a type-only import (erased at runtime) so nothing
      // Node-only can enter the edge bundle.
      for (const line of importLines) {
        expect(line, `non-type import in edge entry: ${line.trim()}`).toMatch(/import\s+type\b/);
      }
    });

    it(`${rel} never imports Node-only modules`, () => {
      // Strip comments so the guard only inspects real code (the explanatory
      // comments in these files legitimately name fs/net/@google-cloud/storage).
      const code = fs
        .readFileSync(file, 'utf-8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:])\/\/.*$/gm, '$1');
      // No module specifier (in import/export/require) may reference a Node-only module.
      expect(code).not.toMatch(/['"](node:)?fs['"]/);
      expect(code).not.toMatch(/['"]net['"]/);
      expect(code).not.toMatch(/@google-cloud\/storage/);
    });
  }
});

describe('edge entry — no-op handler behavior', () => {
  it('createCacheHandler returns an edge-safe no-op handler', async () => {
    const Handler = createCacheHandler({ type: 'auto' });
    const handler = new Handler({} as never);
    await expect(handler.get()).resolves.toBeNull();
    await expect(handler.set()).resolves.toBeUndefined();
    await expect(handler.revalidateTag()).resolves.toBeUndefined();
    expect(() => handler.resetRequestCache()).not.toThrow();
  });

  it('createUseCacheHandler returns an edge-safe no-op handler', async () => {
    const Handler = createUseCacheHandler({ type: 'auto' });
    const handler = new Handler();
    await expect(handler.get()).resolves.toBeUndefined();
    await expect(handler.set()).resolves.toBeUndefined();
    await expect(handler.refreshTags()).resolves.toBeUndefined();
    await expect(handler.getExpiration()).resolves.toBe(0);
    await expect(handler.updateTags()).resolves.toBeUndefined();
    await expect(handler.getStats()).resolves.toEqual({ size: 0, entries: [], keys: [] });
  });

  it('stats and clear helpers are inert at the edge', async () => {
    await expect(getSharedCacheStats()).resolves.toEqual({ size: 0, keys: [], entries: [] });
    await expect(getUseCacheStats()).resolves.toEqual({ size: 0, entries: [], keys: [] });
    await expect(clearSharedCache()).resolves.toBe(0);
    await expect(clearEdgeCache()).resolves.toBeNull();
    await expect(clearEdgeCachePaths(['/'])).resolves.toBeNull();
  });
});
