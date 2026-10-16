import { expect, vi } from 'vitest';

export interface PagedObjectsOptions {
  /** Deletes of the object at this index fail with 503. */
  failDelete?: (i: number) => boolean;
  /** Deletes of the object at this index fail with 404 (already gone). */
  notFoundDelete?: (i: number) => boolean;
  /** Status a delete of the object at this index fails with on this attempt (1-based), or undefined to succeed. */
  deleteStatus?: (i: number, attempt: number) => number | undefined;
  /** `metadata.updated` of the object at this index, in ms. */
  updatedAt?: (i: number) => number;
  /** Custom metadata (`metadata.metadata`) of the object at this index. */
  customMetadata?: (i: number) => Record<string, string> | undefined;
}

/**
 * Objects listed the way `getFiles({ autoPaginate: false })` lists them: in
 * name order, `maxResults` per page, resuming after `pageToken`. Records the
 * largest page and the most deletes and downloads in flight at once.
 */
export function pagedObjects(prefix: string, total: number, opts: PagedObjectsOptions = {}) {
  const names = Array.from({ length: total }, (_, i) => `${prefix}${String(i).padStart(7, '0')}.json`);
  return pagedObjectsNamed(names, opts);
}

export function pagedObjectsNamed(names: string[], opts: PagedObjectsOptions = {}) {
  const sorted = [...names].sort();
  const index = new Map(sorted.map((name, i) => [name, i]));
  const live = new Set(sorted);
  const deleted = new Set<string>();
  /** Delete calls per object name. */
  const deleteAttempts = new Map<string, number>();
  let inFlight = 0;
  let maxInFlight = 0;
  let maxPage = 0;
  let pages = 0;

  const error = (code: number) => Object.assign(new Error(`HTTP ${code}`), { code });

  async function track<T>(fn: () => T): Promise<T> {
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await Promise.resolve();
    inFlight--;
    return fn();
  }

  const file = (name: string) => {
    const i = index.get(name)!;
    return {
      name,
      metadata: { updated: new Date(opts.updatedAt?.(i) ?? 0).toISOString(), metadata: opts.customMetadata?.(i) },
      delete: () =>
        track(() => {
          const attempt = (deleteAttempts.get(name) ?? 0) + 1;
          deleteAttempts.set(name, attempt);
          const status = opts.deleteStatus?.(i, attempt);
          if (status !== undefined) throw error(status);
          if (opts.failDelete?.(i)) throw error(503);
          if (opts.notFoundDelete?.(i)) throw error(404);
          live.delete(name);
          deleted.add(name);
        }),
      download: () => track(() => [Buffer.from(JSON.stringify({ tags: ['t'], lastModified: 1 }))] as [Buffer]),
    };
  };

  const getFiles = vi.fn(
    async ({
      prefix,
      maxResults,
      pageToken,
      autoPaginate,
    }: {
      prefix: string;
      maxResults: number;
      pageToken?: string;
      autoPaginate?: boolean;
    }) => {
      expect(autoPaginate).toBe(false);
      pages++;
      const remaining = [...live].filter((n) => n.startsWith(prefix) && (!pageToken || n > pageToken));
      const page = remaining.slice(0, maxResults);
      maxPage = Math.max(maxPage, page.length);
      const next = remaining.length > maxResults ? { prefix, maxResults, pageToken: page[page.length - 1] } : null;
      return [page.map(file), next, {}];
    }
  );

  return {
    getFiles,
    live,
    deleted,
    deleteAttempts,
    stats: () => ({ maxInFlight, maxPage, pages }),
  };
}
