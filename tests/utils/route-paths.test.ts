import { describe, it, expect } from 'vitest';
import {
  cacheKeyToPurgePath,
  denormalizePagePath,
  implicitTagsToPurgePaths,
  isDynamicRoutePath,
} from '../../src/utils/route-paths.js';

describe('denormalizePagePath', () => {
  // Mirrors next/src/shared/lib/page-path/denormalize-page-path.ts.
  it.each([
    ['/index', '/'],
    ['/index/foo', '/foo'],
    ['/index/index', '/index'],
    ['/about', '/about'],
    ['/index/[slug]', '/index/[slug]'],
  ])('%s -> %s', (input, expected) => {
    expect(denormalizePagePath(input)).toBe(expected);
  });
});

describe('isDynamicRoutePath', () => {
  it('detects [param], [...rest] and [[...opt]] segments', () => {
    expect(isDynamicRoutePath('/prefix/c/[two]')).toBe(true);
    expect(isDynamicRoutePath('/docs/[...slug]')).toBe(true);
    expect(isDynamicRoutePath('/docs/[[...slug]]')).toBe(true);
    expect(isDynamicRoutePath('/docs/intro')).toBe(false);
  });
});

describe('cacheKeyToPurgePath', () => {
  it('maps the root page key /index to /', () => {
    expect(cacheKeyToPurgePath('/index')).toBe('/');
  });

  it('keeps ordinary route keys, including Pages Router ISR keys', () => {
    expect(cacheKeyToPurgePath('/blog/post-1')).toBe('/blog/post-1');
    expect(cacheKeyToPurgePath('/pages-isr/london')).toBe('/pages-isr/london');
  });

  it('skips partial-fallback shell keys, which match no URL', () => {
    expect(cacheKeyToPurgePath('/prefix/c/[two]')).toBeNull();
    expect(cacheKeyToPurgePath('/isr-fallback/europe/[station]')).toBeNull();
  });

  describe('Next 16.3.8+ namespaced keys', () => {
    // Shapes taken from a Next 16.3.8 build's `.meta` routeCache.key values.
    const hash = 'c6377dd9ce6a1c2cd100eb4344e843eb4639b9ed26f84643f77680e9eb454c4b';

    it('maps the root page to /', () => {
      expect(cacheKeyToPurgePath(`/route-cache/APP_PAGE/${hash}/$/index`)).toBe('/');
    });

    it('maps App Router, route handler and Pages Router keys to their paths', () => {
      expect(cacheKeyToPurgePath(`/route-cache/APP_PAGE/${hash}/$/isr-fallback/europe/london`)).toBe(
        '/isr-fallback/europe/london'
      );
      expect(cacheKeyToPurgePath(`/route-cache/APP_ROUTE/${hash}/$/api/prerendered-probe`)).toBe(
        '/api/prerendered-probe'
      );
      expect(cacheKeyToPurgePath(`/route-cache/PAGES/${hash}/$/pages-isr/london`)).toBe('/pages-isr/london');
    });

    it('skips shell keys', () => {
      expect(cacheKeyToPurgePath(`/route-cache/APP_PAGE/${hash}/$/isr-fallback/europe/[station]`)).toBeNull();
    });

    it('skips a malformed key', () => {
      expect(cacheKeyToPurgePath(`/route-cache/APP_PAGE/${hash}`)).toBeNull();
    });
  });

  it('skips non-route keys (fetch cache keys are hashes)', () => {
    expect(cacheKeyToPurgePath('a3f1c9e0d2b4')).toBeNull();
    // Route keys always start with `/` (normalizePagePath); `_` keys are not routes.
    expect(cacheKeyToPurgePath('_blogs_my-post')).toBeNull();
  });
});

describe('implicitTagsToPurgePaths', () => {
  it("maps revalidatePath('/') tags to /", () => {
    expect(implicitTagsToPurgePaths(['_N_T_/', '_N_T_/index'])).toEqual({ paths: ['/'], purgeAll: false });
  });

  it('maps a pathname tag to its path', () => {
    expect(implicitTagsToPurgePaths(['_N_T_/blog/post-1']).paths).toEqual(['/blog/post-1']);
  });

  it("uses the path from revalidatePath's type form", () => {
    expect(implicitTagsToPurgePaths(['_N_T_/about/page']).paths).toEqual(['/about']);
    expect(implicitTagsToPurgePaths(['_N_T_/blog/layout']).paths).toEqual(['/blog']);
    expect(implicitTagsToPurgePaths(['_N_T_/page']).paths).toEqual(['/']);
  });

  it("flags revalidatePath('/', 'layout') as affecting every page", () => {
    expect(implicitTagsToPurgePaths(['_N_T_/layout'])).toEqual({ paths: [], purgeAll: true });
  });

  it('skips dynamic route patterns', () => {
    expect(implicitTagsToPurgePaths(['_N_T_/blog/[slug]/page', '_N_T_/blog/[slug]']).paths).toEqual([]);
  });

  it('decodes percent-encoded tags (encodeHeaderSafe)', () => {
    expect(implicitTagsToPurgePaths([`_N_T_/${encodeURIComponent('café')}`]).paths).toEqual(['/café']);
  });

  it('ignores user tags', () => {
    expect(implicitTagsToPurgePaths(['posts', 'stations:london'])).toEqual({ paths: [], purgeAll: false });
  });
});
