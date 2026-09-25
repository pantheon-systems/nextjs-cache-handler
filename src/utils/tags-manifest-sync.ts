import { tagsManifest } from 'next/dist/server/lib/incremental-cache/tags-manifest.external.js';

/**
 * Mirrors Next's own `TagManifestEntry` (not exported from
 * `tags-manifest.external.js`, only the `tagsManifest` Map instance is).
 */
export interface TagManifestEntry {
  stale?: number;
  expired?: number;
}

export type TagsManifestRecord = Record<string, TagManifestEntry>;

/**
 * Merges a remote (shared-store) tags-manifest snapshot into the process-local
 * `tagsManifest` Map, keeping whichever value is *more* stale/expired for each
 * tag/field. Never moves a tag backwards towards "fresher" — a slow or
 * out-of-date remote read must never resurrect a tag this process already
 * knows is invalidated, so each field is only ever advanced, not overwritten.
 *
 * This is what makes a `revalidateTag()` call on one replica eventually
 * visible to another: the other replica's own `get()` calls periodically pull
 * this remote snapshot and fold it in here, so Next's `areTagsExpired`/
 * `areTagsStale` (which only ever read the local Map) see the same
 * invalidation the originating replica already applied to its own copy.
 *
 * @returns the number of tags whose local entry actually changed, for logging.
 */
export function mergeRemoteTagsManifest(remote: TagsManifestRecord): number {
  let changed = 0;

  for (const [tag, remoteEntry] of Object.entries(remote)) {
    const localEntry = tagsManifest.get(tag) ?? {};
    const merged: TagManifestEntry = { ...localEntry };

    if (
      remoteEntry.expired !== undefined &&
      (localEntry.expired === undefined || remoteEntry.expired > localEntry.expired)
    ) {
      merged.expired = remoteEntry.expired;
    }
    if (remoteEntry.stale !== undefined && (localEntry.stale === undefined || remoteEntry.stale > localEntry.stale)) {
      merged.stale = remoteEntry.stale;
    }

    if (merged.expired !== localEntry.expired || merged.stale !== localEntry.stale) {
      tagsManifest.set(tag, merged);
      changed++;
    }
  }

  return changed;
}

/**
 * Snapshots the process-local `tagsManifest` Map for the given tags into a
 * plain record suitable for persisting to the shared store.
 */
export function snapshotLocalTagsManifest(tags: string[]): TagsManifestRecord {
  const snapshot: TagsManifestRecord = {};
  for (const tag of tags) {
    const entry = tagsManifest.get(tag);
    if (entry) {
      snapshot[tag] = entry;
    }
  }
  return snapshot;
}

/**
 * How long an entry stays in the shared tags-manifest before
 * {@link pruneTagsManifest} drops it. Override with `CACHE_TAGS_RETENTION_DAYS`.
 *
 * Without pruning this object grows without bound -- every tag ever revalidated
 * stays in it forever, and every replica downloads and merges the whole thing
 * (see `BaseCacheHandler.maybeSyncTagsManifest`). A site with per-entity cache
 * tags accumulates entries for the lifetime of a deploy.
 *
 * WHY THIS RETENTION IS SAFE, and what it depends on: an entry `{tag: {expired: X}}`
 * only ever affects cache entries whose `lastModified <= X` (that's the whole of
 * Next's `areTagsExpired` check). So dropping it can only matter for a stored
 * entry that is already older than the retention window. `clearSharedCache()`
 * wipes the cache entries and this manifest together on every new build, which
 * bounds the age of any stored entry to the time since the last deploy.
 * Retention therefore has to comfortably exceed the longest expected gap
 * between deploys for a site -- 30 days is deliberately far beyond it. If a
 * site could genuinely go longer than the retention without deploying AND still
 * be serving a cache entry written before its tag was invalidated, raise this.
 */
const DEFAULT_RETENTION_DAYS = 30;

/** Resolved retention window in ms. */
export function getTagsManifestRetentionMs(): number {
  const raw = process.env.CACHE_TAGS_RETENTION_DAYS;
  const days = raw === undefined ? DEFAULT_RETENTION_DAYS : Number(raw);
  if (!Number.isFinite(days) || days <= 0) {
    return DEFAULT_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  }
  return days * 24 * 60 * 60 * 1000;
}

/**
 * Drops entries whose most recent timestamp is older than `retentionMs`, so the
 * shared manifest doesn't grow without bound. See {@link getTagsManifestRetentionMs}
 * for why this is safe and what it assumes. Applied on the WRITE path only, so
 * the (much hotter) read/sync path pays nothing for it.
 *
 * Returns a new record; never mutates the input.
 */
export function pruneTagsManifest(
  manifest: TagsManifestRecord,
  retentionMs: number,
  now: number = Date.now()
): { pruned: TagsManifestRecord; dropped: number } {
  const cutoff = now - retentionMs;
  const pruned: TagsManifestRecord = {};
  let dropped = 0;

  for (const [tag, entry] of Object.entries(manifest)) {
    // Keep on the NEWEST of the two fields -- an entry marked stale recently but
    // expired long ago is still live information.
    const newest = Math.max(entry.stale ?? 0, entry.expired ?? 0);
    if (newest >= cutoff) {
      pruned[tag] = entry;
    } else {
      dropped++;
    }
  }

  return { pruned, dropped };
}

/**
 * Merges a local snapshot into a remote record for writing back, keeping
 * whichever value is more stale/expired per field/tag -- same one-directional
 * rule as {@link mergeRemoteTagsManifest}, applied in the write direction so a
 * concurrent writer's update from another replica is never clobbered by an
 * older one that happens to write second.
 */
export function mergeManifestForWrite(remote: TagsManifestRecord, local: TagsManifestRecord): TagsManifestRecord {
  const result: TagsManifestRecord = { ...remote };

  for (const [tag, localEntry] of Object.entries(local)) {
    const remoteEntry = result[tag] ?? {};
    const merged: TagManifestEntry = { ...remoteEntry };

    if (
      localEntry.expired !== undefined &&
      (remoteEntry.expired === undefined || localEntry.expired > remoteEntry.expired)
    ) {
      merged.expired = localEntry.expired;
    }
    if (localEntry.stale !== undefined && (remoteEntry.stale === undefined || localEntry.stale > remoteEntry.stale)) {
      merged.stale = localEntry.stale;
    }

    result[tag] = merged;
  }

  return result;
}
