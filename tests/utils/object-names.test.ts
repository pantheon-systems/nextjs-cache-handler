import { describe, it, expect, vi, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { toObjectName } from '../../src/utils/object-names.js';
import { FileCacheHandler } from '../../src/handlers/file.js';

describe('toObjectName', () => {
  it('keeps a key of only [a-zA-Z0-9-] as it is (fetch and image keys)', () => {
    const fetchKey = '04fa974ff83fdeb9d7a05c4ba7c9ab3eb2b813e868da7080e0d06ec0a669fa7b';
    expect(toObjectName(fetchKey)).toBe(fetchKey);
  });

  it('gives keys that sanitize alike different names', () => {
    const route = '/route-cache/APP_PAGE/c3858/$/docs/';
    const names = ['a/b', 'a_b', 'a.b', 'a b'].map((p) => toObjectName(route + p));
    expect(new Set(names).size).toBe(4);
    for (const name of names) {
      expect(name).toMatch(/^_route-cache_APP_PAGE_c3858___docs_a_b_[0-9a-f]{16}$/);
    }
  });

  it('is stable for the same key', () => {
    expect(toObjectName('/blog/post')).toBe(toObjectName('/blog/post'));
  });

  it('keeps names of long keys within file name limits, and distinct', () => {
    const route = '/route-cache/APP_PAGE/c3858/$/blog/';
    const keys = [route + 'a'.repeat(400), route + 'a'.repeat(399) + 'b', 'f'.repeat(201), 'f'.repeat(200) + 'e'];
    const names = keys.map(toObjectName);
    expect(new Set(names).size).toBe(keys.length);
    for (const name of names) {
      expect(name.length).toBeLessThanOrEqual(200);
      expect(name).toContain('_');
    }
    expect(toObjectName('f'.repeat(200))).toBe('f'.repeat(200));
  });

  it("never names a key like the use cache handler's control objects", () => {
    expect(toObjectName('_tags')).not.toBe('_tags');
    expect(toObjectName('_build-meta')).not.toBe('_build-meta');
  });
});

describe('FileCacheHandler with keys that sanitize alike', () => {
  let tempDir: string;

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('stores and serves each key separately', async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'object-names-'));
    vi.spyOn(process, 'cwd').mockReturnValue(tempDir);
    const handler = new FileCacheHandler({} as any);
    const page = (html: string) => ({ kind: 'APP_PAGE' as const, html, headers: {} });

    await handler.set('/route-cache/APP_PAGE/h/$/docs/a/b', page('a/b') as any, { tags: [] } as any);
    await handler.set('/route-cache/APP_PAGE/h/$/docs/a_b', page('a_b') as any, { tags: [] } as any);

    expect(((await handler.get('/route-cache/APP_PAGE/h/$/docs/a/b')) as any)?.value?.html).toBe('a/b');
    expect(((await handler.get('/route-cache/APP_PAGE/h/$/docs/a_b')) as any)?.value?.html).toBe('a_b');
    expect(await handler.get('/route-cache/APP_PAGE/h/$/docs/a.b')).toBeNull();
  });

  it('stores and serves a key too long for a file name as it is', async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'object-names-'));
    vi.spyOn(process, 'cwd').mockReturnValue(tempDir);
    const handler = new FileCacheHandler({} as any);
    const key = `/route-cache/APP_PAGE/h/$/blog/${'long-slug-'.repeat(40)}`;

    await handler.set(key, { kind: 'APP_PAGE', html: 'long', headers: {} } as any, { tags: [] } as any);

    expect(((await handler.get(key)) as any)?.value?.html).toBe('long');
  });
});
