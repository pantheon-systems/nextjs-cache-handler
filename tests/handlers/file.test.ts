import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { FileCacheHandler, getSharedCacheStats, clearSharedCache } from '../../src/handlers/file.js';

describe('FileCacheHandler', () => {
  let tempDir: string;
  let originalCwd: string;
  let handler: FileCacheHandler;

  beforeEach(() => {
    // Create a temp directory to simulate the project root
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cache-test-'));

    // Create .next directory structure
    fs.mkdirSync(path.join(tempDir, '.next', 'cache', 'fetch-cache'), { recursive: true });
    fs.mkdirSync(path.join(tempDir, '.next', 'cache', 'route-cache'), { recursive: true });
    fs.mkdirSync(path.join(tempDir, '.next', 'cache', 'tags'), { recursive: true });

    // Mock process.cwd() to return temp dir
    originalCwd = process.cwd();
    vi.spyOn(process, 'cwd').mockReturnValue(tempDir);

    // Create handler
    handler = new FileCacheHandler({} as any);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    // Clean up temp directory
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  describe('constructor', () => {
    it('should create cache directories', () => {
      expect(fs.existsSync(path.join(tempDir, '.next', 'cache', 'fetch-cache'))).toBe(true);
      expect(fs.existsSync(path.join(tempDir, '.next', 'cache', 'route-cache'))).toBe(true);
      expect(fs.existsSync(path.join(tempDir, '.next', 'cache', 'tags'))).toBe(true);
    });

    it('should create empty tags.json file', () => {
      const tagsFile = path.join(tempDir, '.next', 'cache', 'tags', 'tags.json');
      expect(fs.existsSync(tagsFile)).toBe(true);
      const content = JSON.parse(fs.readFileSync(tagsFile, 'utf-8'));
      expect(content).toEqual({});
    });
  });

  describe('get/set operations', () => {
    it('should return null for non-existent cache entry', async () => {
      const result = await handler.get('non-existent-key');
      expect(result).toBeNull();
    });

    it('should store and retrieve fetch cache entry', async () => {
      const cacheValue = { kind: 'FETCH' as const, data: { test: 'data' } };

      await handler.set('fetch-key', cacheValue as any, { tags: ['tag1'] });
      const result = await handler.get('fetch-key', { fetchIdx: 0 } as any);

      expect(result).not.toBeNull();
      expect(result?.value).toEqual(cacheValue);
      expect(result?.tags).toEqual(['tag1']);
    });

    it('should store and retrieve route cache entry', async () => {
      const cacheValue = { kind: 'APP_PAGE' as const, html: '<html></html>' };

      await handler.set('route-key', cacheValue as any, { tags: ['page'] });
      const result = await handler.get('route-key');

      expect(result).not.toBeNull();
      expect(result?.value).toEqual(cacheValue);
    });

    it('should handle Buffer data correctly', async () => {
      const buffer = Buffer.from('test content');
      const cacheValue = { kind: 'APP_PAGE' as const, body: buffer };

      await handler.set('buffer-key', cacheValue as any, { tags: [] });
      const result = await handler.get('buffer-key');

      expect(result).not.toBeNull();
      expect(Buffer.isBuffer((result?.value as any).body)).toBe(true);
      expect((result?.value as any).body.toString()).toBe('test content');
    });

    it('should set lastModified timestamp', async () => {
      const before = Date.now();
      await handler.set('time-key', { kind: 'FETCH' as const } as any, { tags: [] });
      const after = Date.now();

      const result = await handler.get('time-key', { fetchIdx: 0 } as any);

      expect(result?.lastModified).toBeGreaterThanOrEqual(before);
      expect(result?.lastModified).toBeLessThanOrEqual(after);
    });
  });

  describe('tag mapping', () => {
    it('should update tags mapping when setting cache with tags', async () => {
      await handler.set('tagged-key', { kind: 'FETCH' as const } as any, { tags: ['tag1', 'tag2'] });

      // Wait for the buffer to flush (file handler uses 100ms flush interval)
      await new Promise((r) => setTimeout(r, 150));

      const tagsFile = path.join(tempDir, '.next', 'cache', 'tags', 'tags.json');
      const tagsMapping = JSON.parse(fs.readFileSync(tagsFile, 'utf-8'));

      expect(tagsMapping['tag1']).toContain('tagged-key');
      expect(tagsMapping['tag2']).toContain('tagged-key');
    });

    it('should not duplicate keys in tag mapping', async () => {
      await handler.set('key1', { kind: 'FETCH' as const } as any, { tags: ['shared-tag'] });
      await handler.set('key1', { kind: 'FETCH' as const } as any, { tags: ['shared-tag'] });

      // Wait for the buffer to flush
      await new Promise((r) => setTimeout(r, 150));

      const tagsFile = path.join(tempDir, '.next', 'cache', 'tags', 'tags.json');
      const tagsMapping = JSON.parse(fs.readFileSync(tagsFile, 'utf-8'));

      expect(tagsMapping['shared-tag'].filter((k: string) => k === 'key1').length).toBe(1);
    });
  });

  describe('revalidateTag', () => {
    it('should delete cache entries with matching tag', async () => {
      await handler.set('key1', { kind: 'FETCH' as const } as any, { tags: ['posts'] });
      await handler.set('key2', { kind: 'FETCH' as const } as any, { tags: ['posts'] });
      await handler.set('key3', { kind: 'FETCH' as const } as any, { tags: ['other'] });

      await handler.revalidateTag('posts');

      expect(await handler.get('key1', { fetchIdx: 0 } as any)).toBeNull();
      expect(await handler.get('key2', { fetchIdx: 0 } as any)).toBeNull();
      expect(await handler.get('key3', { fetchIdx: 0 } as any)).not.toBeNull();
    });

    it('should update tags mapping after revalidation', async () => {
      await handler.set('key1', { kind: 'FETCH' as const } as any, { tags: ['posts'] });
      await handler.revalidateTag('posts');

      const tagsFile = path.join(tempDir, '.next', 'cache', 'tags', 'tags.json');
      const tagsMapping = JSON.parse(fs.readFileSync(tagsFile, 'utf-8'));

      expect(tagsMapping['posts']).toBeUndefined();
    });

    it('should handle non-existent tag gracefully', async () => {
      await expect(handler.revalidateTag('non-existent')).resolves.not.toThrow();
    });

    it('should handle array of tags', async () => {
      await handler.set('key1', { kind: 'FETCH' as const } as any, { tags: ['tag1'] });
      await handler.set('key2', { kind: 'FETCH' as const } as any, { tags: ['tag2'] });

      await handler.revalidateTag(['tag1', 'tag2'] as any);

      expect(await handler.get('key1', { fetchIdx: 0 } as any)).toBeNull();
      expect(await handler.get('key2', { fetchIdx: 0 } as any)).toBeNull();
    });
  });

  describe('extractTagsFromDataHeaders fallback', () => {
    it('should extract tags from data.headers when ctx.tags is empty (APP_PAGE)', async () => {
      const cacheValue = {
        kind: 'APP_PAGE' as const,
        html: '<html></html>',
        headers: {
          'x-next-cache-tags': '_N_T_/layout,_N_T_/blogs/page,post-123,post-list,term-5',
          'content-type': 'text/html',
        },
      };

      await handler.set('/blogs', cacheValue as any, { tags: [] });

      // Wait for the buffer to flush
      await new Promise((r) => setTimeout(r, 150));

      const tagsFile = path.join(tempDir, '.next', 'cache', 'tags', 'tags.json');
      const tagsMapping = JSON.parse(fs.readFileSync(tagsFile, 'utf-8'));

      expect(tagsMapping['post-123']).toContain('/blogs');
      expect(tagsMapping['post-list']).toContain('/blogs');
      expect(tagsMapping['term-5']).toContain('/blogs');
      expect(tagsMapping['_N_T_/layout']).toContain('/blogs');
      expect(tagsMapping['_N_T_/blogs/page']).toContain('/blogs');
    });

    it('should merge ctx.tags and header tags when both are present', async () => {
      const cacheValue = {
        kind: 'APP_PAGE' as const,
        html: '<html></html>',
        headers: {
          'x-next-cache-tags': 'header-tag-1,header-tag-2',
        },
      };

      await handler.set('/page', cacheValue as any, { tags: ['ctx-tag-1', 'ctx-tag-2'] });

      // Wait for the buffer to flush
      await new Promise((r) => setTimeout(r, 150));

      const tagsFile = path.join(tempDir, '.next', 'cache', 'tags', 'tags.json');
      const tagsMapping = JSON.parse(fs.readFileSync(tagsFile, 'utf-8'));

      // Should have BOTH ctx.tags and header tags
      expect(tagsMapping['ctx-tag-1']).toContain('/page');
      expect(tagsMapping['ctx-tag-2']).toContain('/page');
      expect(tagsMapping['header-tag-1']).toContain('/page');
      expect(tagsMapping['header-tag-2']).toContain('/page');
    });

    it('should deduplicate tags when same tag appears in both ctx and headers', async () => {
      const cacheValue = {
        kind: 'APP_PAGE' as const,
        html: '<html></html>',
        headers: {
          'x-next-cache-tags': 'shared-tag,header-only',
        },
      };

      await handler.set('/dedup-page', cacheValue as any, { tags: ['shared-tag', 'ctx-only'] });

      const result = await handler.get('/dedup-page');
      expect(result).not.toBeNull();

      // Tags should be deduplicated
      const tagCount = result!.tags.filter(t => t === 'shared-tag').length;
      expect(tagCount).toBe(1);

      // All unique tags should be present
      expect(result!.tags).toContain('shared-tag');
      expect(result!.tags).toContain('ctx-only');
      expect(result!.tags).toContain('header-only');
    });

    it('should not extract tags from FETCH entries (no headers)', async () => {
      const cacheValue = {
        kind: 'FETCH' as const,
        data: { test: 'data' },
      };

      await handler.set('fetch-key', cacheValue as any, { tags: [] });

      // Wait for the buffer to flush
      await new Promise((r) => setTimeout(r, 150));

      const tagsFile = path.join(tempDir, '.next', 'cache', 'tags', 'tags.json');
      const tagsMapping = JSON.parse(fs.readFileSync(tagsFile, 'utf-8'));

      // No tags should be stored since both ctx.tags and headers are empty
      expect(Object.keys(tagsMapping).length).toBe(0);
    });

    it('should handle missing x-next-cache-tags header gracefully', async () => {
      const cacheValue = {
        kind: 'APP_PAGE' as const,
        html: '<html></html>',
        headers: {
          'content-type': 'text/html',
          // No x-next-cache-tags header
        },
      };

      await handler.set('/no-tags-page', cacheValue as any, { tags: [] });

      // Wait for the buffer to flush
      await new Promise((r) => setTimeout(r, 150));

      const tagsFile = path.join(tempDir, '.next', 'cache', 'tags', 'tags.json');
      const tagsMapping = JSON.parse(fs.readFileSync(tagsFile, 'utf-8'));

      expect(Object.keys(tagsMapping).length).toBe(0);
    });

    it('should store tags on the cache entry itself when extracted from headers', async () => {
      const cacheValue = {
        kind: 'APP_PAGE' as const,
        html: '<html></html>',
        headers: {
          'x-next-cache-tags': 'post-456,post-list',
        },
      };

      await handler.set('/blogs/my-post', cacheValue as any, { tags: [] });

      const result = await handler.get('/blogs/my-post');
      expect(result).not.toBeNull();
      expect(result?.tags).toEqual(['post-456', 'post-list']);
    });

    it('should enable CDN path purging via tag mapping after header extraction', async () => {
      // Simulate WordPress: blog list page with multiple post tags
      const blogListValue = {
        kind: 'APP_PAGE' as const,
        html: '<html>blog list</html>',
        headers: {
          'x-next-cache-tags': '_N_T_/blogs/page,post-list,post-100,post-200,term-5',
        },
      };

      // Simulate WordPress: individual blog post with specific tags
      const blogPostValue = {
        kind: 'APP_PAGE' as const,
        html: '<html>blog post</html>',
        headers: {
          'x-next-cache-tags': '_N_T_/blogs/[slug]/page,post-100,post-my-post,term-5',
        },
      };

      await handler.set('/blogs', blogListValue as any, { tags: [] });
      await handler.set('/blogs/my-post', blogPostValue as any, { tags: [] });

      // Wait for the buffer to flush
      await new Promise((r) => setTimeout(r, 150));

      const tagsFile = path.join(tempDir, '.next', 'cache', 'tags', 'tags.json');
      const tagsMapping = JSON.parse(fs.readFileSync(tagsFile, 'utf-8'));

      // post-100 should map to BOTH pages
      expect(tagsMapping['post-100']).toContain('/blogs');
      expect(tagsMapping['post-100']).toContain('/blogs/my-post');

      // post-list should only map to /blogs
      expect(tagsMapping['post-list']).toContain('/blogs');
      expect(tagsMapping['post-list']).not.toContain('/blogs/my-post');

      // term-5 should map to both
      expect(tagsMapping['term-5']).toContain('/blogs');
      expect(tagsMapping['term-5']).toContain('/blogs/my-post');

      // Now revalidate post-100 — should delete both pages
      await handler.revalidateTag('post-100');

      expect(await handler.get('/blogs')).toBeNull();
      expect(await handler.get('/blogs/my-post')).toBeNull();
    });
  });

  describe('resetRequestCache', () => {
    it('should not throw', () => {
      expect(() => handler.resetRequestCache()).not.toThrow();
    });
  });
});

describe('getSharedCacheStats', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cache-stats-test-'));
    fs.mkdirSync(path.join(tempDir, '.next', 'cache', 'fetch-cache'), { recursive: true });
    fs.mkdirSync(path.join(tempDir, '.next', 'cache', 'route-cache'), { recursive: true });
    vi.spyOn(process, 'cwd').mockReturnValue(tempDir);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('should return empty stats when no cache entries exist', async () => {
    const stats = await getSharedCacheStats();

    expect(stats.size).toBe(0);
    expect(stats.keys).toEqual([]);
    expect(stats.entries).toEqual([]);
  });

  it('should return stats for existing cache entries', async () => {
    // Create some cache files
    const fetchCacheDir = path.join(tempDir, '.next', 'cache', 'fetch-cache');
    const routeCacheDir = path.join(tempDir, '.next', 'cache', 'route-cache');

    fs.writeFileSync(
      path.join(fetchCacheDir, 'fetch_key.json'),
      JSON.stringify({ tags: ['tag1'], lastModified: 1234567890 })
    );
    fs.writeFileSync(
      path.join(routeCacheDir, 'route_key.json'),
      JSON.stringify({ tags: ['tag2'], lastModified: 1234567891 })
    );

    const stats = await getSharedCacheStats();

    expect(stats.size).toBe(2);
    expect(stats.keys).toContain('fetch:fetch-key');
    expect(stats.keys).toContain('route:route-key');
  });
});

describe('clearSharedCache', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cache-clear-test-'));
    fs.mkdirSync(path.join(tempDir, '.next', 'cache', 'fetch-cache'), { recursive: true });
    fs.mkdirSync(path.join(tempDir, '.next', 'cache', 'route-cache'), { recursive: true });
    fs.mkdirSync(path.join(tempDir, '.next', 'cache', 'tags'), { recursive: true });
    vi.spyOn(process, 'cwd').mockReturnValue(tempDir);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('should clear all cache entries', async () => {
    const fetchCacheDir = path.join(tempDir, '.next', 'cache', 'fetch-cache');
    const routeCacheDir = path.join(tempDir, '.next', 'cache', 'route-cache');

    fs.writeFileSync(path.join(fetchCacheDir, 'key1.json'), '{}');
    fs.writeFileSync(path.join(fetchCacheDir, 'key2.json'), '{}');
    fs.writeFileSync(path.join(routeCacheDir, 'key3.json'), '{}');

    const cleared = await clearSharedCache();

    expect(cleared).toBe(3);
    expect(fs.readdirSync(fetchCacheDir)).toHaveLength(0);
    expect(fs.readdirSync(routeCacheDir)).toHaveLength(0);
  });

  it('should clear tags mapping file', async () => {
    const tagsFile = path.join(tempDir, '.next', 'cache', 'tags', 'tags.json');
    fs.writeFileSync(tagsFile, JSON.stringify({ tag1: ['key1'] }));

    await clearSharedCache();

    expect(fs.existsSync(tagsFile)).toBe(false);
  });

  it('should return 0 when no entries exist', async () => {
    const cleared = await clearSharedCache();
    expect(cleared).toBe(0);
  });
});
