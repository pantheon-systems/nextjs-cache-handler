import { describe, it, expect, afterEach } from 'vitest';
import { tagsManifest } from 'next/dist/server/lib/incremental-cache/tags-manifest.external.js';
import {
  mergeRemoteTagsManifest,
  mergeManifestForWrite,
  snapshotLocalTagsManifest,
} from '../../src/utils/tags-manifest-sync.js';

describe('mergeRemoteTagsManifest', () => {
  afterEach(() => {
    tagsManifest.clear();
  });

  it('applies a remote entry for a tag the local process has never seen', () => {
    const changed = mergeRemoteTagsManifest({ 'remote-only': { expired: 1000 } });

    expect(changed).toBe(1);
    expect(tagsManifest.get('remote-only')).toEqual({ expired: 1000 });
  });

  it('advances a local entry when the remote expiry is later', () => {
    tagsManifest.set('shared-tag', { expired: 1000 });

    const changed = mergeRemoteTagsManifest({ 'shared-tag': { expired: 2000 } });

    expect(changed).toBe(1);
    expect(tagsManifest.get('shared-tag')?.expired).toBe(2000);
  });

  it('never moves a local entry backwards -- this is the core cross-replica-safety property', () => {
    // Simulates: THIS process already revalidated the tag locally (e.g. via
    // its own revalidateTag() call), but the remote snapshot it just pulled
    // predates that -- a slow/stale read must not resurrect the tag.
    tagsManifest.set('already-invalidated', { expired: 5000 });

    const changed = mergeRemoteTagsManifest({ 'already-invalidated': { expired: 1000 } });

    expect(changed).toBe(0);
    expect(tagsManifest.get('already-invalidated')?.expired).toBe(5000);
  });

  it('merges stale and expired independently per tag', () => {
    tagsManifest.set('mixed', { stale: 100 });

    mergeRemoteTagsManifest({ mixed: { stale: 50, expired: 200 } });

    // stale: remote (50) is not later than local (100) -- unchanged.
    // expired: local had none -- remote's value is applied.
    expect(tagsManifest.get('mixed')).toEqual({ stale: 100, expired: 200 });
  });

  it('reports 0 changed tags when nothing advances', () => {
    tagsManifest.set('steady', { expired: 1000 });

    const changed = mergeRemoteTagsManifest({ steady: { expired: 1000 } });

    expect(changed).toBe(0);
  });

  it('handles an empty remote snapshot without error', () => {
    expect(mergeRemoteTagsManifest({})).toBe(0);
  });
});

describe('snapshotLocalTagsManifest', () => {
  afterEach(() => {
    tagsManifest.clear();
  });

  it('captures only the requested tags that exist locally', () => {
    tagsManifest.set('a', { expired: 1 });
    tagsManifest.set('b', { expired: 2 });
    tagsManifest.set('c', { expired: 3 });

    expect(snapshotLocalTagsManifest(['a', 'c', 'missing'])).toEqual({
      a: { expired: 1 },
      c: { expired: 3 },
    });
  });

  it('returns an empty record when none of the requested tags exist', () => {
    expect(snapshotLocalTagsManifest(['nope'])).toEqual({});
  });
});

describe('mergeManifestForWrite', () => {
  it('adds local-only tags to the remote record', () => {
    const result = mergeManifestForWrite({}, { 'new-tag': { expired: 1000 } });
    expect(result['new-tag']).toEqual({ expired: 1000 });
  });

  it('keeps the remote value when it is more stale than the local one being written', () => {
    // Simulates a concurrent writer on another replica having already
    // written a later expiry -- this write must not clobber it with an
    // older value just because it happens to run second.
    const result = mergeManifestForWrite({ tag: { expired: 5000 } }, { tag: { expired: 1000 } });
    expect(result.tag.expired).toBe(5000);
  });

  it('advances the remote value when the local one being written is later', () => {
    const result = mergeManifestForWrite({ tag: { expired: 1000 } }, { tag: { expired: 5000 } });
    expect(result.tag.expired).toBe(5000);
  });

  it('preserves unrelated remote tags untouched', () => {
    const result = mergeManifestForWrite({ untouched: { expired: 42 } }, { other: { expired: 7 } });
    expect(result.untouched).toEqual({ expired: 42 });
    expect(result.other).toEqual({ expired: 7 });
  });
});
