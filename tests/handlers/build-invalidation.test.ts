import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Route/ISR invalidation keyed on the generation ID (build ID + optional deployment ID).
let mockGenerationId = 'build-A';
vi.mock('../../src/utils/build-detection.js', () => ({
  getBuildId: () => mockGenerationId,
  getCacheGenerationId: () => mockGenerationId,
  isBuildPhase: () => false,
}));

const store: Record<string, string> = {};
// Keys whose download fails with a transient error.
const failingReads = new Set<string>();
const mockBucket = {
  file: vi.fn((key: string) => ({
    exists: vi.fn(async () => [key in store]),
    download: vi.fn(async () => {
      if (failingReads.has(key)) throw Object.assign(new Error('Service unavailable'), { code: 503 });
      if (!(key in store)) throw Object.assign(new Error('No such object'), { code: 404 });
      return [Buffer.from(store[key])];
    }),
    save: vi.fn(async (data: string) => {
      store[key] = data;
    }),
    delete: vi.fn(async () => {
      delete store[key];
    }),
  })),
  getFiles: vi.fn(),
};
vi.mock('@google-cloud/storage', () => ({
  Storage: function Storage() {
    return { bucket: () => mockBucket };
  },
  Bucket: vi.fn(),
}));
vi.stubGlobal('fetch', vi.fn());

const { GcsCacheHandler } = await import('../../src/handlers/gcs.js');
const { FileCacheHandler } = await import('../../src/handlers/file.js');
const { resetBuildInvalidationCheck } = await import('../../src/handlers/base.js');

const DPL_BUILD = 'build-TfctsWXpff2fKS';

// Each scenario: [name, stored meta (undefined = none), current id, expect invalidation]
const scenarios: Array<[string, string | undefined, string, boolean]> = [
  ['17 unchanged, no deployment ID', 'build-A', 'build-A', false],
  ['18 changed build, no deployment ID', 'build-A', 'build-B', true],
  ['19 same build, deployment ID changed (the bug)', `${DPL_BUILD}:dpl-1`, `${DPL_BUILD}:dpl-2`, true],
  ['20 same build and deployment ID', `${DPL_BUILD}:dpl-1`, `${DPL_BUILD}:dpl-1`, false],
  ['21 upgrade, plain meta and no deployment ID', 'build-A', 'build-A', false],
  ['22 plain meta, deployment ID now present', DPL_BUILD, `${DPL_BUILD}:dpl-1`, true],
  ['23 first run, no meta', undefined, 'build-A', false],
];

describe('GcsCacheHandler build invalidation', () => {
  beforeEach(() => {
    for (const k of Object.keys(store)) delete store[k];
    failingReads.clear();
    process.env.CACHE_BUCKET = 'test-bucket';
    process.env.PANTHEON_ENVIRONMENT = 'pr-42';
    process.env.OUTBOUND_PROXY_ENDPOINT = 'proxy.example.com:8080';
    vi.clearAllMocks();
    vi.mocked(fetch).mockResolvedValue({ ok: true, status: 200 } as Response);
    mockBucket.getFiles.mockResolvedValue([[]]);
    resetBuildInvalidationCheck();
  });

  afterEach(() => {
    delete process.env.CACHE_BUCKET;
    delete process.env.PANTHEON_ENVIRONMENT;
    delete process.env.OUTBOUND_PROXY_ENDPOINT;
  });

  it.each(scenarios)('%s', async (_name, stored, current, invalidates) => {
    const metaKey = 'environments/pr-42/build-meta.json';
    if (stored !== undefined) store[metaKey] = JSON.stringify({ buildId: stored, timestamp: 1 });
    mockGenerationId = current;

    const handler = new GcsCacheHandler({} as any);
    await handler.get('k');

    if (invalidates) {
      expect(mockBucket.getFiles).toHaveBeenCalledWith({ prefix: 'environments/pr-42/route-cache/' });
      expect(fetch).toHaveBeenCalledWith(
        expect.stringContaining('/rest/v0alpha1/cache'),
        expect.objectContaining({ method: 'DELETE' })
      );
      expect(JSON.parse(store[metaKey]).buildId).toBe(current);
      for (const [args] of mockBucket.getFiles.mock.calls) {
        expect(args.prefix).toMatch(/^environments\/pr-42\//);
      }
    } else {
      expect(mockBucket.getFiles).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
    }
    if (stored === undefined) expect(JSON.parse(store[metaKey]).buildId).toBe(current);
  });

  it('leaves the check to the next handler when build-meta.json cannot be read, then invalidates', async () => {
    const metaKey = 'environments/pr-42/build-meta.json';
    store[metaKey] = JSON.stringify({ buildId: 'build-A', timestamp: 1 });
    mockGenerationId = 'build-B';
    failingReads.add(metaKey);

    await new GcsCacheHandler({} as any).get('k');

    // Not treated as a first run: no new generation recorded, nothing wiped or purged yet.
    expect(JSON.parse(store[metaKey]).buildId).toBe('build-A');
    expect(mockBucket.getFiles).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();

    failingReads.delete(metaKey);
    await new GcsCacheHandler({} as any).get('k');

    expect(mockBucket.getFiles).toHaveBeenCalledWith({ prefix: 'environments/pr-42/route-cache/' });
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining('/rest/v0alpha1/cache'),
      expect.objectContaining({ method: 'DELETE' })
    );
    expect(JSON.parse(store[metaKey]).buildId).toBe('build-B');
  });

  it('treats build-meta.json that is not valid JSON as a different build', async () => {
    const metaKey = 'environments/pr-42/build-meta.json';
    store[metaKey] = 'not json';
    mockGenerationId = 'build-A';

    await new GcsCacheHandler({} as any).get('k');

    expect(mockBucket.getFiles).toHaveBeenCalledWith({ prefix: 'environments/pr-42/route-cache/' });
    expect(fetch).toHaveBeenCalled();
    expect(JSON.parse(store[metaKey]).buildId).toBe('build-A');
  });
});

describe('FileCacheHandler build invalidation', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'build-inval-'));
    vi.spyOn(process, 'cwd').mockReturnValue(tempDir);
    resetBuildInvalidationCheck();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it.each(scenarios)('%s', async (_name, stored, current, invalidates) => {
    const metaFile = path.join(tempDir, '.cache', 'build-meta.json');
    const sentinel = path.join(tempDir, '.next', 'cache', 'route-cache', 'sentinel.json');
    fs.mkdirSync(path.dirname(sentinel), { recursive: true });
    fs.writeFileSync(sentinel, '{}');
    if (stored !== undefined) {
      fs.mkdirSync(path.dirname(metaFile), { recursive: true });
      fs.writeFileSync(metaFile, JSON.stringify({ buildId: stored, timestamp: 1 }));
    }
    mockGenerationId = current;

    // FileCacheHandler doesn't expose its init promise, so let it settle.
    new FileCacheHandler({} as any);
    await new Promise((r) => setTimeout(r, 100));

    expect(fs.existsSync(sentinel)).toBe(!invalidates);
    expect(JSON.parse(fs.readFileSync(metaFile, 'utf-8')).buildId).toBe(
      stored === undefined || invalidates ? current : stored
    );
  });

  function setUp(meta: (metaFile: string) => void) {
    const metaFile = path.join(tempDir, '.cache', 'build-meta.json');
    const sentinel = path.join(tempDir, '.next', 'cache', 'route-cache', 'sentinel.json');
    fs.mkdirSync(path.dirname(sentinel), { recursive: true });
    fs.writeFileSync(sentinel, '{}');
    fs.mkdirSync(path.dirname(metaFile), { recursive: true });
    meta(metaFile);
    return { metaFile, sentinel };
  }

  it('treats build metadata that is not valid JSON as a different build', async () => {
    const { metaFile, sentinel } = setUp((f) => fs.writeFileSync(f, 'not json'));
    mockGenerationId = 'build-A';

    new FileCacheHandler({} as any);
    await new Promise((r) => setTimeout(r, 100));

    expect(fs.existsSync(sentinel)).toBe(false);
    expect(JSON.parse(fs.readFileSync(metaFile, 'utf-8')).buildId).toBe('build-A');
  });

  it('does not treat unreadable build metadata as a first run', async () => {
    // A directory where the file should be: reading it fails with EISDIR, not ENOENT.
    const { sentinel } = setUp((f) => fs.mkdirSync(f));
    mockGenerationId = 'build-A';
    const writeBuildMeta = vi.spyOn(FileCacheHandler.prototype as any, 'writeBuildMeta');

    new FileCacheHandler({} as any);
    await new Promise((r) => setTimeout(r, 100));

    expect(writeBuildMeta).not.toHaveBeenCalled();
    expect(fs.existsSync(sentinel)).toBe(true);
  });
});
