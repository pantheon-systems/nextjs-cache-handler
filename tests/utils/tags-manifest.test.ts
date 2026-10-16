import { describe, it, expect, afterEach } from 'vitest';
import * as nextTagsManifest from 'next/dist/server/lib/incremental-cache/tags-manifest.external.js';
import { areTagsExpired, getTagRevalidation, setTagRevalidation } from '../../src/utils/tags-manifest.js';
import { nextMajor } from '../helpers/next-version.js';

// Next's own exports, which differ by major version.
const next = nextTagsManifest as unknown as {
  tagsManifest: Map<string, unknown>;
  areTagsExpired?: (tags: string[], timestamp: number) => boolean;
  areTagsStale?: (tags: string[], timestamp: number) => boolean;
  isStale?: (tags: string[], timestamp: number) => boolean;
};

describe('tags-manifest compatibility', () => {
  afterEach(() => {
    next.tagsManifest.clear();
  });

  it('reads back what it records, normalized to { stale, expired }', () => {
    const now = Date.now();
    setTagRevalidation('posts', { expired: now });

    expect(getTagRevalidation('posts')).toEqual({ expired: now });
    expect(getTagRevalidation('untouched')).toBeUndefined();
  });

  it('reports a tag expired after an entry was written, and not before', () => {
    const now = Date.now();
    setTagRevalidation('posts', { expired: now });

    expect(areTagsExpired(['posts'], now - 1000)).toBe(true);
    expect(areTagsExpired(['posts'], now + 1000)).toBe(false);
    expect(areTagsExpired(['comments'], now - 1000)).toBe(false);
  });

  describe.runIf(nextMajor >= 16)('on Next.js 16', () => {
    it("records { stale, expired }, which Next's own checks read", () => {
      const now = Date.now();
      setTagRevalidation('posts', { stale: now, expired: now + 60_000 });

      expect(next.tagsManifest.get('posts')).toEqual({ stale: now, expired: now + 60_000 });
      expect(next.areTagsStale?.(['posts'], now - 1000)).toBe(true);
      expect(next.areTagsExpired?.(['posts'], now - 1000)).toBe(false);
    });
  });

  describe.runIf(nextMajor === 15)('on Next.js 15', () => {
    it("records the expiry as a timestamp, which Next's own isStale reads", () => {
      const now = Date.now();
      setTagRevalidation('posts', { expired: now });

      expect(next.tagsManifest.get('posts')).toBe(now);
      expect(next.isStale?.(['posts'], now - 1000)).toBe(true);
    });

    it('falls back to the stale time when no expiry is given', () => {
      const now = Date.now();
      setTagRevalidation('posts', { stale: now });

      expect(next.tagsManifest.get('posts')).toBe(now);
    });
  });
});
