import { Storage, RETRYABLE_ERR_FN_DEFAULT, type ApiError, type Bucket } from '@google-cloud/storage';
import { createLogger } from './logger.js';

/**
 * Small JSON objects (tag maps, build meta) that several processes rewrite.
 * Reads return the object generation; writes pass it back as an
 * `ifGenerationMatch` precondition so concurrent writers get a 412 instead of
 * silently overwriting each other.
 */

const log = createLogger('GcsJsonObject');

export interface JsonObjectSnapshot<T> {
  /** Parsed object, or null when the object does not exist (or is unparseable). */
  value: T | null;
  /** Object generation the value was read at; 0 when the object does not exist. */
  generation: string | number;
}

/**
 * What a client writes: `entries` (cache entries, build meta; unconditional) or
 * `tags` (tag maps; `ifGenerationMatch` only). Kept on separate clients because
 * an unconditional `save()` flips the client's shared `autoRetry` to false, which
 * would strip retries from concurrent conditional writes.
 */
export type StoragePurpose = 'entries' | 'tags';

const storageClients = new Map<string, Storage>();

/** One Storage client per bucket and purpose per process; Next.js builds a handler per request. */
export function getSharedStorage(bucketName: string, purpose: StoragePurpose): Storage {
  const key = `${purpose}:${bucketName}`;
  let storage = storageClients.get(key);
  if (!storage) {
    storage = purpose === 'tags' ? createTagsStorage() : new Storage();
    storageClients.set(key, storage);
  }
  return storage;
}

/** Retries transient errors but not 429: the caller's paced backoff handles those, and the flush must not block on library retries. */
function createTagsStorage(): Storage {
  return new Storage({
    retryOptions: {
      retryableErrorFn: (err: ApiError) => RETRYABLE_ERR_FN_DEFAULT(err) && getErrorStatusCode(err) !== 429,
    },
  });
}

/** @internal Test hook. */
export function resetSharedStorageForTests(): void {
  storageClients.clear();
}

export function getErrorStatusCode(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') {
    return undefined;
  }
  const code = (error as { code?: unknown }).code;
  if (typeof code === 'number') {
    return code;
  }
  if (typeof code === 'string' && /^\d+$/.test(code)) {
    return Number(code);
  }
  return undefined;
}

export function isNotFound(error: unknown): boolean {
  return getErrorStatusCode(error) === 404;
}

export function isPreconditionFailure(error: unknown): boolean {
  return getErrorStatusCode(error) === 412;
}

export function isRateLimited(error: unknown): boolean {
  return getErrorStatusCode(error) === 429;
}

const MAX_READ_ATTEMPTS = 3;

/**
 * Read a JSON object with its generation. Downloads the generation named in the
 * metadata; if the object is replaced in between, the 404 restarts the read.
 * Transport errors throw (not mistaken for empty); an unparseable object returns
 * `value: null` with its real generation so a conditional write can replace it.
 */
export async function readJsonObject<T>(bucket: Bucket, key: string): Promise<JsonObjectSnapshot<T>> {
  for (let attempt = 0; attempt < MAX_READ_ATTEMPTS; attempt++) {
    let generation: string | number;
    try {
      const [metadata] = await bucket.file(key).getMetadata();
      generation = metadata.generation ?? 0;
    } catch (error) {
      if (isNotFound(error)) {
        return { value: null, generation: 0 };
      }
      throw error;
    }

    let data: Buffer;
    try {
      [data] = await bucket.file(key, { generation }).download();
    } catch (error) {
      if (isNotFound(error)) {
        continue;
      }
      throw error;
    }

    try {
      return { value: JSON.parse(data.toString()) as T, generation };
    } catch (error) {
      log.warn(
        `Object ${key} (generation ${generation}) is not valid JSON; it will be replaced on the next write`,
        error
      );
      return { value: null, generation };
    }
  }

  throw new Error(`Object ${key} was replaced repeatedly while being read`);
}

/**
 * Write a JSON object. With `generation` set, the write only succeeds if the
 * object is still at that generation (0 = must not exist yet) and the caller
 * receives a 412 otherwise.
 */
export async function writeJsonObject(
  bucket: Bucket,
  key: string,
  value: unknown,
  generation?: string | number
): Promise<void> {
  await bucket.file(key).save(JSON.stringify(value), {
    resumable: false,
    metadata: { contentType: 'application/json' },
    ...(generation !== undefined ? { preconditionOpts: { ifGenerationMatch: generation } } : {}),
  });
}
