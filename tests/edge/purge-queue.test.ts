import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  PurgeQueue,
  FULL_PURGE_ATTEMPTS,
  GIVE_UP_AFTER_PAUSED_MS,
  MAX_BACKOFF_MS,
  parseRetryAfter,
  purgeQueueFor,
  resetPurgeQueuesForTests,
  resolvePurgeConcurrency,
  resolvePurgeMaxPaths,
  setPurgeBackoffBaseForTests,
  type PurgeOutcome,
} from '../../src/edge/purge-queue.js';

const OK: PurgeOutcome = { ok: true, status: 200 };

/** A request the test finishes by hand, to hold it in flight. */
function heldRequest() {
  let finish!: (outcome?: PurgeOutcome) => void;
  const done = new Promise<PurgeOutcome>((resolve) => {
    finish = (outcome = OK) => resolve(outcome);
  });
  const send = vi.fn(() => done);
  return { send, finish };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

describe('resolvePurgeConcurrency', () => {
  it('defaults to 10 and clamps to 1..200', () => {
    expect(resolvePurgeConcurrency(undefined)).toBe(10);
    expect(resolvePurgeConcurrency('')).toBe(10);
    expect(resolvePurgeConcurrency('abc')).toBe(10);
    expect(resolvePurgeConcurrency('0')).toBe(1);
    expect(resolvePurgeConcurrency('25.9')).toBe(25);
    expect(resolvePurgeConcurrency('5000')).toBe(200);
  });
});

describe('resolvePurgeMaxPaths', () => {
  it('defaults to 200, is at least 1 and has no upper limit', () => {
    expect(resolvePurgeMaxPaths(undefined)).toBe(200);
    expect(resolvePurgeMaxPaths('not a number')).toBe(200);
    expect(resolvePurgeMaxPaths('0')).toBe(1);
    expect(resolvePurgeMaxPaths('1000000')).toBe(1_000_000);
  });
});

describe('parseRetryAfter', () => {
  it('reads seconds and HTTP dates, and ignores anything else', () => {
    const now = Date.parse('2026-01-01T00:00:00Z');
    expect(parseRetryAfter('7', now)).toBe(7000);
    expect(parseRetryAfter('Thu, 01 Jan 2026 00:00:12 GMT', now)).toBe(12_000);
    expect(parseRetryAfter('Wed, 31 Dec 2025 23:59:00 GMT', now)).toBe(0);
    expect(parseRetryAfter('soon', now)).toBeUndefined();
    expect(parseRetryAfter(null, now)).toBeUndefined();
  });
});

describe('PurgeQueue', () => {
  it('never has more than the limit in flight, and sends everything', async () => {
    const queue = new PurgeQueue(3);
    let inFlight = 0;
    let most = 0;
    const send = vi.fn(async () => {
      inFlight++;
      most = Math.max(most, inFlight);
      await tick();
      inFlight--;
      return OK;
    });

    const outcomes = await Promise.all(Array.from({ length: 50 }, (_, i) => queue.enqueue('path', `/p${i}`, send)));

    expect(outcomes.every((outcome) => outcome.ok)).toBe(true);
    expect(send).toHaveBeenCalledTimes(50);
    expect(most).toBe(3);
  });

  it('sends a purge that is already waiting only once', async () => {
    const queue = new PurgeQueue(1);
    const blocker = heldRequest();
    const send = vi.fn(async () => OK);

    void queue.enqueue('path', '/blocker', blocker.send);
    const first = queue.enqueue('path', '/a', send);
    const second = queue.enqueue('path', '/a', send);
    blocker.finish();

    expect(await first).toBe(await second);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('sends a purge requested again while in flight once more, however often it is requested', async () => {
    const queue = new PurgeQueue(1);
    const inFlight = heldRequest();
    const followUp = vi.fn(async () => OK);

    const first = queue.enqueue('path', '/a', inFlight.send);
    await tick();
    const repeats = [1, 2, 3].map(() => queue.enqueue('path', '/a', followUp));
    expect(followUp).not.toHaveBeenCalled();

    inFlight.finish();
    await first;
    await Promise.all(repeats);

    expect(inFlight.send).toHaveBeenCalledTimes(1);
    expect(followUp).toHaveBeenCalledTimes(1);
  });

  it('keeps paths and keys with the same text apart', async () => {
    const queue = new PurgeQueue(1);
    const blocker = heldRequest();
    const path = vi.fn(async () => OK);
    const key = vi.fn(async () => OK);

    void queue.enqueue('path', '/blocker', blocker.send);
    const sent = [queue.enqueue('path', 'posts', path), queue.enqueue('key', 'posts', key)];
    blocker.finish();
    await Promise.all(sent);

    expect(path).toHaveBeenCalledTimes(1);
    expect(key).toHaveBeenCalledTimes(1);
  });

  it('counts the path purges that have not started', async () => {
    const queue = new PurgeQueue(1);
    const blocker = heldRequest();

    void queue.enqueue('path', '/in-flight', blocker.send);
    expect(queue.waitingPaths).toBe(0);

    const waiting = [
      queue.enqueue('path', '/a', async () => OK),
      queue.enqueue('path', '/a', async () => OK),
      queue.enqueue('path', '/b', async () => OK),
      queue.enqueue('key', 'posts', async () => OK),
    ];
    expect(queue.waitingPaths).toBe(2);

    blocker.finish();
    await Promise.all(waiting);
    expect(queue.waitingPaths).toBe(0);
  });

  it('counts as new only the paths that would add a waiting purge', async () => {
    const queue = new PurgeQueue(1);
    const inFlight = heldRequest();
    const repeated = heldRequest();

    void queue.enqueue('path', '/in-flight', inFlight.send);
    void queue.enqueue('path', '/waiting', async () => OK);
    void queue.enqueue('path', '/repeated', repeated.send);
    expect(queue.newPaths(['/waiting', '/new', '/new', '/in-flight'])).toBe(2);

    void queue.enqueue('all', '', async () => OK);
    expect(queue.newPaths(['/other'])).toBe(0);
    inFlight.finish();
    repeated.finish();
  });

  it('does not count as new a path in flight that already has its repeat waiting', async () => {
    const queue = new PurgeQueue(1);
    const inFlight = heldRequest();

    void queue.enqueue('path', '/a', inFlight.send);
    await tick();
    expect(queue.newPaths(['/a'])).toBe(1);

    void queue.enqueue('path', '/a', async () => OK);
    expect(queue.newPaths(['/a'])).toBe(0);
    inFlight.finish();
  });

  describe('full purges', () => {
    it('a waiting full purge covers the path purges waiting with it, but not key purges', async () => {
      const queue = new PurgeQueue(1);
      const blocker = heldRequest();
      const path = vi.fn(async () => OK);
      const key = vi.fn(async () => OK);
      const full = vi.fn(async () => ({ ok: true, status: 202 }));

      void queue.enqueue('path', '/blocker', blocker.send);
      const before = queue.enqueue('path', '/before', path);
      const keyPurge = queue.enqueue('key', 'posts', key);
      const fullPurge = queue.enqueue('all', '', full);
      expect(queue.waitingPaths).toBe(0);
      const after = queue.enqueue('path', '/after', path);
      blocker.finish();

      expect(await before).toEqual({ ok: true, status: 202 });
      expect(await after).toEqual({ ok: true, status: 202 });
      await Promise.all([keyPurge, fullPurge]);
      expect(path).not.toHaveBeenCalled();
      expect(key).toHaveBeenCalledTimes(1);
      expect(full).toHaveBeenCalledTimes(1);
    });

    it('is sent before key purges that were waiting ahead of it', async () => {
      const queue = new PurgeQueue(1);
      const blocker = heldRequest();
      const order: string[] = [];

      void queue.enqueue('path', '/blocker', blocker.send);
      const key = queue.enqueue('key', 'posts', async () => (order.push('key'), OK));
      const full = queue.enqueue('all', '', async () => (order.push('all'), OK));
      blocker.finish();
      await Promise.all([key, full]);

      expect(order).toEqual(['all', 'key']);
    });

    it('a full purge already in flight does not cover a path purge requested after it started', async () => {
      const queue = new PurgeQueue(2);
      const full = heldRequest();
      const path = vi.fn(async () => OK);

      const fullPurge = queue.enqueue('all', '', full.send);
      await tick();
      await queue.enqueue('path', '/a', path);
      full.finish();
      await fullPurge;

      expect(path).toHaveBeenCalledTimes(1);
    });

    it('a full purge requested while one is in flight is sent after it, and covers the paths waiting by then', async () => {
      const queue = new PurgeQueue(1);
      const first = heldRequest();
      const second = vi.fn(async () => ({ ok: true, status: 202 }));
      const path = vi.fn(async () => OK);

      void queue.enqueue('all', '', first.send);
      await tick();
      const waitingPath = queue.enqueue('path', '/before', path);
      const secondPurge = queue.enqueue('all', '', second);
      const laterPath = queue.enqueue('path', '/after', path);
      expect(queue.waitingPaths).toBe(0);
      first.finish();

      expect(await waitingPath).toEqual({ ok: true, status: 202 });
      expect(await laterPath).toEqual({ ok: true, status: 202 });
      await secondPurge;
      expect(second).toHaveBeenCalledTimes(1);
      expect(path).not.toHaveBeenCalled();
    });

    it('covers the repeat of a path that was in flight when the full purge was requested', async () => {
      const queue = new PurgeQueue(1);
      const inFlight = heldRequest();
      const repeat = vi.fn(async () => OK);
      const full = vi.fn(async () => ({ ok: true, status: 202 }));

      void queue.enqueue('path', '/a', inFlight.send);
      await tick();
      const repeated = queue.enqueue('path', '/a', repeat);
      const fullPurge = queue.enqueue('all', '', full);
      inFlight.finish();

      expect(await repeated).toEqual({ ok: true, status: 202 });
      await fullPurge;
      expect(repeat).not.toHaveBeenCalled();
      expect(full).toHaveBeenCalledTimes(1);
    });

    it('a failed full purge fails the path purges it covered', async () => {
      const queue = new PurgeQueue(1);
      const blocker = heldRequest();

      void queue.enqueue('path', '/blocker', blocker.send);
      const covered = queue.enqueue('path', '/a', async () => OK);
      void queue.enqueue('all', '', async () => ({ ok: false, status: 404, error: 'no such site' }));
      blocker.finish();

      expect(await covered).toMatchObject({ ok: false, status: 404 });
    });
  });

  describe('back-off', () => {
    let warn: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      vi.useFakeTimers();
      warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    });

    afterEach(() => {
      vi.useRealTimers();
      warn.mockRestore();
    });

    const LATENCY_MS = 50;
    /** Answers after LATENCY_MS, as a real request does: the pause starts later than the request. */
    const answers = (outcome: PurgeOutcome) =>
      vi.fn(() => new Promise<PurgeOutcome>((resolve) => setTimeout(() => resolve(outcome), LATENCY_MS)));
    const overloaded = (status: number, retryAfterMs?: number) => answers({ ok: false, status, retryAfterMs });
    const pauses = () => warn.mock.calls.map((call: unknown[]) => Number(/for (\d+) ms/.exec(String(call[0]))?.[1]));

    it('waits for Retry-After after a 429, then sends what was waiting, without retrying the 429', async () => {
      const queue = new PurgeQueue(1);
      const throttled = overloaded(429, 4000);
      const next = answers(OK);

      const first = queue.enqueue('path', '/a', throttled);
      const second = queue.enqueue('path', '/b', next);
      await vi.advanceTimersByTimeAsync(LATENCY_MS);
      expect(await first).toMatchObject({ ok: false, status: 429 });

      await vi.advanceTimersByTimeAsync(3999);
      expect(next).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1 + LATENCY_MS);
      expect((await second).ok).toBe(true);

      expect(throttled).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(
        '[EdgeCacheClear] Purge service answered HTTP 429: pausing edge purges for 4000 ms ' +
          '(1 waiting, sent after the pause, one at a time until the service answers normally)'
      );
    });

    it('sends purges that were already waiting when the longest pause began', async () => {
      const queue = new PurgeQueue(1);
      const sends = Array.from({ length: 5 }, () => answers(OK));

      void queue.enqueue('path', '/throttled', overloaded(429, 3_600_000));
      const waiting = sends.map((send, i) => queue.enqueue('path', `/p${i}`, send));
      await vi.advanceTimersByTimeAsync(LATENCY_MS + MAX_BACKOFF_MS - 1);
      expect(sends[0]).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1 + 5 * LATENCY_MS);
      expect((await Promise.all(waiting)).every((outcome) => outcome.ok)).toBe(true);
    });

    it('drops nothing when its timer fires late', async () => {
      const queue = new PurgeQueue(1);
      const send = answers(OK);

      void queue.enqueue('path', '/throttled', overloaded(503));
      const waiting = queue.enqueue('path', '/a', send);
      await vi.advanceTimersByTimeAsync(LATENCY_MS);
      // The instance gets no CPU for ten minutes, then runs again.
      vi.setSystemTime(Date.now() + 600_000);
      await vi.advanceTimersByTimeAsync(1000 + LATENCY_MS);

      expect((await waiting).ok).toBe(true);
    });

    it('doubles the wait while the service stays overloaded, up to the cap, and starts over once it answers', async () => {
      const queue = new PurgeQueue(1);

      for (let i = 0; i < 7; i++) {
        void queue.enqueue('path', `/failing-${i}`, overloaded(503));
        await vi.advanceTimersByTimeAsync(LATENCY_MS + MAX_BACKOFF_MS);
      }
      expect(pauses()).toEqual([1000, 2000, 4000, 8000, 16000, MAX_BACKOFF_MS, MAX_BACKOFF_MS]);

      void queue.enqueue('path', '/works', answers(OK));
      await vi.advanceTimersByTimeAsync(LATENCY_MS);
      void queue.enqueue('path', '/failing-again', overloaded(503));
      await vi.advanceTimersByTimeAsync(LATENCY_MS);
      expect(pauses().at(-1)).toBe(1000);
    });

    it('treats one burst of overloaded responses as one pause', async () => {
      const queue = new PurgeQueue(5);
      for (let i = 0; i < 5; i++) {
        void queue.enqueue('path', `/p${i}`, overloaded(503));
      }
      await vi.advanceTimersByTimeAsync(LATENCY_MS);

      expect(pauses()).toEqual([1000]);
    });

    it('lengthens the pause for a longer Retry-After from the same burst', async () => {
      const queue = new PurgeQueue(2);
      const next = answers(OK);

      void queue.enqueue('path', '/a', overloaded(503));
      void queue.enqueue('path', '/b', overloaded(429, 8000));
      void queue.enqueue('path', '/c', next);
      await vi.advanceTimersByTimeAsync(LATENCY_MS + 7999);
      expect(next).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      expect(next).toHaveBeenCalledTimes(1);
      expect(pauses()).toEqual([1000]);
    });

    it('pauses for at least a second when Retry-After is 0', async () => {
      const queue = new PurgeQueue(1);
      const next = answers(OK);

      void queue.enqueue('path', '/a', overloaded(429, 0));
      void queue.enqueue('path', '/b', next);
      await vi.advanceTimersByTimeAsync(LATENCY_MS + 999);
      expect(next).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      expect(next).toHaveBeenCalledTimes(1);
      expect(pauses()).toEqual([1000]);
    });

    it('caps a long Retry-After from the same burst too', async () => {
      const queue = new PurgeQueue(2);
      const next = answers(OK);

      void queue.enqueue('path', '/a', overloaded(503));
      void queue.enqueue('path', '/b', overloaded(429, 3_600_000));
      void queue.enqueue('path', '/c', next);
      await vi.advanceTimersByTimeAsync(LATENCY_MS + MAX_BACKOFF_MS - 1);
      expect(next).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      expect(next).toHaveBeenCalledTimes(1);
    });

    it('a normal answer to a request sent before the pause does not end the recovery', async () => {
      const queue = new PurgeQueue(2);
      let inFlight = 0;
      const inFlightSeen: number[] = [];
      const tracked = () => {
        inFlight++;
        inFlightSeen.push(inFlight);
        return new Promise<PurgeOutcome>((resolve) =>
          setTimeout(() => {
            inFlight--;
            resolve(OK);
          }, LATENCY_MS)
        );
      };
      // Sent together: one is refused at once, the other is answered normally during the pause.
      const slowButFine = () => new Promise<PurgeOutcome>((resolve) => setTimeout(() => resolve(OK), 4 * LATENCY_MS));

      void queue.enqueue('path', '/refused', overloaded(503));
      void queue.enqueue('path', '/slow', slowButFine);
      await vi.advanceTimersByTimeAsync(4 * LATENCY_MS);
      const waiting = [queue.enqueue('path', '/a', tracked), queue.enqueue('path', '/b', tracked)];
      await vi.advanceTimersByTimeAsync(1000 + 2 * LATENCY_MS);
      await Promise.all(waiting);

      // Still recovering after the pause, so /a goes alone; with the recovery ended they would go together.
      expect(inFlightSeen).toEqual([1, 1]);
    });

    it('stop() cancels the timer that ends a pause', async () => {
      const queue = new PurgeQueue(1);

      void queue.enqueue('path', '/a', overloaded(503));
      void queue.enqueue('path', '/b', answers(OK));
      await vi.advanceTimersByTimeAsync(LATENCY_MS);
      expect(vi.getTimerCount()).toBe(1);

      queue.stop();
      expect(vi.getTimerCount()).toBe(0);
    });

    it('says how much of a pause is left, whether or not anything is waiting for it to end', async () => {
      const queue = new PurgeQueue(1);
      expect(queue.pauseLeftMs).toBe(0);

      void queue.enqueue('path', '/a', overloaded(503));
      await vi.advanceTimersByTimeAsync(LATENCY_MS);
      expect(queue.pauseLeftMs).toBe(1000);

      await vi.advanceTimersByTimeAsync(999);
      expect(queue.pauseLeftMs).toBe(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(queue.pauseLeftMs).toBe(0);
    });

    it('forgets a refusal once it has been idle well past the pause', async () => {
      const queue = new PurgeQueue(3);
      let inFlight = 0;
      let most = 0;
      const tracked = () => {
        most = Math.max(most, ++inFlight);
        return new Promise<PurgeOutcome>((resolve) =>
          setTimeout(() => {
            inFlight--;
            resolve(OK);
          }, LATENCY_MS)
        );
      };

      void queue.enqueue('path', '/refused', overloaded(503));
      await vi.advanceTimersByTimeAsync(LATENCY_MS + 1000 + MAX_BACKOFF_MS + 1);
      const sent = ['/a', '/b', '/c'].map((path) => queue.enqueue('path', path, tracked));
      await vi.advanceTimersByTimeAsync(LATENCY_MS);

      // All three together: straight after the pause they would have gone one at a time.
      await Promise.all(sent);
      expect(most).toBe(3);
    });

    describe('a refusal is not forgotten while purges from that recovery remain', () => {
      const countingInFlight = (outcome: PurgeOutcome, latencyMs: number) => {
        const seen: number[] = [];
        let inFlight = 0;
        const send = () => {
          seen.push(++inFlight);
          return new Promise<PurgeOutcome>((resolve) =>
            setTimeout(() => {
              inFlight--;
              resolve(outcome);
            }, latencyMs)
          );
        };
        return { send, seen };
      };

      it('when the timer that ends the pause fires long after it', async () => {
        const queue = new PurgeQueue(5);
        const { send, seen } = countingInFlight({ ok: false, status: 503 }, LATENCY_MS);

        void queue.enqueue('path', '/refused', overloaded(503));
        await vi.advanceTimersByTimeAsync(LATENCY_MS);
        const waiting = ['/a', '/b'].map((path) => queue.enqueue('path', path, send));
        // The instance gets no CPU until well past the pause, and wakes for a request that purges.
        vi.setSystemTime(Date.now() + 1000 + MAX_BACKOFF_MS + 1);
        waiting.push(queue.enqueue('path', '/c', send));
        await vi.advanceTimersByTimeAsync(1000 + LATENCY_MS);

        // One, and it is refused: the three together would have been a burst at a service still refusing.
        expect(seen).toEqual([1]);
        // The second refusal in a row, so the pause is the doubled one.
        expect(pauses()).toEqual([1000, 2000]);
        queue.stop();
        await Promise.all(waiting);
      });

      it('when requests keep timing out for longer than that', async () => {
        const queue = new PurgeQueue(5);
        const slowTimeout = MAX_BACKOFF_MS + 1000;
        const { send, seen } = countingInFlight({ ok: false, error: 'This operation was aborted' }, slowTimeout);

        void queue.enqueue('path', '/refused', overloaded(503));
        await vi.advanceTimersByTimeAsync(LATENCY_MS);
        const waiting = ['/a', '/b'].map((path) => queue.enqueue('path', path, send));
        // Requested while /b is in flight, and again between two requests: long after the pause both times.
        await vi.advanceTimersByTimeAsync(1000 + slowTimeout + 1);
        waiting.push(queue.enqueue('path', '/c', send), queue.enqueue('path', '/d', send));
        await vi.advanceTimersByTimeAsync(3 * slowTimeout);

        await Promise.all(waiting);
        expect(seen).toEqual([1, 1, 1, 1]);
      });

      it('but the pauses it had added up are forgotten with it once the queue has been empty that long', async () => {
        const queue = new PurgeQueue(1);
        const refused = overloaded(429, MAX_BACKOFF_MS);
        // Three refusals: 90 s of pauses, one short of giving up.
        for (let i = 0; i < 3; i++) {
          void queue.enqueue('key', `tag-${i}`, refused);
        }
        await vi.advanceTimersByTimeAsync(3 * (LATENCY_MS + MAX_BACKOFF_MS) + MAX_BACKOFF_MS + 1);

        void queue.enqueue('key', 'refused-again', refused);
        const kept = queue.enqueue('key', 'kept', answers(OK));
        await vi.advanceTimersByTimeAsync(LATENCY_MS + MAX_BACKOFF_MS + LATENCY_MS);

        expect((await kept).ok).toBe(true);
      });
    });

    describe('a refused full purge', () => {
      const refusedThenFine = (refusals: number) => {
        let calls = 0;
        return vi.fn(
          () =>
            new Promise<PurgeOutcome>((resolve) =>
              setTimeout(() => resolve(++calls > refusals ? OK : { ok: false, status: 503 }), LATENCY_MS)
            )
        );
      };

      it('is sent again after the pause, so the paths it covered are still purged', async () => {
        const queue = new PurgeQueue(1);
        const path = answers(OK);
        const full = refusedThenFine(1);

        void queue.enqueue('key', 'in-flight', answers(OK));
        const covered = queue.enqueue('path', '/a', path);
        const fullPurge = queue.enqueue('all', '', full);
        await vi.advanceTimersByTimeAsync(2 * LATENCY_MS + 1000 + LATENCY_MS);

        expect((await fullPurge).ok).toBe(true);
        expect((await covered).ok).toBe(true);
        expect(full).toHaveBeenCalledTimes(2);
        expect(path).not.toHaveBeenCalled();
      });

      it('is sent ahead of what was waiting behind it, and covers the paths among them', async () => {
        const queue = new PurgeQueue(1);
        const sent: string[] = [];
        const full = refusedThenFine(1);
        const named = (name: string) => () => {
          sent.push(name);
          return Promise.resolve(OK);
        };

        const fullPurge = queue.enqueue('all', '', () => {
          sent.push('full');
          return full();
        });
        // Requested while the full purge is in flight, so they wait behind it as purges of their own.
        await vi.advanceTimersByTimeAsync(LATENCY_MS / 2);
        const key = queue.enqueue('key', 'posts', named('key'));
        const path = queue.enqueue('path', '/late', named('path'));
        expect(queue.waitingPaths).toBe(1);
        await vi.advanceTimersByTimeAsync(LATENCY_MS / 2 + 1000 + LATENCY_MS);

        await Promise.all([fullPurge, key, path]);
        expect(sent).toEqual(['full', 'full', 'key']);
      });

      it('fails after its last attempt, with the paths it covered', async () => {
        const queue = new PurgeQueue(1);
        const full = refusedThenFine(Infinity);

        void queue.enqueue('key', 'in-flight', answers(OK));
        const covered = queue.enqueue('path', '/a', answers(OK));
        const fullPurge = queue.enqueue('all', '', full);
        await vi.advanceTimersByTimeAsync(60_000);

        expect(await fullPurge).toMatchObject({ ok: false, status: 503 });
        expect(await covered).toMatchObject({ ok: false, status: 503 });
        expect(FULL_PURGE_ATTEMPTS).toBe(3);
        expect(full).toHaveBeenCalledTimes(3);
      });

      it('serves a full purge requested while it was in flight with its next attempt', async () => {
        const queue = new PurgeQueue(1);
        const full = refusedThenFine(1);
        const second = answers(OK);

        const first = queue.enqueue('all', '', full);
        await vi.advanceTimersByTimeAsync(LATENCY_MS / 2);
        const repeat = queue.enqueue('all', '', second);
        await vi.advanceTimersByTimeAsync(LATENCY_MS + 1000 + LATENCY_MS);

        expect((await first).ok).toBe(true);
        expect((await repeat).ok).toBe(true);
        expect(full).toHaveBeenCalledTimes(2);
        expect(second).not.toHaveBeenCalled();
      });

      it('serves a full purge and paths requested while it waits for its next attempt', async () => {
        const queue = new PurgeQueue(1);
        const full = refusedThenFine(1);
        const second = answers(OK);
        const path = answers(OK);

        const first = queue.enqueue('all', '', full);
        await vi.advanceTimersByTimeAsync(LATENCY_MS + 500);
        const repeat = queue.enqueue('all', '', second);
        const joined = queue.enqueue('path', '/a', path);
        await vi.advanceTimersByTimeAsync(500 + LATENCY_MS);

        expect((await Promise.all([first, repeat, joined])).every((outcome) => outcome.ok)).toBe(true);
        expect(full).toHaveBeenCalledTimes(2);
        expect(second).not.toHaveBeenCalled();
        expect(path).not.toHaveBeenCalled();
      });

      it('waits a pause before its next attempt even when its refusal arrives after the pause has ended', async () => {
        const queue = new PurgeQueue(2);
        const sentAt: number[] = [];
        const start = Date.now();
        let calls = 0;
        // Sent alongside a path that is refused at once; its own refusal takes 3 s to arrive.
        const full = () => {
          sentAt.push(Date.now() - start);
          const refusedSlowly = ++calls === 1;
          return new Promise<PurgeOutcome>((resolve) =>
            setTimeout(
              () => resolve(refusedSlowly ? { ok: false, status: 503 } : OK),
              refusedSlowly ? 3000 : LATENCY_MS
            )
          );
        };

        void queue.enqueue('path', '/a', overloaded(503));
        const fullPurge = queue.enqueue('all', '', full);
        await vi.advanceTimersByTimeAsync(3000 + 1000 + LATENCY_MS);

        expect((await fullPurge).ok).toBe(true);
        expect(sentAt).toEqual([0, 4000]);
      });

      it('does not shorten a longer pause when its refusal arrives during it', async () => {
        const queue = new PurgeQueue(2);
        const sentAt: number[] = [];
        const start = Date.now();
        let calls = 0;
        const full = () => {
          sentAt.push(Date.now() - start);
          const refusedSlowly = ++calls === 1;
          return new Promise<PurgeOutcome>((resolve) =>
            setTimeout(
              () => resolve(refusedSlowly ? { ok: false, status: 503 } : OK),
              refusedSlowly ? 3000 : LATENCY_MS
            )
          );
        };

        // The path's refusal asks for 10 s; the full purge's own arrives 3 s into that.
        void queue.enqueue('path', '/a', overloaded(429, 10_000));
        const fullPurge = queue.enqueue('all', '', full);
        await vi.advanceTimersByTimeAsync(LATENCY_MS + 10_000 + LATENCY_MS);

        expect((await fullPurge).ok).toBe(true);
        expect(sentAt).toEqual([0, LATENCY_MS + 10_000]);
      });

      it('is not sent again if the queue was stopped while it was in flight', async () => {
        const queue = new PurgeQueue(1);
        const full = overloaded(503);

        const fullPurge = queue.enqueue('all', '', full);
        queue.stop();
        await vi.advanceTimersByTimeAsync(60_000);

        expect(await fullPurge).toMatchObject({ ok: false, status: 503 });
        expect(full).toHaveBeenCalledTimes(1);
      });

      it('is not sent again for an error that is not a refusal', async () => {
        const queue = new PurgeQueue(1);
        const full = answers({ ok: false, status: 404 });

        const fullPurge = queue.enqueue('all', '', full);
        await vi.advanceTimersByTimeAsync(60_000);

        expect(await fullPurge).toMatchObject({ ok: false, status: 404 });
        expect(full).toHaveBeenCalledTimes(1);
      });
    });

    describe('a purge service that keeps refusing', () => {
      // Pauses of 1, 2, 4, 8, 16, 30, 30 and 30 s: the eighth takes the sum to 121 s.
      const REFUSALS_TO_GIVE_UP = 8;
      const UNTIL_GIVEN_UP_MS = REFUSALS_TO_GIVE_UP * (LATENCY_MS + MAX_BACKOFF_MS);
      const notSent = (outcome: PurgeOutcome) => outcome.error?.startsWith('not sent') ?? false;
      const gaveUpLines = () =>
        warn.mock.calls.map((call: unknown[]) => String(call[0])).filter((line: string) => line.includes('gave up'));

      it('adds up to the limit on the eighth refusal with the default pauses', () => {
        expect(1000 + 2000 + 4000 + 8000 + 16000 + 2 * MAX_BACKOFF_MS).toBeLessThan(GIVE_UP_AFTER_PAUSED_MS);
        expect(1000 + 2000 + 4000 + 8000 + 16000 + 3 * MAX_BACKOFF_MS).toBeGreaterThanOrEqual(GIVE_UP_AFTER_PAUSED_MS);
      });

      it('gives up on what is waiting, says so once, and lets the process go', async () => {
        const queue = new PurgeQueue(1);
        const refused = overloaded(503);
        const keys = Array.from({ length: REFUSALS_TO_GIVE_UP + 3 }, (_, i) =>
          queue.enqueue('key', `tag-${i}`, refused)
        );
        const path = queue.enqueue('path', '/waiting', refused);
        await vi.advanceTimersByTimeAsync(UNTIL_GIVEN_UP_MS);

        const settled = await Promise.all([...keys, path]);
        expect(refused).toHaveBeenCalledTimes(REFUSALS_TO_GIVE_UP);
        expect(settled.slice(0, REFUSALS_TO_GIVE_UP).every((outcome) => outcome.status === 503)).toBe(true);
        expect(settled.slice(REFUSALS_TO_GIVE_UP)).toEqual(
          Array.from({ length: 4 }, () => ({
            ok: false,
            error: 'not sent: the purge service refused 8 requests in a row',
          }))
        );
        expect(gaveUpLines()).toEqual([
          '[EdgeCacheClear] Purge service answered HTTP 503: pausing edge purges for 30000 ms. ' +
            'It has refused 8 requests in a row through 121 s of pauses: gave up on 4 edge purges that were waiting. ' +
            'The CDN keeps those entries until they expire or are purged again',
        ]);
        expect(queue.waitingPaths).toBe(0);
        expect(vi.getTimerCount()).toBe(0);
      });

      it('takes the same purges again afterwards, and recovers when the service does', async () => {
        const queue = new PurgeQueue(1);
        const refused = overloaded(503);
        for (let i = 0; i < REFUSALS_TO_GIVE_UP; i++) {
          void queue.enqueue('key', `tag-${i}`, refused);
        }
        const givenUp = queue.enqueue('path', '/a', refused);
        await vi.advanceTimersByTimeAsync(UNTIL_GIVEN_UP_MS);
        expect(notSent(await givenUp)).toBe(true);

        // The purge that was given up on is asked for again, and is sent, not answered from the old one.
        const again = answers(OK);
        const later = queue.enqueue('path', '/a', again);
        await vi.advanceTimersByTimeAsync(MAX_BACKOFF_MS + LATENCY_MS);
        expect((await later).ok).toBe(true);
        expect(again).toHaveBeenCalledTimes(1);

        // Recovered: the next refusal starts from the shortest pause again.
        void queue.enqueue('path', '/b', overloaded(503));
        await vi.advanceTimersByTimeAsync(LATENCY_MS);
        expect(pauses().at(-1)).toBe(1000);
      });

      it('goes by how long it has paused, not by how many refusals there were', async () => {
        const queue = new PurgeQueue(1);
        // The service asks for 1 s each time: twelve refusals are twelve seconds of pauses.
        const refused = overloaded(429, 1000);
        const outcomes = Array.from({ length: 12 }, (_, i) => queue.enqueue('key', `tag-${i}`, refused));
        await vi.advanceTimersByTimeAsync(12 * (LATENCY_MS + 1000));

        expect((await Promise.all(outcomes)).some(notSent)).toBe(false);
        expect(refused).toHaveBeenCalledTimes(12);
        expect(gaveUpLines()).toEqual([]);
      });

      it('gives up after fewer refusals when the service asks for long pauses', async () => {
        const queue = new PurgeQueue(1);
        const refused = overloaded(429, MAX_BACKOFF_MS);
        const outcomes = Array.from({ length: 6 }, (_, i) => queue.enqueue('key', `tag-${i}`, refused));
        await vi.advanceTimersByTimeAsync(4 * (LATENCY_MS + MAX_BACKOFF_MS));

        // Four pauses of 30 s reach the limit.
        expect(refused).toHaveBeenCalledTimes(4);
        expect((await Promise.all(outcomes)).filter(notSent)).toHaveLength(2);
      });

      it('gives what is requested afterwards the same patience', async () => {
        const queue = new PurgeQueue(1);
        const refused = overloaded(503);
        for (let i = 0; i < REFUSALS_TO_GIVE_UP + 1; i++) {
          void queue.enqueue('key', `tag-${i}`, refused);
        }
        // To the eighth refusal exactly: seven pauses (1, 2, 4, 8, 16, 30 and 30 s) and eight requests.
        await vi.advanceTimersByTimeAsync(91_000 + REFUSALS_TO_GIVE_UP * LATENCY_MS);
        expect(gaveUpLines()).toHaveLength(1);

        // Three more straight away, still refused: 90 s of pauses, so each is sent and none is given up on.
        const later = ['x', 'y', 'z'].map((tag) => queue.enqueue('key', tag, refused));
        await vi.advanceTimersByTimeAsync(3 * (MAX_BACKOFF_MS + LATENCY_MS));

        expect((await Promise.all(later)).some(notSent)).toBe(false);
        expect(gaveUpLines()).toHaveLength(1);
        // Still the longest pause: giving up is not a sign that the service recovered.
        expect(pauses().slice(-3)).toEqual([MAX_BACKOFF_MS, MAX_BACKOFF_MS, MAX_BACKOFF_MS]);
      });

      it('does not count a pause lengthened by a response from the same burst twice', async () => {
        const queue = new PurgeQueue(2);
        const refused = overloaded(429, MAX_BACKOFF_MS);
        const refusedLater = vi.fn(
          () =>
            new Promise<PurgeOutcome>((resolve) =>
              setTimeout(() => resolve({ ok: false, status: 429, retryAfterMs: MAX_BACKOFF_MS }), 2 * LATENCY_MS)
            )
        );
        // Two refused together, then two more one at a time: three pauses of 30 s, not four.
        void queue.enqueue('key', 'burst-1', refused);
        void queue.enqueue('key', 'burst-2', refusedLater);
        void queue.enqueue('key', 'alone-1', refused);
        void queue.enqueue('key', 'alone-2', refused);
        const kept = queue.enqueue('key', 'kept', answers(OK));
        await vi.advanceTimersByTimeAsync(4 * (MAX_BACKOFF_MS + 2 * LATENCY_MS));

        expect((await kept).ok).toBe(true);
        expect(gaveUpLines()).toEqual([]);
      });

      it('starts the sum again once the service has answered normally', async () => {
        const queue = new PurgeQueue(1);
        const refused = overloaded(429, MAX_BACKOFF_MS);
        // Three refusals: 90 s of pauses. Then an answer.
        for (let i = 0; i < 3; i++) {
          void queue.enqueue('key', `tag-${i}`, refused);
        }
        void queue.enqueue('key', 'answered', answers(OK));
        await vi.advanceTimersByTimeAsync(3 * (LATENCY_MS + MAX_BACKOFF_MS) + LATENCY_MS);

        // One more refusal is 30 s, not 120 s, so what waits behind it is kept and sent.
        void queue.enqueue('key', 'refused-again', refused);
        const waiting = queue.enqueue('key', 'kept', answers(OK));
        await vi.advanceTimersByTimeAsync(LATENCY_MS + MAX_BACKOFF_MS + LATENCY_MS);

        expect((await waiting).ok).toBe(true);
        expect(gaveUpLines()).toEqual([]);
      });

      it('does not say it gave up when nothing was waiting', async () => {
        const queue = new PurgeQueue(1);
        for (let i = 0; i < REFUSALS_TO_GIVE_UP; i++) {
          void queue.enqueue('key', `tag-${i}`, overloaded(503));
          await vi.advanceTimersByTimeAsync(LATENCY_MS + MAX_BACKOFF_MS);
        }

        expect(pauses()).toHaveLength(REFUSALS_TO_GIVE_UP);
        expect(gaveUpLines()).toEqual([]);
      });

      it('does not send a full purge again once it has given up', async () => {
        const queue = new PurgeQueue(1);
        const refused = overloaded(503);
        for (let i = 0; i < REFUSALS_TO_GIVE_UP - 1; i++) {
          void queue.enqueue('key', `tag-${i}`, refused);
        }
        // Pauses of 1, 2, 4, 8, 16 and 30 s lie between the seven refusals.
        await vi.advanceTimersByTimeAsync(61_000 + 7 * LATENCY_MS);
        expect(refused).toHaveBeenCalledTimes(REFUSALS_TO_GIVE_UP - 1);

        // The full purge is the eighth.
        const full = overloaded(503);
        const fullPurge = queue.enqueue('all', '', full);
        await vi.advanceTimersByTimeAsync(MAX_BACKOFF_MS + LATENCY_MS);

        expect(await fullPurge).toMatchObject({ ok: false, status: 503 });
        expect(full).toHaveBeenCalledTimes(1);
        expect(vi.getTimerCount()).toBe(0);
      });
    });

    it('sends one request at a time after a pause until the service answers normally', async () => {
      const queue = new PurgeQueue(5);
      let inFlight = 0;
      const inFlightSeen: number[] = [];
      const send = () => {
        inFlight++;
        inFlightSeen.push(inFlight);
        return new Promise<PurgeOutcome>((resolve) =>
          setTimeout(() => {
            inFlight--;
            resolve(OK);
          }, LATENCY_MS)
        );
      };

      void queue.enqueue('path', '/throttled', overloaded(503));
      await vi.advanceTimersByTimeAsync(LATENCY_MS);
      const waiting = Array.from({ length: 6 }, (_, i) => queue.enqueue('path', `/p${i}`, send));
      await vi.advanceTimersByTimeAsync(1000 + 3 * LATENCY_MS);
      await Promise.all(waiting);

      // The first goes alone; once it is answered the other five go together.
      expect(inFlightSeen).toEqual([1, 1, 2, 3, 4, 5]);
    });

    it('stays at one request at a time while requests time out', async () => {
      const queue = new PurgeQueue(5);
      const timedOut = answers({ ok: false, error: 'This operation was aborted' });
      const sends = [timedOut, timedOut, answers(OK)];

      void queue.enqueue('path', '/throttled', overloaded(503));
      await vi.advanceTimersByTimeAsync(LATENCY_MS);
      sends.forEach((send, i) => void queue.enqueue('path', `/p${i}`, send));
      await vi.advanceTimersByTimeAsync(1000);

      expect(timedOut).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(LATENCY_MS);
      expect(timedOut).toHaveBeenCalledTimes(2);
      expect(sends[2]).not.toHaveBeenCalled();
    });

    it('still merges purges requested during the pause', async () => {
      const queue = new PurgeQueue(1);
      const send = answers(OK);

      void queue.enqueue('path', '/a', overloaded(429, 5000));
      await vi.advanceTimersByTimeAsync(LATENCY_MS);
      for (let i = 0; i < 400; i++) {
        void queue.enqueue('path', '/b', send);
      }
      await vi.advanceTimersByTimeAsync(5000 + LATENCY_MS);

      expect(send).toHaveBeenCalledTimes(1);
    });

    it('does not pause for errors that are not overload', async () => {
      const queue = new PurgeQueue(1);
      const next = answers(OK);

      void queue.enqueue('path', '/a', answers({ ok: false, status: 404 }));
      void queue.enqueue('path', '/b', answers({ ok: false, error: 'This operation was aborted' }));
      const last = queue.enqueue('path', '/c', next);
      await vi.advanceTimersByTimeAsync(3 * LATENCY_MS);

      expect((await last).ok).toBe(true);
      expect(warn).not.toHaveBeenCalled();
    });
  });

  it('keeps the process alive while purges wait out a pause', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const queue = new PurgeQueue(1);
    // No floor on the pause, so the 50 ms asked for is what this test waits.
    setPurgeBackoffBaseForTests(0);
    try {
      const throttled = queue.enqueue('path', '/a', async () => ({ ok: false, status: 429, retryAfterMs: 50 }));
      const waiting = queue.enqueue('path', '/b', async () => OK);
      await throttled;

      const timer = (queue as unknown as { timer: NodeJS.Timeout | null }).timer;
      expect(timer?.hasRef()).toBe(true);
      expect((await waiting).ok).toBe(true);
    } finally {
      setPurgeBackoffBaseForTests(1000);
      warn.mockRestore();
    }
  });

  it('stop() fails what has not started', async () => {
    const queue = new PurgeQueue(1);
    const inFlight = heldRequest();
    const never = vi.fn(async () => OK);

    const running = queue.enqueue('path', '/a', inFlight.send);
    await tick();
    const repeat = queue.enqueue('path', '/a', never);
    const waiting = queue.enqueue('path', '/b', never);
    queue.stop();
    inFlight.finish();

    expect((await running).ok).toBe(true);
    expect(await repeat).toEqual({ ok: false, error: 'purge queue stopped' });
    expect(await waiting).toEqual({ ok: false, error: 'purge queue stopped' });
    expect(never).not.toHaveBeenCalled();
  });
});

describe('purgeQueueFor', () => {
  afterEach(() => {
    resetPurgeQueuesForTests();
  });

  it('gives every clearer for one target the same queue', () => {
    expect(purgeQueueFor('http://proxy/cache')).toBe(purgeQueueFor('http://proxy/cache'));
    expect(purgeQueueFor('http://proxy/cache')).not.toBe(purgeQueueFor('http://other/cache'));
  });
});
