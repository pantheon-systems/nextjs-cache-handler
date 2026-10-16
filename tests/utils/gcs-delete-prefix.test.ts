import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import {
  LIST_ATTEMPTS,
  ListPrefixError,
  deletePrefix,
  describeFailures,
  errorLabel,
  isTransientError,
  resolveBuildInvalidationMode,
  resolveDeleteConcurrency,
  setRetryBaseDelayForTests,
} from '../../src/utils/gcs-delete-prefix.js';
import { pagedObjects } from '../helpers/paged-objects.js';

const PREFIX = 'route-cache/';
const httpError = (code: number | string) => Object.assign(new Error(`HTTP ${code}`), { code });

beforeAll(() => setRetryBaseDelayForTests(0));
afterAll(() => setRetryBaseDelayForTests(1000));

describe('deletePrefix', () => {
  it('holds at most one page and stays within the concurrency limit', async () => {
    const objects = pagedObjects(PREFIX, 100_000);
    const r = await deletePrefix({ getFiles: objects.getFiles } as any, PREFIX, { pageSize: 1000, concurrency: 50 });

    expect(r).toMatchObject({ listed: 100_000, deleted: 100_000, failed: 0 });
    expect(objects.deleted.size).toBe(100_000);
    expect(objects.stats().maxInFlight).toBe(50);
    expect(objects.stats().maxPage).toBe(1000);
    expect(objects.getFiles).toHaveBeenCalledTimes(100);
  });

  it('counts 404 as deleted and other failures as failed without stopping', async () => {
    const objects = pagedObjects(PREFIX, 1000, { failDelete: (i) => i % 7 === 0, notFoundDelete: (i) => i % 10 === 0 });
    const r = await deletePrefix({ getFiles: objects.getFiles } as any, PREFIX, { pageSize: 100 });

    expect(r.listed).toBe(1000);
    expect(r.failed).toBe(143); // i % 7 === 0 for i in 0..999
    expect(r.deleted).toBe(857);
    expect(r.failures).toEqual({ '503': 143 });
    expect(r.firstError).toMatchObject({ code: 503 });
  });

  it('retries a transient delete failure once, after the page', async () => {
    // 503 then success for some, 429 twice for others.
    const objects = pagedObjects(PREFIX, 100, {
      deleteStatus: (i, attempt) => (i < 10 && attempt === 1 ? 503 : i >= 90 ? 429 : undefined),
    });
    const r = await deletePrefix({ getFiles: objects.getFiles } as any, PREFIX);

    expect(r).toMatchObject({ deleted: 90, failed: 10, failures: { '429': 10 } });
    expect(objects.deleteAttempts.get('route-cache/0000000.json')).toBe(2);
    expect(objects.deleteAttempts.get('route-cache/0000099.json')).toBe(2); // one retry only
    expect(objects.deleteAttempts.get('route-cache/0000050.json')).toBe(1);
  });

  it('does not retry a permanent delete failure', async () => {
    const objects = pagedObjects(PREFIX, 10, { deleteStatus: (i) => (i < 2 ? 403 : undefined) });
    const r = await deletePrefix({ getFiles: objects.getFiles } as any, PREFIX);

    expect(r).toMatchObject({ deleted: 8, failed: 2, failures: { '403': 2 } });
    expect(objects.deleteAttempts.get('route-cache/0000000.json')).toBe(1);
  });

  it('retries a transient listing failure', async () => {
    const objects = pagedObjects(PREFIX, 2500);
    const getFiles = vi
      .fn()
      .mockImplementationOnce(objects.getFiles)
      .mockRejectedValueOnce(httpError(503))
      .mockRejectedValueOnce(httpError('ECONNRESET'))
      .mockImplementation(objects.getFiles);
    const r = await deletePrefix({ getFiles } as any, PREFIX);

    expect(r).toMatchObject({ listed: 2500, deleted: 2500, failed: 0 });
    expect(getFiles).toHaveBeenCalledTimes(5);
  });

  it('throws ListPrefixError with the progress made when a listing keeps failing', async () => {
    const objects = pagedObjects(PREFIX, 2500, { deleteStatus: (i) => (i === 0 ? 403 : undefined) });
    const getFiles = vi.fn().mockImplementationOnce(objects.getFiles).mockRejectedValue(httpError(503));

    const error = await deletePrefix({ getFiles } as any, PREFIX).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ListPrefixError);
    expect(error).toMatchObject({
      attempts: LIST_ATTEMPTS,
      prefix: PREFIX,
      progress: { listed: 1000, deleted: 999, failed: 1, failures: { '403': 1 } },
      message: 'listing route-cache/ failed after 3 attempts (503: HTTP 503)',
    });
    expect(getFiles).toHaveBeenCalledTimes(1 + LIST_ATTEMPTS);
  });

  it('does not retry a permanent listing failure', async () => {
    const getFiles = vi.fn().mockRejectedValue(httpError(403));

    const error = await deletePrefix({ getFiles } as any, PREFIX).catch((e: unknown) => e);

    expect(error).toMatchObject({
      attempts: 1,
      message: 'listing route-cache/ failed after 1 attempt (403: HTTP 403)',
    });
    expect(getFiles).toHaveBeenCalledTimes(1);
  });

  it('lets an onPage error through unchanged', async () => {
    const objects = pagedObjects(PREFIX, 10);
    const stop = new Error('lease lost');

    await expect(
      deletePrefix({ getFiles: objects.getFiles } as any, PREFIX, { onPage: () => Promise.reject(stop) })
    ).rejects.toBe(stop);
  });

  it('resumes where a stopped run left off', async () => {
    const objects = pagedObjects(PREFIX, 5000);
    let pages = 0;
    await expect(
      deletePrefix({ getFiles: objects.getFiles } as any, PREFIX, {
        pageSize: 1000,
        onPage: () => {
          if (++pages === 2) throw new Error('crash stand-in');
        },
      })
    ).rejects.toThrow('crash stand-in');
    expect(objects.deleted.size).toBe(2000);

    const r = await deletePrefix({ getFiles: objects.getFiles } as any, PREFIX, { pageSize: 1000 });
    expect(r.listed).toBe(3000);
    expect(objects.deleted.size).toBe(5000);
  });

  it('deletes only objects matching shouldDelete', async () => {
    const cutoff = 1_000;
    const objects = pagedObjects(PREFIX, 2000, { updatedAt: (i) => (i < 1500 ? 500 : 5_000) });
    const r = await deletePrefix({ getFiles: objects.getFiles } as any, PREFIX, {
      shouldDelete: (f) => Date.parse(String(f.metadata.updated)) < cutoff,
    });

    expect(r).toMatchObject({ listed: 2000, deleted: 1500, failed: 0 });
    expect(objects.live.size).toBe(500);
  });

  it('reports progress after each page', async () => {
    const objects = pagedObjects(PREFIX, 2500);
    const progress: Array<{ listed: number; deleted: number }> = [];
    await deletePrefix({ getFiles: objects.getFiles } as any, PREFIX, {
      pageSize: 1000,
      onPage: (p) => progress.push(p),
    });

    expect(progress).toEqual([
      { listed: 1000, deleted: 1000 },
      { listed: 2000, deleted: 2000 },
      { listed: 2500, deleted: 2500 },
    ]);
  });

  it('lists once and deletes nothing under an empty prefix', async () => {
    const objects = pagedObjects(PREFIX, 0);
    const r = await deletePrefix({ getFiles: objects.getFiles } as any, PREFIX);

    expect(r).toMatchObject({ listed: 0, deleted: 0, failed: 0 });
    expect(objects.getFiles).toHaveBeenCalledTimes(1);
  });
});

describe('failure helpers', () => {
  it.each([
    [httpError(503), true, '503'],
    [httpError(500), true, '500'],
    [httpError(429), true, '429'],
    [httpError(408), true, '408'],
    [httpError('ECONNRESET'), true, 'ECONNRESET'],
    [new Error('socket hang up'), true, 'error'],
    [httpError(403), false, '403'],
    [httpError('412'), false, '412'],
  ])('%s: transient %s, label %s', (error, transient, label) => {
    expect(isTransientError(error)).toBe(transient);
    expect(errorLabel(error)).toBe(label);
  });

  it('describes failures most frequent first', () => {
    expect(describeFailures({ '403': 2, '503': 8, ECONNRESET: 1 })).toBe('503 x8, 403 x2, ECONNRESET x1');
  });
});

describe('resolveDeleteConcurrency', () => {
  it.each([
    [undefined, 50],
    ['', 50],
    ['abc', 50],
    ['10', 10],
    ['12.9', 12],
    ['0', 1],
    ['-5', 1],
    ['500', 200],
  ])('%s -> %i', (raw, expected) => {
    expect(resolveDeleteConcurrency(raw)).toBe(expected);
  });
});

describe('resolveBuildInvalidationMode', () => {
  it.each([
    [undefined, 'eager'],
    ['', 'eager'],
    ['eager', 'eager'],
    ['lazy', 'eager'],
    ['off', 'off'],
    [' OFF ', 'off'],
  ])('%s -> %s', (raw, expected) => {
    expect(resolveBuildInvalidationMode(raw)).toBe(expected);
  });
});
