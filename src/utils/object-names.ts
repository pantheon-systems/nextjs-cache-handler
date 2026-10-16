import { createHash } from 'crypto';

const UNSAFE = /[^a-zA-Z0-9-]/;

// Most file systems cap a file name at 255 bytes, `.json` included. GCS allows
// 1024 bytes, prefix included. Names are ASCII, so length is bytes.
const MAX_NAME_LENGTH = 200;
const HASH_LENGTH = 16;

/**
 * Storage name (GCS object or file, without prefix or `.json`) for a cache key.
 * A key of only `[a-zA-Z0-9-]` (fetch and image keys) up to MAX_NAME_LENGTH is
 * its own name. Any other key is sanitized, cut to fit, and suffixed with `_`
 * and a hash of the full key, so keys that sanitize or cut alike (`/docs/a/b`,
 * `/docs/a_b`) get different names; a hashed name always contains `_`, so it
 * never equals an unhashed one.
 */
export function toObjectName(cacheKey: string): string {
  if (!UNSAFE.test(cacheKey) && cacheKey.length <= MAX_NAME_LENGTH) {
    return cacheKey;
  }
  const safe = cacheKey.replace(new RegExp(UNSAFE, 'g'), '_').slice(0, MAX_NAME_LENGTH - HASH_LENGTH - 1);
  return `${safe}_${createHash('sha256').update(cacheKey).digest('hex').slice(0, HASH_LENGTH)}`;
}
