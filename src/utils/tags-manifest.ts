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

/** The tag's current revalidation, normalized to the Next.js 16 shape. */
export function getTagRevalidation(tag: string): TagRevalidation | undefined {
  const entry = tagsManifest.get(tag);
  return typeof entry === 'number' ? { expired: entry } : entry;
}

/**
 * Record a tag's revalidation in Next.js's process-wide tagsManifest. On
 * Next.js 15 a revalidation is always immediate, so only one timestamp is kept.
 */
export function setTagRevalidation(tag: string, revalidation: TagRevalidation): void {
  if (usesTimestamps) {
    const timestamp = revalidation.expired ?? revalidation.stale;
    if (timestamp !== undefined) {
      tagsManifest.set(tag, timestamp);
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
