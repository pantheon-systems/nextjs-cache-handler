import type { ApiError, Bucket, Storage } from '@google-cloud/storage';
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

/** A bucket, or the promise of one while `@google-cloud/storage` loads. */
export type BucketRef = Bucket | Promise<Bucket>;

type StorageModule = typeof import('@google-cloud/storage');

let storageModule: Promise<StorageModule> | null = null;

/**
 * `@google-cloud/storage`, loaded the first time a GCS bucket is needed rather than imported at module
 * top level. Next.js 16.4 bundles `config.cacheHandler` into Node middleware, so a static import puts
 * the library in every middleware bundle, and with `experimental.turbopackModuleFragments` its
 * evaluation there throws (SITE-6759). Behind `import()` it stays out of the static graph.
 */
function loadStorageModule(): Promise<StorageModule> {
  storageModule ??= import('@google-cloud/storage');
  return storageModule;
}

const sharedBuckets = new Map<string, Promise<Bucket>>();

/**
 * One Storage client per bucket and purpose per process; Next.js builds a handler per request. A failed
 * load is not retried: the process can't recover a missing or broken module.
 */
export function getSharedBucket(bucketName: string, purpose: StoragePurpose): Promise<Bucket> {
  const key = `${purpose}:${bucketName}`;
  let bucket = sharedBuckets.get(key);
  if (!bucket) {
    bucket = loadStorageModule().then((mod) =>
      (purpose === 'tags' ? createTagsStorage(mod) : new mod.Storage(endpointOptions())).bucket(bucketName)
    );
    // Handlers hold this from construction; a failed load surfaces where they await it, not as an unhandled rejection.
    bucket.catch(() => {});
    sharedBuckets.set(key, bucket);
  }
  return bucket;
}

/** Retries transient errors but not 429: the caller's paced backoff handles those, and the flush must not block on library retries. */
function createTagsStorage(mod: StorageModule): Storage {
  return new mod.Storage({
    ...endpointOptions(),
    retryOptions: {
      retryableErrorFn: (err: ApiError) => mod.RETRYABLE_ERR_FN_DEFAULT(err) && getErrorStatusCode(err) !== 429,
    },
  });
}

let endpointLogged = false;

/**
 * CACHE_GCS_API_ENDPOINT points the clients at a GCS emulator, for tests (STORAGE_EMULATOR_HOST can't:
 * the library builds API and upload URLs from it differently). The library sends requests to a custom
 * endpoint without credentials, so the setting is ignored on Cloud Run (K_SERVICE is set). Logged once.
 */
function endpointOptions(): { apiEndpoint?: string } {
  const apiEndpoint = process.env.CACHE_GCS_API_ENDPOINT?.trim();
  if (!apiEndpoint) {
    return {};
  }
  const onCloudRun = Boolean(process.env.K_SERVICE);
  if (!endpointLogged) {
    endpointLogged = true;
    if (onCloudRun) {
      log.error(
        'CACHE_GCS_API_ENDPOINT is ignored on Cloud Run (K_SERVICE is set): it is for tests against a GCS ' +
          'emulator, and requests to it would carry no credentials. Using GCS. Unset it.'
      );
    } else {
      log.warn(
        `CACHE_GCS_API_ENDPOINT is set: GCS requests go to ${apiEndpoint} without credentials. Set it only ` +
          `to test against a GCS emulator.`
      );
    }
  }
  return onCloudRun ? {} : { apiEndpoint };
}

/** @internal Test hook. */
export function resetSharedStorageForTests(): void {
  sharedBuckets.clear();
  endpointLogged = false;
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
export async function readJsonObject<T>(bucketRef: BucketRef, key: string): Promise<JsonObjectSnapshot<T>> {
  const bucket = await bucketRef;
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
        `Object ${key} (generation ${generation}) is not valid JSON; reading it as empty, so its contents ` +
          `are lost`,
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
  bucket: BucketRef,
  key: string,
  value: unknown,
  generation?: string | number
): Promise<void> {
  await (await bucket).file(key).save(JSON.stringify(value), {
    resumable: false,
    metadata: { contentType: 'application/json' },
    ...(generation !== undefined ? { preconditionOpts: { ifGenerationMatch: generation } } : {}),
  });
}
