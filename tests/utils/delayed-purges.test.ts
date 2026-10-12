import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DelayedPurges, MERGE_WINDOW_MS } from '../../src/utils/delayed-purges.js';
import type { EdgeCacheClear } from '../../src/edge/edge-cache-clear.js';

function fakeClearer(target = 'http://proxy/rest/v0alpha1/cache') {
  const ok = { success: true, duration: 0 };
  return {
    target,
    clearKeys: vi.fn(async (_keys: string[]) => ok),
    clearPaths: vi.fn(async (_paths: string[]) => ok),
    nukeCache: vi.fn(async () => ok),
  };
}

describe('DelayedPurges', () => {
  let purges: DelayedPurges;
  let clearer: ReturnType<typeof fakeClearer>;
  const asClearer = () => clearer as unknown as EdgeCacheClear;

  beforeEach(() => {
    vi.useFakeTimers();
    purges = new DelayedPurges();
    clearer = fakeClearer();
  });

  afterEach(() => {
    purges.reset();
    vi.useRealTimers();
  });

  it('never purges before the due time', async () => {
    purges.schedule(asClearer(), { keys: ['a'], paths: ['/a'] }, Date.now() + 2000, 'a');

    await vi.advanceTimersByTimeAsync(1999);
    expect(clearer.clearPaths).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1 + MERGE_WINDOW_MS);
    expect(clearer.clearPaths).toHaveBeenCalledWith(['/a']);
    expect(clearer.clearKeys).toHaveBeenCalledWith(['a']);
  });

  it('sends purges due within the merge window as one, each path and key once', async () => {
    const now = Date.now();
    purges.schedule(asClearer(), { keys: ['a'], paths: ['/x', '/a'] }, now + 2000, 'a');
    purges.schedule(asClearer(), { keys: ['b'], paths: ['/x', '/b'] }, now + 2500, 'b');

    await vi.advanceTimersByTimeAsync(2000 + MERGE_WINDOW_MS);
    expect(clearer.clearPaths).toHaveBeenCalledTimes(1);
    expect(clearer.clearPaths.mock.calls[0][0]).toEqual(['/x', '/a', '/b']);
    expect(clearer.clearKeys).toHaveBeenCalledWith(['a', 'b']);
    expect(purges.size).toBe(0);
  });

  it('merges purges from different clearers with the same target (one handler per request)', async () => {
    const other = fakeClearer();
    purges.schedule(asClearer(), { paths: ['/a'] }, Date.now(), 'a');
    purges.schedule(other as unknown as EdgeCacheClear, { paths: ['/a', '/b'] }, Date.now(), 'b');

    await vi.advanceTimersByTimeAsync(MERGE_WINDOW_MS);
    expect(clearer.clearPaths.mock.calls).toEqual([[['/a', '/b']]]);
    expect(other.clearPaths).not.toHaveBeenCalled();
  });

  it('keeps purges for different targets apart', async () => {
    const other = fakeClearer('http://other/rest/v0alpha1/cache');
    purges.schedule(asClearer(), { paths: ['/a'] }, Date.now(), 'a');
    purges.schedule(other as unknown as EdgeCacheClear, { paths: ['/b'] }, Date.now(), 'b');

    await vi.advanceTimersByTimeAsync(MERGE_WINDOW_MS);
    expect(clearer.clearPaths.mock.calls).toEqual([[['/a']]]);
    expect(other.clearPaths.mock.calls).toEqual([[['/b']]]);
  });

  it('keeps a purge that is not due yet for a later batch', async () => {
    const now = Date.now();
    purges.schedule(asClearer(), { paths: ['/a'] }, now + 1000, 'a');
    purges.schedule(asClearer(), { paths: ['/b'] }, now + 1000 + MERGE_WINDOW_MS + 500, 'b');

    await vi.advanceTimersByTimeAsync(1000 + MERGE_WINDOW_MS);
    expect(clearer.clearPaths.mock.calls).toEqual([[['/a']]]);

    await vi.advanceTimersByTimeAsync(500 + MERGE_WINDOW_MS);
    expect(clearer.clearPaths.mock.calls).toEqual([[['/a']], [['/b']]]);
  });

  it('purges the whole site when any merged purge asks for it', async () => {
    purges.schedule(asClearer(), { keys: ['a'], paths: ['/a'] }, Date.now(), 'a');
    purges.schedule(asClearer(), { keys: ['_N_T_/layout'], purgeAll: true }, Date.now(), 'layout');

    await vi.advanceTimersByTimeAsync(MERGE_WINDOW_MS);
    expect(clearer.nukeCache).toHaveBeenCalledTimes(1);
    expect(clearer.clearPaths).not.toHaveBeenCalled();
  });

  it('keeps going after a purge fails', async () => {
    clearer.clearPaths.mockRejectedValueOnce(new Error('proxy down'));
    purges.schedule(asClearer(), { paths: ['/a'] }, Date.now(), 'a');
    await vi.advanceTimersByTimeAsync(MERGE_WINDOW_MS);

    purges.schedule(asClearer(), { paths: ['/b'] }, Date.now(), 'b');
    await vi.advanceTimersByTimeAsync(MERGE_WINDOW_MS);
    expect(clearer.clearPaths).toHaveBeenLastCalledWith(['/b']);
  });

  describe('flush (shutdown)', () => {
    it('waits until the purges are due, then sends them', async () => {
      purges.schedule(asClearer(), { paths: ['/a'] }, Date.now() + 2000, 'a');

      const flushed = purges.flush(Date.now() + 8000);
      await vi.advanceTimersByTimeAsync(1999);
      expect(clearer.clearPaths).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      await flushed;
      expect(clearer.clearPaths).toHaveBeenCalledWith(['/a']);
      expect(purges.size).toBe(0);
    });

    it('sends at the deadline what is not due by then rather than lose it', async () => {
      purges.schedule(asClearer(), { paths: ['/a'] }, Date.now() + 5000, 'a');

      const flushed = purges.flush(Date.now() + 1000);
      await vi.advanceTimersByTimeAsync(1000);
      await flushed;
      expect(clearer.clearPaths).toHaveBeenCalledWith(['/a']);
    });

    it('does nothing when no purge is owed', async () => {
      await purges.flush(Date.now() + 1000);
      expect(clearer.clearPaths).not.toHaveBeenCalled();
    });
  });
});
