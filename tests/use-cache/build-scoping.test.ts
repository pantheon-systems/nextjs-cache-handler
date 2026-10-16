import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import type { UseCacheEntry } from '../../src/handlers/use-cache/types.js';

// Reproduces the "redeploy the same Multidev environment" scenario behind the
// use-cache-metadata-route-handler sitemap/manifest.json regression: a route
// cached during one build must not be silently served (or silently lost) once
// a later build reuses the same persisted store. See
// e2e-deploy-suite-findings.md #9 in the adapter repo for the original symptom.

let mockBuildId = 'build-A';
let mockDeploymentId = '';
let mockBuildPhase = false;
vi.mock('../../src/utils/build-detection.js', () => ({
  getBuildId: () => mockBuildId,
  getCacheGenerationId: () => (mockDeploymentId ? `${mockBuildId}:${mockDeploymentId}` : mockBuildId),
  isBuildPhase: () => mockBuildPhase,
}));

const mockFile = {
  exists: vi.fn(),
  download: vi.fn(),
  save: vi.fn(),
  delete: vi.fn(),
};
const mockBucket = {
  file: vi.fn(() => mockFile),
  getFiles: vi.fn(),
};
vi.mock('@google-cloud/storage', () => ({
  Storage: function Storage() {
    return { bucket: () => mockBucket };
  },
  Bucket: vi.fn(),
  RETRYABLE_ERR_FN_DEFAULT: () => true,
}));

// Mock fetch for edge cache clearing (used by the "clears the edge cache on
// a new build" tests below).
vi.stubGlobal('fetch', vi.fn());

const { UseCacheFileHandler } = await import('../../src/handlers/use-cache/file.js');
const { UseCacheGcsHandler } = await import('../../src/handlers/use-cache/gcs.js');
const { streamToBytes } = await import('../../src/utils/stream-serialization.js');

// Next's in-memory build store is one per process and outlives each test, so
// every build-phase test uses keys of its own.
let buildTest = 0;
beforeEach(() => {
  buildTest++;
});
const key = (name: string) => `${name}-${buildTest}`;

function createTestStream(text: string): ReadableStream<Uint8Array> {
  const data = new TextEncoder().encode(text);
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(data);
      controller.close();
    },
  });
}

function createTestEntry(value: string, options: Partial<UseCacheEntry> = {}): UseCacheEntry {
  return {
    value: createTestStream(value),
    tags: options.tags ?? [],
    stale: options.stale ?? 60,
    timestamp: options.timestamp ?? Date.now(),
    expire: options.expire ?? 3600,
    revalidate: options.revalidate ?? 300,
  };
}

async function readValue(entry: UseCacheEntry): Promise<string> {
  return new TextDecoder().decode(await streamToBytes(entry.value));
}

describe('use-cache build scoping', () => {
  describe('UseCacheFileHandler (simulating a Multidev redeploy)', () => {
    const testCacheDir = path.join(process.cwd(), '.next', 'cache', 'use-cache-build-scoping-test');

    beforeEach(() => {
      if (fs.existsSync(testCacheDir)) {
        fs.rmSync(testCacheDir, { recursive: true, force: true });
      }
      mockBuildId = 'build-A';
      mockDeploymentId = '';
    });

    afterEach(() => {
      if (fs.existsSync(testCacheDir)) {
        fs.rmSync(testCacheDir, { recursive: true, force: true });
      }
    });

    it('serves an entry within the build that wrote it', async () => {
      const handlerA = new UseCacheFileHandler({ cacheDir: testCacheDir });
      await handlerA.set('sitemap', Promise.resolve(createTestEntry('buildtime-A')));

      const entry = await handlerA.get('sitemap', []);
      expect(entry).toBeDefined();
      expect(await readValue(entry!)).toBe('buildtime-A');
    });

    it('does not resurrect a previous build entry as current after redeploy', async () => {
      const handlerA = new UseCacheFileHandler({ cacheDir: testCacheDir });
      await handlerA.set('sitemap', Promise.resolve(createTestEntry('buildtime-A')));

      // Simulate redeploy: a fresh process, same persisted cache directory, new build id.
      mockBuildId = 'build-B';
      const handlerB = new UseCacheFileHandler({ cacheDir: testCacheDir });

      const entry = await handlerB.get('sitemap', []);
      expect(entry).toBeUndefined();
    });

    it('misses after the deployment ID changes even though the build ID is unchanged', async () => {
      mockBuildId = 'build-TfctsWXpff2fKS';
      mockDeploymentId = 'dpl-1';
      const handlerA = new UseCacheFileHandler({ cacheDir: testCacheDir });
      await handlerA.set('sitemap', Promise.resolve(createTestEntry('dpl-1-entry')));

      mockDeploymentId = 'dpl-2';
      const handlerB = new UseCacheFileHandler({ cacheDir: testCacheDir });
      expect(await handlerB.get('sitemap', [])).toBeUndefined();
    });

    it('serves the fresh entry the new build writes for the same key (the regression case)', async () => {
      const handlerA = new UseCacheFileHandler({ cacheDir: testCacheDir });
      await handlerA.set('sitemap', Promise.resolve(createTestEntry('buildtime-A')));

      mockBuildId = 'build-B';
      const handlerB = new UseCacheFileHandler({ cacheDir: testCacheDir });
      await handlerB.set('sitemap', Promise.resolve(createTestEntry('buildtime-B')));

      const entry = await handlerB.get('sitemap', []);
      expect(entry).toBeDefined();
      expect(await readValue(entry!)).toBe('buildtime-B');
    });

    it('treats pre-existing entries with no __buildId as valid (no forced invalidation on rollout)', async () => {
      const handlerA = new UseCacheFileHandler({ cacheDir: testCacheDir });
      await handlerA.set('sitemap', Promise.resolve(createTestEntry('legacy-entry')));

      // Strip __buildId to simulate an entry written before this fix shipped.
      const filePath = path.join(testCacheDir, 'sitemap.json');
      const stored = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      delete stored.__buildId;
      fs.writeFileSync(filePath, JSON.stringify(stored), 'utf-8');

      mockBuildId = 'build-B';
      const handlerB = new UseCacheFileHandler({ cacheDir: testCacheDir });
      const entry = await handlerB.get('sitemap', []);
      expect(entry).toBeDefined();
      expect(await readValue(entry!)).toBe('legacy-entry');
    });

    describe('during next build', () => {
      afterEach(() => {
        mockBuildPhase = false;
      });

      it('serves an entry set earlier in the same build, as prerendering needs', async () => {
        mockBuildPhase = true;
        const writer = new UseCacheFileHandler({ cacheDir: testCacheDir });
        await writer.set(key('sitemap'), Promise.resolve(createTestEntry('buildtime')));

        const reader = new UseCacheFileHandler({ cacheDir: testCacheDir });
        const entry = await reader.get(key('sitemap'), []);
        expect(entry).toBeDefined();
        expect(await readValue(entry!)).toBe('buildtime');
        expect(fs.existsSync(path.join(testCacheDir, `${key('sitemap')}.json`))).toBe(false);
      });

      it('does not persist entries, so the runtime renders fresh', async () => {
        mockBuildPhase = true;
        const build = new UseCacheFileHandler({ cacheDir: testCacheDir });
        await build.set(key('page-sentinel'), Promise.resolve(createTestEntry('buildtime')));
        expect(fs.existsSync(path.join(testCacheDir, `${key('page-sentinel')}.json`))).toBe(false);

        mockBuildPhase = false;
        const runtime = new UseCacheFileHandler({ cacheDir: testCacheDir });
        expect(await runtime.get(key('page-sentinel'), [])).toBeUndefined();
      });

      it('misses without reading or deleting entries the live revision uses', async () => {
        const live = new UseCacheFileHandler({ cacheDir: testCacheDir });
        await live.set(key('sitemap'), Promise.resolve(createTestEntry('live')));

        mockBuildPhase = true;
        mockBuildId = 'build-B';
        const build = new UseCacheFileHandler({ cacheDir: testCacheDir });
        expect(await build.get(key('sitemap'), [])).toBeUndefined();
        expect(fs.existsSync(path.join(testCacheDir, `${key('sitemap')}.json`))).toBe(true);
      });

      it('resolves set() when the entry is a tee branch whose other branch is never read', async () => {
        // Next passes one branch of a tee; for a dynamic hole it never reads the other.
        mockBuildPhase = true;
        const [branch] = createTestStream('buildtime').tee();
        const entry = { ...createTestEntry('unused'), value: branch };
        const set = new UseCacheFileHandler({ cacheDir: testCacheDir }).set(key('k'), Promise.resolve(entry));
        const outcome = await Promise.race([
          set.then(() => 'resolved'),
          new Promise((r) => setTimeout(() => r('hung'), 500)),
        ]);
        expect(outcome).toBe('resolved');
      });

      it('resolves set() even when the pending entry rejects', async () => {
        mockBuildPhase = true;
        const handler = new UseCacheFileHandler({ cacheDir: testCacheDir });
        await expect(handler.set(key('k'), Promise.reject(new Error('render failed')))).resolves.toBeUndefined();
      });

      it('persists and serves entries again once the build phase is over', async () => {
        const runtime = new UseCacheFileHandler({ cacheDir: testCacheDir });
        await runtime.set(key('page-sentinel'), Promise.resolve(createTestEntry('runtime')));
        const entry = await runtime.get(key('page-sentinel'), []);
        expect(entry).toBeDefined();
        expect(await readValue(entry!)).toBe('runtime');
      });
    });
  });

  describe('UseCacheGcsHandler (simulating a Multidev redeploy)', () => {
    let store: Record<string, string> = {};

    beforeEach(() => {
      process.env.CACHE_BUCKET = 'test-bucket';
      mockBuildId = 'build-A';
      mockDeploymentId = '';
      store = {};

      vi.clearAllMocks();
      mockBucket.file.mockImplementation((key: string) => ({
        exists: vi.fn().mockResolvedValue([key in store]),
        download: vi.fn().mockResolvedValue([Buffer.from(store[key] ?? '{}')]),
        save: vi.fn().mockImplementation(async (data: string) => {
          store[key] = data;
        }),
        delete: vi.fn().mockImplementation(async () => {
          delete store[key];
        }),
      }));
    });

    afterEach(() => {
      delete process.env.CACHE_BUCKET;
    });

    it('does not resurrect a previous build entry as current after redeploy', async () => {
      const handlerA = new UseCacheGcsHandler();
      await handlerA.set('sitemap', Promise.resolve(createTestEntry('buildtime-A')));

      mockBuildId = 'build-B';
      const handlerB = new UseCacheGcsHandler();

      const entry = await handlerB.get('sitemap', []);
      expect(entry).toBeUndefined();
    });

    it('misses after the deployment ID changes even though the build ID is unchanged', async () => {
      mockBuildId = 'build-TfctsWXpff2fKS';
      mockDeploymentId = 'dpl-1';
      const handlerA = new UseCacheGcsHandler();
      await handlerA.set('sitemap', Promise.resolve(createTestEntry('dpl-1-entry')));

      mockDeploymentId = 'dpl-2';
      const handlerB = new UseCacheGcsHandler();
      expect(await handlerB.get('sitemap', [])).toBeUndefined();
    });

    it('serves the fresh entry the new build writes for the same key (the regression case)', async () => {
      const handlerA = new UseCacheGcsHandler();
      await handlerA.set('sitemap', Promise.resolve(createTestEntry('buildtime-A')));

      mockBuildId = 'build-B';
      const handlerB = new UseCacheGcsHandler();
      await handlerB.set('sitemap', Promise.resolve(createTestEntry('buildtime-B')));

      const entry = await handlerB.get('sitemap', []);
      expect(entry).toBeDefined();
      expect(await readValue(entry!)).toBe('buildtime-B');
    });

    describe('edge cache purge on build invalidation', () => {
      beforeEach(() => {
        process.env.OUTBOUND_PROXY_ENDPOINT = 'proxy.example.com:8080';
        vi.mocked(fetch).mockClear();
        vi.mocked(fetch).mockResolvedValue({ ok: true, status: 200 } as Response);
      });

      afterEach(() => {
        delete process.env.OUTBOUND_PROXY_ENDPOINT;
      });

      it('clears the edge cache when a new build is detected', async () => {
        const handlerA = new UseCacheGcsHandler();
        // Wait for handlerA's own (first-run) checkBuildInvalidation to settle
        // before switching build ids, so it can't be mistaken for handlerB's.
        await handlerA.get('sitemap', []);
        vi.mocked(fetch).mockClear();

        mockBuildId = 'build-B';
        const handlerB = new UseCacheGcsHandler();
        // get()/set() await initPromise (which runs checkBuildInvalidation)
        // before touching the store -- by the time this resolves, the purge
        // request has been issued if a mismatch was found.
        await handlerB.get('sitemap', []);

        expect(fetch).toHaveBeenCalledWith(
          'http://proxy.example.com:8080/rest/v0alpha1/cache',
          expect.objectContaining({ method: 'DELETE' })
        );
      });

      it('does not clear the edge cache when the build id is unchanged', async () => {
        const handlerA = new UseCacheGcsHandler();
        await handlerA.get('sitemap', []);
        vi.mocked(fetch).mockClear();

        // Same mockBuildId ('build-A') -- a second handler for the same build
        // (e.g. a server restart with no redeploy) should not re-purge.
        const handlerA2 = new UseCacheGcsHandler();
        await handlerA2.get('sitemap', []);

        expect(fetch).not.toHaveBeenCalled();
      });
    });

    describe('during next build', () => {
      afterEach(() => {
        mockBuildPhase = false;
        delete process.env.OUTBOUND_PROXY_ENDPOINT;
      });

      it('serves an entry set earlier in the same build without touching GCS (use-cache-metadata-route-handler)', async () => {
        const live = new UseCacheGcsHandler();
        await live.get('warm-up', []);
        const liveStore = { ...store };

        mockBuildPhase = true;
        mockBuildId = 'build-B';
        const writer = new UseCacheGcsHandler();
        await writer.set(key('sitemap'), Promise.resolve(createTestEntry('buildtime')));

        const entry = await new UseCacheGcsHandler().get(key('sitemap'), []);
        expect(entry).toBeDefined();
        expect(await readValue(entry!)).toBe('buildtime');
        // Read twice: the stored copy must survive being served.
        expect(await readValue((await writer.get(key('sitemap'), []))!)).toBe('buildtime');
        expect(store).toEqual(liveStore);
      });

      it('does not serve a build-time entry once the build phase is over (use-cache-private)', async () => {
        mockBuildPhase = true;
        await new UseCacheGcsHandler().set(key('page-sentinel'), Promise.resolve(createTestEntry('buildtime')));

        mockBuildPhase = false;
        expect(await new UseCacheGcsHandler().get(key('page-sentinel'), [])).toBeUndefined();
      });

      it('lets a get() for a key still being set wait for it, as Next does', async () => {
        mockBuildPhase = true;
        let resolveEntry!: (entry: UseCacheEntry) => void;
        const handler = new UseCacheGcsHandler();
        const set = handler.set(key('k'), new Promise<UseCacheEntry>((r) => (resolveEntry = r)));
        const get = handler.get(key('k'), []);
        resolveEntry(createTestEntry('buildtime'));
        await set;
        expect(await readValue((await get)!)).toBe('buildtime');
      });

      it('stores nothing for a rejected entry and does not leave later reads waiting', async () => {
        mockBuildPhase = true;
        const handler = new UseCacheGcsHandler();
        await expect(handler.set(key('k'), Promise.reject(new Error('render failed')))).resolves.toBeUndefined();
        expect(await handler.get(key('k'), [])).toBeUndefined();
      });

      it('does not persist entries, so the runtime renders fresh (use-cache-private)', async () => {
        mockBuildId = 'build-TfctsWXpff2fKS';
        mockDeploymentId = 'dpl-1';

        mockBuildPhase = true;
        const build = new UseCacheGcsHandler();
        await build.set(key('page-sentinel'), Promise.resolve(createTestEntry('buildtime')));
        expect(Object.keys(store).some((k) => k.endsWith(`${key('page-sentinel')}.json`))).toBe(false);

        mockBuildPhase = false;
        const runtime = new UseCacheGcsHandler();
        expect(await runtime.get(key('page-sentinel'), [])).toBeUndefined();
      });

      it('misses without reading or deleting entries the live revision uses', async () => {
        const live = new UseCacheGcsHandler();
        await live.set(key('sitemap'), Promise.resolve(createTestEntry('live')));
        const liveKeys = Object.keys(store);

        mockBuildPhase = true;
        mockBuildId = 'build-B';
        const build = new UseCacheGcsHandler();
        expect(await build.get(key('sitemap'), [])).toBeUndefined();
        expect(Object.keys(store)).toEqual(liveKeys);
      });

      it('resolves set() when the entry is a tee branch whose other branch is never read', async () => {
        mockBuildPhase = true;
        const [branch] = createTestStream('buildtime').tee();
        const entry = { ...createTestEntry('unused'), value: branch };
        const set = new UseCacheGcsHandler().set(key('k'), Promise.resolve(entry));
        const outcome = await Promise.race([
          set.then(() => 'resolved'),
          new Promise((r) => setTimeout(() => r('hung'), 500)),
        ]);
        expect(outcome).toBe('resolved');
      });

      it('leaves build meta and the CDN to the runtime that serves the build', async () => {
        const live = new UseCacheGcsHandler();
        await live.get(key('sitemap'), []);
        const metaKey = Object.keys(store).find((k) => k.endsWith('_build-meta.json'))!;
        const liveMeta = store[metaKey];

        process.env.OUTBOUND_PROXY_ENDPOINT = 'proxy.example.com:8080';
        vi.mocked(fetch).mockClear();
        vi.mocked(fetch).mockResolvedValue({ ok: true, status: 200 } as Response);

        mockBuildPhase = true;
        mockBuildId = 'build-B';
        const build = new UseCacheGcsHandler();
        await build.set(key('sitemap'), Promise.resolve(createTestEntry('buildtime')));
        expect(store[metaKey]).toBe(liveMeta);
        expect(fetch).not.toHaveBeenCalled();

        // The new revision's first runtime handler detects the build and purges.
        mockBuildPhase = false;
        const runtime = new UseCacheGcsHandler();
        await runtime.get(key('sitemap'), []);
        expect(JSON.parse(store[metaKey]).buildId).toBe('build-B');
        expect(fetch).toHaveBeenCalledWith(
          'http://proxy.example.com:8080/rest/v0alpha1/cache',
          expect.objectContaining({ method: 'DELETE' })
        );
      });
    });
  });
});
