import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  loadSiteUrlConfig,
  pagesDataRoute,
  resetSiteUrlConfigForTests,
  toPublicPath,
  withoutDefaultLocale,
  withServedTrailingSlash,
  type SiteUrlConfig,
} from '../../src/utils/site-urls.js';

const site = (config: Partial<SiteUrlConfig> = {}): SiteUrlConfig => ({
  basePath: '',
  trailingSlash: false,
  buildId: 'build-1',
  defaultLocales: [],
  ...config,
});

describe('withServedTrailingSlash', () => {
  it('drops the slash without trailingSlash', () => {
    expect(withServedTrailingSlash('/about/', false)).toBe('/about');
    expect(withServedTrailingSlash('/about', false)).toBe('/about');
    expect(withServedTrailingSlash('/', false)).toBe('/');
  });

  it('adds the slash with trailingSlash, except where Next does not', () => {
    expect(withServedTrailingSlash('/about', true)).toBe('/about/');
    expect(withServedTrailingSlash('/about/', true)).toBe('/about/');
    expect(withServedTrailingSlash('/', true)).toBe('/');
    expect(withServedTrailingSlash('/sitemap.xml', true)).toBe('/sitemap.xml');
    expect(withServedTrailingSlash('/.well-known/security', true)).toBe('/.well-known/security');
  });

  it('leaves an empty path empty', () => {
    expect(withServedTrailingSlash('', true)).toBe('');
  });

  it('places the slash before a query string or fragment', () => {
    expect(withServedTrailingSlash('/about?x=1', true)).toBe('/about/?x=1');
    expect(withServedTrailingSlash('/about/?x=1', true)).toBe('/about/?x=1');
    expect(withServedTrailingSlash('/about#top', true)).toBe('/about/#top');
    expect(withServedTrailingSlash('/about/?x=1', false)).toBe('/about?x=1');
    expect(withServedTrailingSlash('/sitemap.xml?v=2', true)).toBe('/sitemap.xml?v=2');
    expect(withServedTrailingSlash('/?x=1', true)).toBe('/?x=1');
  });
});

describe('withoutDefaultLocale', () => {
  const i18n = site({ defaultLocales: ['en', 'fr'] });

  it('strips a default locale prefix', () => {
    expect(withoutDefaultLocale('/en/blog', i18n)).toBe('/blog');
    expect(withoutDefaultLocale('/fr/blog/post', i18n)).toBe('/blog/post');
    expect(withoutDefaultLocale('/en', i18n)).toBe('/');
  });

  it('returns null for other locales and paths', () => {
    expect(withoutDefaultLocale('/de/blog', i18n)).toBeNull();
    expect(withoutDefaultLocale('/english/blog', i18n)).toBeNull();
    expect(withoutDefaultLocale('/', i18n)).toBeNull();
    expect(withoutDefaultLocale('/en/blog', site())).toBeNull();
  });
});

describe('toPublicPath', () => {
  it('leaves paths alone by default', () => {
    expect(toPublicPath('/tags', site())).toBe('/tags');
    expect(toPublicPath('/', site())).toBe('/');
  });

  describe('with trailingSlash', () => {
    const ts = site({ trailingSlash: true });

    it('adds the slash Next redirects to', () => {
      expect(toPublicPath('/tags', ts)).toBe('/tags/');
      expect(toPublicPath('/isr-fallback/europe/london', ts)).toBe('/isr-fallback/europe/london/');
      expect(toPublicPath('/', ts)).toBe('/');
    });

    it('leaves files and /.well-known alone, as Next does', () => {
      expect(toPublicPath('/sitemap.xml', ts)).toBe('/sitemap.xml');
      expect(toPublicPath('/docs/v1.2', ts)).toBe('/docs/v1.2');
      expect(toPublicPath('/.well-known/security', ts)).toBe('/.well-known/security');
    });
  });

  it('prefixes basePath, including at the root', () => {
    expect(toPublicPath('/tags', site({ basePath: '/docs' }))).toBe('/docs/tags');
    expect(toPublicPath('/', site({ basePath: '/docs' }))).toBe('/docs');
    expect(toPublicPath('/', site({ basePath: '/docs', trailingSlash: true }))).toBe('/docs/');
    expect(toPublicPath('/tags', site({ basePath: '/docs', trailingSlash: true }))).toBe('/docs/tags/');
  });
});

describe('pagesDataRoute', () => {
  it('builds the data route a client-side navigation fetches', () => {
    expect(pagesDataRoute('/pages-isr/london', site())).toBe('/_next/data/build-1/pages-isr/london.json');
    expect(pagesDataRoute('/', site())).toBe('/_next/data/build-1/index.json');
    expect(pagesDataRoute('/en/blog', site({ basePath: '/docs' }))).toBe('/docs/_next/data/build-1/en/blog.json');
  });

  it('prefixes /index on pages under /index, as Next does', () => {
    expect(pagesDataRoute('/index/foo', site())).toBe('/_next/data/build-1/index/index/foo.json');
    expect(pagesDataRoute('/index', site())).toBe('/_next/data/build-1/index/index.json');
    expect(pagesDataRoute('/indexes', site())).toBe('/_next/data/build-1/indexes.json');
  });

  it('returns null without a build ID', () => {
    expect(pagesDataRoute('/x', site({ buildId: null }))).toBeNull();
  });
});

describe('loadSiteUrlConfig', () => {
  let distDir: string;

  beforeEach(() => {
    resetSiteUrlConfigForTests();
    distDir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'site-urls-')), '.next');
    fs.mkdirSync(path.join(distDir, 'server'), { recursive: true });
  });

  afterEach(() => {
    resetSiteUrlConfigForTests();
    fs.rmSync(path.dirname(distDir), { recursive: true, force: true });
  });

  it('reads basePath, trailingSlash and the build ID from the build output', () => {
    fs.writeFileSync(
      path.join(distDir, 'required-server-files.json'),
      JSON.stringify({ config: { basePath: '/docs', trailingSlash: true } })
    );
    fs.writeFileSync(path.join(distDir, 'BUILD_ID'), 'build-TfctsWXpff2fKS\n');

    expect(loadSiteUrlConfig(path.join(distDir, 'server'))).toEqual({
      basePath: '/docs',
      trailingSlash: true,
      buildId: 'build-TfctsWXpff2fKS',
      defaultLocales: [],
    });
  });

  it('reads the default locales, including per-domain ones', () => {
    fs.writeFileSync(
      path.join(distDir, 'required-server-files.json'),
      JSON.stringify({
        config: {
          i18n: {
            locales: ['en', 'fr', 'nl'],
            defaultLocale: 'en',
            domains: [
              { domain: 'example.fr', defaultLocale: 'fr' },
              { domain: 'example.com', defaultLocale: 'en' },
            ],
          },
        },
      })
    );

    expect(loadSiteUrlConfig(path.join(distDir, 'server')).defaultLocales).toEqual(['en', 'fr']);
  });

  it.each([
    ['a non-string defaultLocale', { defaultLocale: 42 }],
    ['an empty defaultLocale', { defaultLocale: '' }],
    ['a null i18n', null],
    ['domains that are not an array', { domains: { defaultLocale: 'fr' } }],
    ['domains without usable defaults', { domains: [null, 'fr', {}, { defaultLocale: ['fr'] }] }],
  ])('ignores %s', (_, i18n) => {
    fs.writeFileSync(path.join(distDir, 'required-server-files.json'), JSON.stringify({ config: { i18n } }));

    expect(loadSiteUrlConfig(path.join(distDir, 'server')).defaultLocales).toEqual([]);
  });

  it('keeps usable default locales next to malformed ones', () => {
    fs.writeFileSync(
      path.join(distDir, 'required-server-files.json'),
      JSON.stringify({
        config: { i18n: { defaultLocale: 'en', domains: [null, { defaultLocale: 7 }, { defaultLocale: 'fr' }] } },
      })
    );

    expect(loadSiteUrlConfig(path.join(distDir, 'server')).defaultLocales).toEqual(['en', 'fr']);
  });

  it('falls back to plain paths when required-server-files.json is not JSON', () => {
    fs.writeFileSync(path.join(distDir, 'required-server-files.json'), '{"config": {"basePath": "/docs"');
    fs.writeFileSync(path.join(distDir, 'BUILD_ID'), 'build-1\n');

    expect(loadSiteUrlConfig(path.join(distDir, 'server'))).toEqual({
      basePath: '',
      trailingSlash: false,
      buildId: 'build-1',
      defaultLocales: [],
    });
  });

  it('falls back to plain paths without a build output', () => {
    expect(loadSiteUrlConfig(path.join(distDir, 'server'))).toEqual({
      basePath: '',
      trailingSlash: false,
      buildId: null,
      defaultLocales: [],
    });
  });
});
