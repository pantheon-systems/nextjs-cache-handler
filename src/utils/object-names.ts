import { createHash } from 'crypto';

const UNSAFE = /[^a-zA-Z0-9-]/;

/**
 * Storage name (GCS object or file, without prefix or `.json`) for a cache key.
 * A key of only `[a-zA-Z0-9-]` (fetch and image keys) is its own name. Any other
 * key is sanitized and suffixed with a hash of the full key, so keys that sanitize
 * alike (`/docs/a/b`, `/docs/a_b`) get different names; a sanitized name always
 * contains `_`, so it never equals an unsuffixed one.
 */
export function toObjectName(cacheKey: string): string {
  if (!UNSAFE.test(cacheKey)) {
    return cacheKey;
  }
  const safe = cacheKey.replace(new RegExp(UNSAFE, 'g'), '_');
  return `${safe}-${createHash('sha256').update(cacheKey).digest('hex').slice(0, 16)}`;
}
