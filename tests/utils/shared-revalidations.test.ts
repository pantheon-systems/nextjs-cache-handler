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
    await store().record({ posts: { expired: 1, at: 1 } });

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

  it('reads CACHE_TAGS_REFRESH_INTERVAL_MS', () => {
    expect(resolveTagsRefreshIntervalMs(undefined)).toBe(1000);
    expect(resolveTagsRefreshIntervalMs('250')).toBe(250);
    expect(resolveTagsRefreshIntervalMs('10')).toBe(100);
    expect(resolveTagsRefreshIntervalMs('nope')).toBe(1000);
  });
});
