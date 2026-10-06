import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { loadBuildPrerenderTags, resetBuildPrerenderTagsForTests } from '../../src/utils/build-prerender-tags.js';
import { writeBuildOutput } from '../helpers/build-output.js';

describe('loadBuildPrerenderTags', () => {
  let tempDir: string;
  let serverDistDir: string;

  beforeEach(() => {
    resetBuildPrerenderTagsForTests();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'build-tags-'));
    serverDistDir = path.join(tempDir, '.next', 'server');
    fs.mkdirSync(serverDistDir, { recursive: true });
  });

  afterEach(() => {
    resetBuildPrerenderTagsForTests();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('indexes tags from app .meta files under the runtime cache key', async () => {
    writeBuildOutput(serverDistDir, {
      '/': { key: 'index', tags: ['_N_T_/layout', '_N_T_/page', '_N_T_/', '_N_T_/index'] },
      '/tags': { key: 'tags', tags: ['_N_T_/layout', '_N_T_/tags', 'stations'] },
      '/isr-fallback/europe/london': {
        key: 'isr-fallback/europe/london',
        tags: ['_N_T_/isr-fallback/europe/london', 'stations'],
      },
    });

    const mapping = await loadBuildPrerenderTags(serverDistDir);

    expect(mapping['_N_T_/']).toEqual(['/index']);
    expect(mapping['_N_T_/layout'].sort()).toEqual(['/index', '/tags']);
    expect(mapping['stations'].sort()).toEqual(['/isr-fallback/europe/london', '/tags']);
  });

  it('applies normalizePagePath to a page at /index', async () => {
    writeBuildOutput(serverDistDir, { '/index': { key: 'index/index', tags: ['_N_T_/index'] } });

    expect((await loadBuildPrerenderTags(serverDistDir))['_N_T_/index']).toEqual(['/index/index']);
  });

  it('skips Pages Router prerenders, whose .meta carries no tags', async () => {
    writeBuildOutput(serverDistDir, { '/pages-isr/london': { key: 'pages-isr/london', router: 'pages' } });

    expect(await loadBuildPrerenderTags(serverDistDir)).toEqual({});
  });

  it('returns an empty index without a build output', async () => {
    expect(await loadBuildPrerenderTags(serverDistDir)).toEqual({});
    expect(await loadBuildPrerenderTags(undefined)).toEqual({});
  });

  it('reads the build output once per process', async () => {
    writeBuildOutput(serverDistDir, { '/a': { key: 'a', tags: ['t'] } });
    const first = await loadBuildPrerenderTags(serverDistDir);
    fs.rmSync(path.join(serverDistDir, '..', 'prerender-manifest.json'));

    expect(await loadBuildPrerenderTags(serverDistDir)).toBe(first);
  });
});
