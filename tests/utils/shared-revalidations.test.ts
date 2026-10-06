import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { tagsManifest } from 'next/dist/server/lib/incremental-cache/tags-manifest.external.js';
import { SharedRevalidations, resolveTagsRefreshIntervalMs } from '../../src/utils/shared-revalidations.js';
import { FakeBucket } from '../helpers/fake-bucket.js';

const KEY = 'cache/tags/revalidations.json';

// Two stores on one bucket stand in for two instances; tagsManifest is
// cleared before each read so a test sees only what that store applied.
describe('SharedRevalidations', () => {
  let bucket: FakeBucket;
  const store = (config = {}) => new SharedRevalidations(bucket as any, KEY, { refreshIntervalMs: 1000, ...config });

  beforeEach(() => {
    bucket = new FakeBucket();
    tagsManifest.clear();
  });

  afterEach(() => {
    vi.useRealTimers();
    tagsManifest.clear();
  });

  it("applies another instance's revalidation to tagsManifest", async () => {
    await store().record({ posts: { expired: 1000, at: 1000 } });
    tagsManifest.clear();

    await store().refresh();

    expect(tagsManifest.get('posts')).toEqual({ expired: 1000 });
  });

  it('keeps the latest revalidation of a tag, even when it expires sooner', async () => {
    // A soft revalidation with a far expiry, then a hard one: the hard one wins.
    await store().record({ posts: { stale: 1000, expired: 999_999, at: 1000 } });
    await store().record({ posts: { stale: 1000, expired: 2000, at: 2000 } });
    tagsManifest.clear();

    await store().refresh();

    expect(tagsManifest.get('posts')).toEqual({ stale: 1000, expired: 2000 });
  });

  it('merges concurrent writers instead of overwriting', async () => {
    const a = store();
    const b = store();
    await Promise.all([a.record({ posts: { expired: 1, at: 1 } }), b.record({ users: { expired: 2, at: 2 } })]);

    expect(Object.keys(bucket.json(KEY) as object).sort()).toEqual(['posts', 'users']);
  });

  it('reads at most once per interval unless forced', async () => {
    vi.useFakeTimers({ now: 10_000 });
    const reader = store();
    await reader.refresh();
    const recorded = store().record({ posts: { expired: 1, at: 1 } });
    await vi.advanceTimersByTimeAsync(300); // batching window
    await recorded;

    await reader.refresh();
    expect(reader.get('posts')).toBeUndefined();

    await reader.refresh(true);
    expect(reader.get('posts')).toEqual({ expired: 1, at: 1 });
  });

  it('retries a rate-limited write until it is stored', async () => {
    vi.useFakeTimers();
    bucket.failWrites.set(KEY, { code: 429, times: 2 });

    const recorded = store().record({ posts: { expired: 1, at: 1 } });
    await vi.runAllTimersAsync();

    expect(await recorded).toBe(true);
    expect(bucket.json(KEY)).toEqual({ posts: { expired: 1, at: 1 } });
  });

  it('gives up after the timeout and stores the entry on a later refresh', async () => {
    vi.useFakeTimers();
    bucket.failWrites.set(KEY, { code: 503, times: 1_000 });
    const writer = store({ recordTimeoutMs: 3000 });

    const recorded = writer.record({ posts: { expired: 1, at: 1 } });
    await vi.runAllTimersAsync();
    expect(await recorded).toBe(false);
    // Still applied locally.
    expect(tagsManifest.get('posts')).toEqual({ expired: 1 });

    bucket.failWrites.delete(KEY);
    await writer.refresh(true);
    await vi.runAllTimersAsync();
    expect(bucket.json(KEY)).toEqual({ posts: { expired: 1, at: 1 } });
  });

  it('runs whenStored callbacks once a delayed write lands', async () => {
    vi.useFakeTimers();
    bucket.failWrites.set(KEY, { code: 503, times: 1_000 });
    const writer = store({ recordTimeoutMs: 2000 });
    const recorded = writer.record({ posts: { expired: 1, at: 1 } });
    await vi.runAllTimersAsync();
    expect(await recorded).toBe(false);

    const onStored = vi.fn();
    writer.whenStored(['posts'], onStored);
    expect(onStored).not.toHaveBeenCalled();

    bucket.failWrites.delete(KEY);
    await writer.refresh(true);
    await vi.runAllTimersAsync();
    expect(onStored).toHaveBeenCalledOnce();
  });

  it('runs whenStored callbacks at once for tags already stored', () => {
    const onStored = vi.fn();
    store().whenStored(['posts'], onStored);
    expect(onStored).toHaveBeenCalledOnce();
  });

  it('ignores malformed stored entries and overwrites them', async () => {
    bucket.putJson(KEY, { posts: ['not', 'a', 'revalidation'], users: { expired: 5 } });
    tagsManifest.set('posts', { expired: 9 });

    await store().refresh();
    expect(tagsManifest.get('posts')).toEqual({ expired: 9 });

    await store().record({ posts: { expired: 10, at: 10 } });
    expect((bucket.json(KEY) as Record<string, unknown>).posts).toEqual({ expired: 10, at: 10 });
  });

  it('stores revalidations an earlier write gave up on at shutdown', async () => {
    vi.useFakeTimers();
    const { getSharedRevalidations, flushSharedRevalidations, resetSharedRevalidationsForTests } =
      await import('../../src/utils/shared-revalidations.js');
    resetSharedRevalidationsForTests();
    bucket.failWrites.set(KEY, { code: 503, times: 1_000 });
    const writer = getSharedRevalidations('test-bucket', bucket as any, KEY);
    const recorded = writer.record({ posts: { expired: 1, at: 1 } });
    await vi.runAllTimersAsync();
    expect(await recorded).toBe(false);

    bucket.failWrites.delete(KEY);
    const flushed = flushSharedRevalidations(8000);
    await vi.runAllTimersAsync();
    expect(await flushed).toBe(true);
    expect(bucket.json(KEY)).toEqual({ posts: { expired: 1, at: 1 } });
    resetSharedRevalidationsForTests();
  });

  describe('prune', () => {
    beforeEach(() => {
      bucket.putJson(KEY, {
        old: { expired: 100, at: 100 },
        recent: { expired: 300, at: 300 },
        broken: ['not a revalidation'],
      });
    });

    it('removes revalidations older than the cutoff after beforeRemove has run', async () => {
      const seen: unknown[] = [];
      const removed = await store().prune(200, async (tags) => {
        seen.push(tags.sort(), Object.keys(bucket.json(KEY) as object).sort());
      });

      expect(removed).toBe(2);
      // beforeRemove got the stale tags while they were still stored.
      expect(seen).toEqual([
        ['broken', 'old'],
        ['broken', 'old', 'recent'],
      ]);
      expect(bucket.json(KEY)).toEqual({ recent: { expired: 300, at: 300 } });
    });

    it('removes nothing when beforeRemove fails', async () => {
      await expect(
        store().prune(200, async () => {
          throw new Error('fetch cache unavailable');
        })
      ).rejects.toThrow('fetch cache unavailable');

      expect(Object.keys(bucket.json(KEY) as object).sort()).toEqual(['broken', 'old', 'recent']);
    });

    it('keeps a tag revalidated again while pruning', async () => {
      await store().prune(200, async () => {
        bucket.putJson(KEY, { ...(bucket.json(KEY) as object), old: { expired: 400, at: 400 } });
      });

      expect(bucket.json(KEY)).toEqual({ old: { expired: 400, at: 400 }, recent: { expired: 300, at: 300 } });
    });

    it('removes only malformed entries when nothing is older than the cutoff', async () => {
      const beforeRemove = vi.fn();
      expect(await store().prune(50, beforeRemove)).toBe(1);
      expect(beforeRemove).toHaveBeenCalledWith(['broken']);
      expect(Object.keys(bucket.json(KEY) as object).sort()).toEqual(['old', 'recent']);
    });

    it('does nothing when every entry is newer than the cutoff', async () => {
      bucket.putJson(KEY, { recent: { expired: 300, at: 300 } });
      const beforeRemove = vi.fn();
      expect(await store().prune(50, beforeRemove)).toBe(0);
      expect(beforeRemove).not.toHaveBeenCalled();
    });
  });

  it('reads CACHE_TAGS_REFRESH_INTERVAL_MS', () => {
    expect(resolveTagsRefreshIntervalMs('')).toBe(1000);
    expect(resolveTagsRefreshIntervalMs('250')).toBe(250);
    expect(resolveTagsRefreshIntervalMs('10')).toBe(100);
    expect(resolveTagsRefreshIntervalMs('nope')).toBe(1000);
  });
});
