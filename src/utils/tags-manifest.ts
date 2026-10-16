// Namespace import: Next.js 15 has no `areTagsExpired` export, and a named
// import of it would fail to link there.
import * as tagsManifestModule from 'next/dist/server/lib/incremental-cache/tags-manifest.external.js';

/** A tag's revalidation in Next.js 16's tagsManifest format. */
export interface TagRevalidation {
  stale?: number;
  expired?: number;
}

interface TagsManifestExports {
  tagsManifest: Map<string, TagRevalidation | number>;
  // Next.js 16+
  areTagsExpired?: (tags: string[], timestamp: number) => boolean;
  // Next.js 15
  isStale?: (tags: string[], timestamp: number) => boolean;
}

const nextExports: TagsManifestExports = tagsManifestModule as unknown as TagsManifestExports;
const { tagsManifest } = nextExports;

/**
 * Next.js 16 records `{ stale, expired }` per tag; Next.js 15 records a single
 * revalidation timestamp and treats any entry older than it as expired.
 */
const usesTimestamps = typeof nextExports.areTagsExpired !== 'function';

/**
 * Whether Next.js's IncrementalCache checks a fetch entry's tags itself (16+).
 * Next.js 15 leaves that to FileSystemCache.get, which a custom handler replaces.
 */
export const nextChecksFetchTags = !usesTimestamps;

/** The tag's current revalidation, normalized to the Next.js 16 shape. */
export function getTagRevalidation(tag: string): TagRevalidation | undefined {
  const entry = tagsManifest.get(tag);
  return typeof entry === 'number' ? { expired: entry } : entry;
}

/**
 * Record a tag's revalidation in Next.js's process-wide tagsManifest. On
 * Next.js 15 a revalidation is always immediate, so only one timestamp is kept:
 * the latest of `stale` and `expired` that has passed. A soft revalidation from
 * Next.js 16 keeps the tag's earlier `expired` and sets a new `stale`, and its
 * `expired` may still be ahead; either way `stale` marks when it happened.
 * Next.js 15's isStale has no `<= now` guard, so a timestamp still ahead (from
 * an instance whose clock is ahead) is recorded as now.
 */
export function setTagRevalidation(tag: string, revalidation: TagRevalidation): void {
  if (usesTimestamps) {
    const now = Date.now();
    const passed = [revalidation.stale, revalidation.expired].filter(
      (at): at is number => at !== undefined && at <= now
    );
    const timestamp = passed.length > 0 ? Math.max(...passed) : (revalidation.stale ?? revalidation.expired);
    if (timestamp !== undefined) {
      tagsManifest.set(tag, Math.min(timestamp, now));
    }
    return;
  }
  tagsManifest.set(tag, revalidation);
}

/** Whether any of the tags expired after `timestamp`, as Next.js checks it. */
export function areTagsExpired(tags: string[], timestamp: number): boolean {
  if (nextExports.areTagsExpired) {
    return nextExports.areTagsExpired(tags, timestamp);
  }
  return nextExports.isStale?.(tags, timestamp) ?? false;
}
