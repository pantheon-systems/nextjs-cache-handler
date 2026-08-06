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
vi.mock('../../src/utils/build-detection.js', () => ({
  getBuildId: () => mockBuildId,
  isBuildPhase: () => false,
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
}));

const { UseCacheFileHandler } = await import('../../src/handlers/use-cache/file.js');
const { UseCacheGcsHandler } = await import('../../src/handlers/use-cache/gcs.js');
const { streamToBytes } = await import('../../src/utils/stream-serialization.js');

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
  });

  describe('UseCacheGcsHandler (simulating a Multidev redeploy)', () => {
    let store: Record<string, string> = {};

    beforeEach(() => {
      process.env.CACHE_BUCKET = 'test-bucket';
      mockBuildId = 'build-A';
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
  });
});
