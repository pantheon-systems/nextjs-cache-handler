import type { Bucket, DeleteFileOptions, File, GetFilesResponse } from '@google-cloud/storage';
import { getErrorStatusCode, isNotFound, isPreconditionFailure } from './gcs-json-object.js';

/**
 * Listing and deleting every object under a prefix one page at a time, so
 * memory stays flat however many objects there are (the route cache can hold
 * tens of thousands). Listing everything first and deleting it all at once
 * ran instances out of memory.
 */

export const DEFAULT_LIST_PAGE_SIZE = 1000;
export const DEFAULT_DELETE_CONCURRENCY = 50;
export const MAX_DELETE_CONCURRENCY = 200;

/** Attempts per page listing; transient failures only. */
export const LIST_ATTEMPTS = 3;

// Backoff before retrying: a listing waits 1 s then 2 s, a page's failed deletes 1 s.
let retryBaseDelayMs = 1000;

/** @internal Test hook. */
export function setRetryBaseDelayForTests(ms: number): void {
  retryBaseDelayMs = ms;
}

/** Deletes in flight at once, from CACHE_INVALIDATION_DELETE_CONCURRENCY, clamped to 1..200. */
export function resolveDeleteConcurrency(
  raw: string | undefined = process.env.CACHE_INVALIDATION_DELETE_CONCURRENCY
): number {
  const parsed = raw === undefined || raw.trim() === '' ? NaN : Number(raw);
  if (!Number.isFinite(parsed)) {
    return DEFAULT_DELETE_CONCURRENCY;
  }
  return Math.min(MAX_DELETE_CONCURRENCY, Math.max(1, Math.floor(parsed)));
}

/**
 * What a new build does to the route cache, from CACHE_BUILD_INVALIDATION:
 * `eager` (default) deletes it before serving; `off` leaves it, for emergencies
 * after it was emptied out-of-band.
 */
export type BuildInvalidationMode = 'eager' | 'off';

export function resolveBuildInvalidationMode(
  raw: string | undefined = process.env.CACHE_BUILD_INVALIDATION
): BuildInvalidationMode {
  return raw?.trim().toLowerCase() === 'off' ? 'off' : 'eager';
}

/** Throttling, timeouts, server errors and network errors (no HTTP status). */
export function isTransientError(error: unknown): boolean {
  const status = getErrorStatusCode(error);
  return status === undefined || status === 408 || status === 429 || status >= 500;
}

/** Short label for grouping failures: the HTTP status, else the error code (ECONNRESET), else `error`. */
export function errorLabel(error: unknown): string {
  const status = getErrorStatusCode(error);
  if (status !== undefined) {
    return String(status);
  }
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && code !== '' ? code : 'error';
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A page listing under `prefix` that still failed after its retries. */
export class ListPrefixError extends Error {
  /** Progress made before the listing failed, set by deletePrefix. */
  progress?: Omit<DeletePrefixProgress, 'lastName'>;

  constructor(
    readonly prefix: string,
    readonly attempts: number,
    /** The last listing error. */
    readonly reason: unknown
  ) {
    super(
      `listing ${prefix} failed after ${attempts} attempt${attempts === 1 ? '' : 's'} ` +
        `(${errorLabel(reason)}: ${errorMessage(reason)})`
    );
    this.name = 'ListPrefixError';
  }
}

/**
 * Pages of objects under `prefix`, `pageSize` at a time; only one page is held
 * at once. With `startOffset`, the listing starts at that name (inclusive), in
 * name order. A transient listing failure is retried with backoff; one that
 * keeps failing, or a permanent one (403), throws ListPrefixError.
 */
export async function* listPrefixPages(
  bucket: Bucket,
  prefix: string,
  pageSize = DEFAULT_LIST_PAGE_SIZE,
  startOffset?: string
): AsyncGenerator<File[]> {
  let pageToken: string | undefined;
  do {
    const query = {
      prefix,
      maxResults: pageSize,
      autoPaginate: false,
      pageToken,
      ...(startOffset ? { startOffset } : {}),
    };
    let response: GetFilesResponse | undefined;
    for (let attempt = 1; !response; attempt++) {
      try {
        response = await bucket.getFiles(query);
      } catch (error) {
        if (attempt >= LIST_ATTEMPTS || !isTransientError(error)) {
          throw new ListPrefixError(prefix, attempt, error);
        }
        await sleep(retryBaseDelayMs * 2 ** (attempt - 1));
      }
    }
    const [files, nextQuery] = response;
    yield files;
    pageToken = (nextQuery as { pageToken?: string } | null | undefined)?.pageToken;
  } while (pageToken);
}

/**
 * Run `fn` over `items`, at most `concurrency` at once; results keep the order
 * of `items`. `afterBatch` runs after each batch and may throw to stop.
 */
export async function mapInBatches<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
  afterBatch?: () => Promise<void> | void
): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = [];
  for (let i = 0; i < items.length; i += concurrency) {
    results.push(...(await Promise.allSettled(items.slice(i, i + concurrency).map(fn))));
    await afterBatch?.();
  }
  return results;
}

export interface DeletePrefixOptions {
  /** Objects listed per page. */
  pageSize?: number;
  /** Deletes in flight at once. */
  concurrency?: number;
  /** Delete only matching objects (e.g. static-route preservation). */
  shouldDelete?: (file: File) => boolean;
  /** Start listing at this object name (inclusive), to resume an earlier run. */
  startOffset?: string;
  /**
   * Delete an object only if it is still the version listed (its GCS
   * generation), so one rewritten after the listing is kept and counted as
   * `changed`.
   */
  ifUnchanged?: boolean;
  /** Called after each batch of up to `concurrency` deletes; may throw to stop. */
  onBatch?: () => Promise<void> | void;
  /** Called after each page; may throw to stop. */
  onPage?: (progress: DeletePrefixProgress) => Promise<void> | void;
}

/** Counts so far, as in DeletePrefixResult. */
export interface DeletePrefixProgress {
  listed: number;
  deleted: number;
  skipped: number;
  changed: number;
  failed: number;
  failures: Record<string, number>;
  /** Name of the last object of the last finished page; a later run can resume from it with `startOffset`. */
  lastName?: string;
}

export interface DeletePrefixResult {
  listed: number;
  /** Deleted, or already gone (404). */
  deleted: number;
  /** Left alone by `shouldDelete`. */
  skipped: number;
  /** Rewritten after it was listed, so kept (`ifUnchanged`). */
  changed: number;
  /** Still not deleted after a retry (transient errors) or at once (others). */
  failed: number;
  /** Failed deletes by errorLabel(), e.g. `{ '503': 8, '403': 2 }`. */
  failures: Record<string, number>;
  /** The first failure, for its message. */
  firstError?: unknown;
  durationMs: number;
}

/**
 * Delete the objects under `prefix`, one listed page at a time. Deletes that
 * fail transiently are retried once per page after a backoff; what still fails
 * is counted, not thrown. A run that stops part-way keeps what it deleted, and
 * the next run lists only what is left. Throws ListPrefixError, with
 * `progress`, when a page can't be listed.
 */
export async function deletePrefix(
  bucket: Bucket,
  prefix: string,
  opts: DeletePrefixOptions = {}
): Promise<DeletePrefixResult> {
  const concurrency = opts.concurrency ?? DEFAULT_DELETE_CONCURRENCY;
  const started = Date.now();
  let listed = 0;
  let deleted = 0;
  let skipped = 0;
  let changed = 0;
  let failed = 0;
  let lastName: string | undefined;
  const failures: Record<string, number> = {};
  let firstError: unknown;

  // The SDK sends delete() options as query parameters; its type omits the preconditions.
  const del = (file: File): Promise<unknown> =>
    opts.ifUnchanged && file.metadata?.generation !== undefined
      ? file.delete({ ifGenerationMatch: file.metadata.generation } as DeleteFileOptions)
      : file.delete();

  const recordFailure = (error: unknown) => {
    failed++;
    const label = errorLabel(error);
    failures[label] = (failures[label] ?? 0) + 1;
    firstError ??= error;
  };

  try {
    for await (const files of listPrefixPages(bucket, prefix, opts.pageSize, opts.startOffset)) {
      listed += files.length;
      const targets = opts.shouldDelete ? files.filter(opts.shouldDelete) : files;
      skipped += files.length - targets.length;

      const retry: File[] = [];
      (await mapInBatches(targets, concurrency, del, opts.onBatch)).forEach((result, i) => {
        if (result.status === 'fulfilled' || isNotFound(result.reason)) {
          deleted++;
        } else if (opts.ifUnchanged && isPreconditionFailure(result.reason)) {
          changed++;
        } else if (isTransientError(result.reason)) {
          retry.push(targets[i]);
        } else {
          recordFailure(result.reason);
        }
      });

      if (retry.length > 0) {
        await sleep(retryBaseDelayMs);
        for (const result of await mapInBatches(retry, concurrency, del, opts.onBatch)) {
          if (result.status === 'fulfilled' || isNotFound(result.reason)) {
            deleted++;
          } else if (opts.ifUnchanged && isPreconditionFailure(result.reason)) {
            changed++;
          } else {
            recordFailure(result.reason);
          }
        }
      }

      lastName = files.at(-1)?.name ?? lastName;
      await opts.onPage?.({ listed, deleted, skipped, changed, failed, failures: { ...failures }, lastName });
    }
  } catch (error) {
    if (error instanceof ListPrefixError) {
      error.progress = { listed, deleted, skipped, changed, failed, failures };
    }
    throw error;
  }

  return { listed, deleted, skipped, changed, failed, failures, firstError, durationMs: Date.now() - started };
}

/** Failure counts as `503 x8, 403 x2`, most frequent first. */
export function describeFailures(failures: Record<string, number>): string {
  return Object.entries(failures)
    .sort(([, a], [, b]) => b - a)
    .map(([label, count]) => `${label} x${count}`)
    .join(', ');
}
