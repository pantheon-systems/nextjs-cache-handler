import { describe, it, expect, vi, afterEach } from 'vitest';
import { withBuildTimeout } from '../../src/utils/build-timeout.js';

describe('withBuildTimeout', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns the promise value when it settles in time', async () => {
    const onTimeout = vi.fn(() => 'fallback');

    const result = await withBuildTimeout(Promise.resolve('real'), 1000, onTimeout);

    expect(result).toBe('real');
    expect(onTimeout).not.toHaveBeenCalled();
  });

  it('falls back to onTimeout() when the promise is too slow', async () => {
    vi.useFakeTimers();

    const slow = new Promise<string>((resolve) => setTimeout(() => resolve('real'), 5000));
    const pending = withBuildTimeout(slow, 500, () => 'fallback');

    await vi.advanceTimersByTimeAsync(600);

    await expect(pending).resolves.toBe('fallback');
  });

  it('propagates a rejection rather than masking it as a timeout', async () => {
    const failure = new Error('GCS exploded');

    await expect(withBuildTimeout(Promise.reject(failure), 1000, () => 'fallback')).rejects.toThrow('GCS exploded');
  });

  it('leaves the original promise running after a timeout (best-effort, not cancelled)', async () => {
    vi.useFakeTimers();

    let completed = false;
    const slow = new Promise<void>((resolve) =>
      setTimeout(() => {
        completed = true;
        resolve();
      }, 2000)
    );

    const pending = withBuildTimeout(slow, 500, () => undefined);
    await vi.advanceTimersByTimeAsync(600);

    // Timed out already, and the underlying work has NOT finished...
    await expect(pending).resolves.toBeUndefined();
    expect(completed).toBe(false);

    // ...but the underlying work still finishes on its own.
    await vi.advanceTimersByTimeAsync(2000);
    expect(completed).toBe(true);
  });

  it('does not leave a pending timer behind when the promise wins', async () => {
    vi.useFakeTimers();
    const clearSpy = vi.spyOn(globalThis, 'clearTimeout');

    await withBuildTimeout(Promise.resolve('real'), 30_000, () => 'fallback');

    // Without the clearTimeout in the finally block, a 30s timer would keep the
    // build process's event loop alive after the work is done.
    expect(clearSpy).toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
