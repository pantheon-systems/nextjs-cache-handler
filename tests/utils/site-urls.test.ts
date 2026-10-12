import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  loadSiteUrlConfig,
  pagesDataRoute,
  resetSiteUrlConfigForTests,
  toPublicPath,
  type SiteUrlConfig,
} from '../../src/utils/site-urls.js';

const site = (config: Partial<SiteUrlConfig> = {}): SiteUrlConfig => ({
  basePath: '',
  trailingSlash: false,
  buildId: 'build-1',
  ...config,
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
    });
  });

  it('falls back to plain paths without a build output', () => {
    expect(loadSiteUrlConfig(path.join(distDir, 'server'))).toEqual({
      basePath: '',
      trailingSlash: false,
      buildId: null,
    });
  });
});
