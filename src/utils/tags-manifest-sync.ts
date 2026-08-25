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

    if (remoteEntry.expired !== undefined && (localEntry.expired === undefined || remoteEntry.expired > localEntry.expired)) {
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

    if (localEntry.expired !== undefined && (remoteEntry.expired === undefined || localEntry.expired > remoteEntry.expired)) {
      merged.expired = localEntry.expired;
    }
    if (localEntry.stale !== undefined && (remoteEntry.stale === undefined || localEntry.stale > remoteEntry.stale)) {
      merged.stale = localEntry.stale;
    }

    result[tag] = merged;
  }

  return result;
}
