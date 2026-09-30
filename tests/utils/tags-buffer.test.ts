import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  TagsBuffer,
  resolveTagsFlushIntervalMs,
  DEFAULT_TAGS_FLUSH_INTERVAL_MS,
  MIN_TAGS_FLUSH_INTERVAL_MS,
  type TagsMapping,
} from '../../src/utils/tags-buffer.js';

function snapshot(mapping: TagsMapping = {}, generation: string | number = '1') {
  return { mapping: structuredClone(mapping), generation };
}

function httpError(code: number, message = `HTTP ${code}`) {
  return Object.assign(new Error(message), { code });
}

describe('TagsBuffer', () => {
  let mockRead: ReturnType<typeof vi.fn>;
  let mockWrite: ReturnType<typeof vi.fn>;
  let buffer: TagsBuffer;

  beforeEach(() => {
    vi.useFakeTimers();
    mockRead = vi.fn().mockImplementation(async () => snapshot());
    mockWrite = vi.fn().mockResolvedValue(undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    buffer?.destroy();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function createBuffer(flushIntervalMs = 1000, extra: Record<string, unknown> = {}) {
    buffer = new TagsBuffer({
      flushIntervalMs,
      readTagsMapping: mockRead,
      writeTagsMapping: mockWrite,
      handlerName: 'TestBuffer',
      ...extra,
    });
    return buffer;
  }

  describe('addTags', () => {
    it('should queue tag additions', () => {
      const buf = createBuffer();
      buf.addTags('key1', ['tag1', 'tag2']);

      expect(buf.pendingCount).toBe(1);
    });

    it('should not queue empty tags', () => {
      const buf = createBuffer();
      buf.addTags('key1', []);

      expect(buf.pendingCount).toBe(0);
    });

    it('should coalesce repeated updates for the same key', () => {
      const buf = createBuffer();
      buf.addTags('key1', ['tag1']);
      buf.addTags('key1', ['tag1', 'tag2']);

      expect(buf.pendingCount).toBe(1);
    });

    it('should schedule a flush after adding tags', async () => {
      const buf = createBuffer();
      buf.addTags('key1', ['tag1']);

      await vi.advanceTimersByTimeAsync(1100);

      expect(mockWrite).toHaveBeenCalled();
    });
  });

  describe('deleteKey', () => {
    it('should queue key deletion', () => {
      const buf = createBuffer();
      buf.deleteKey('key1');

      expect(buf.pendingCount).toBe(1);
    });
  });

  describe('deleteKeys', () => {
    it('should queue multiple key deletions', () => {
      const buf = createBuffer();
      buf.deleteKeys(['key1', 'key2', 'key3']);

      expect(buf.pendingCount).toBe(3);
    });

    it('should not schedule flush for empty array', () => {
      const buf = createBuffer();
      buf.deleteKeys([]);

      expect(buf.pendingCount).toBe(0);
    });
  });

  describe('flush', () => {
    it('should read, apply updates, and write with the read generation', async () => {
      mockRead.mockImplementation(async () => snapshot({ existingTag: ['existingKey'] }, '42'));

      const buf = createBuffer();
      buf.addTags('key1', ['tag1']);

      await buf.flush();

      expect(mockRead).toHaveBeenCalled();
      expect(mockWrite).toHaveBeenCalledWith({ existingTag: ['existingKey'], tag1: ['key1'] }, '42');
    });

    it('should pass generation 0 when the object does not exist yet', async () => {
      mockRead.mockImplementation(async () => snapshot({}, 0));

      const buf = createBuffer();
      buf.addTags('key1', ['tag1']);

      await buf.flush();

      expect(mockWrite).toHaveBeenCalledWith({ tag1: ['key1'] }, 0);
    });

    it('should merge multiple additions for same tag', async () => {
      const buf = createBuffer();
      buf.addTags('key1', ['tag1']);
      buf.addTags('key2', ['tag1']);

      await buf.flush();

      expect(mockWrite).toHaveBeenCalledWith({ tag1: ['key1', 'key2'] }, '1');
    });

    it('should handle deletions', async () => {
      mockRead.mockImplementation(async () => snapshot({ tag1: ['key1', 'key2'], tag2: ['key1'] }));

      const buf = createBuffer();
      buf.deleteKey('key1');

      await buf.flush();

      // tag2 is removed since it is now empty
      expect(mockWrite).toHaveBeenCalledWith({ tag1: ['key2'] }, '1');
    });

    it('should handle mixed additions and deletions', async () => {
      mockRead.mockImplementation(async () => snapshot({ tag1: ['oldKey'] }));

      const buf = createBuffer();
      buf.deleteKey('oldKey');
      buf.addTags('newKey', ['tag1', 'tag2']);

      await buf.flush();

      expect(mockWrite).toHaveBeenCalledWith({ tag1: ['newKey'], tag2: ['newKey'] }, '1');
    });

    it('should do nothing if no pending updates', async () => {
      const buf = createBuffer();

      await buf.flush();

      expect(mockRead).not.toHaveBeenCalled();
      expect(mockWrite).not.toHaveBeenCalled();
    });

    it('should clear pending updates after successful flush', async () => {
      const buf = createBuffer();
      buf.addTags('key1', ['tag1']);

      expect(buf.pendingCount).toBe(1);

      await buf.flush();

      expect(buf.pendingCount).toBe(0);
    });

    it('should skip the write when the mapping already contains the updates', async () => {
      mockRead.mockImplementation(async () => snapshot({ tag1: ['key1'] }));

      const buf = createBuffer();
      buf.addTags('key1', ['tag1']);
      buf.deleteKey('not-present');

      await buf.flush();

      expect(mockRead).toHaveBeenCalledTimes(1);
      expect(mockWrite).not.toHaveBeenCalled();
      expect(buf.pendingCount).toBe(0);
    });

    it('should retry on failure', async () => {
      mockWrite.mockRejectedValueOnce(new Error('Rate limited'));
      mockWrite.mockResolvedValueOnce(undefined);

      const buf = createBuffer();
      buf.addTags('key1', ['tag1']);

      await buf.flush();

      // Updates are restored for the retry
      expect(buf.pendingCount).toBe(1);

      // Backoff after one failure is at most 2x the interval
      await vi.advanceTimersByTimeAsync(2100);

      expect(mockWrite).toHaveBeenCalledTimes(2);
      expect(buf.pendingCount).toBe(0);
    });

    it('should keep updates queued while the write fails and merge new ones in', async () => {
      mockWrite.mockRejectedValue(httpError(429, 'rateLimitExceeded'));

      const buf = createBuffer();
      buf.addTags('key1', ['tag1']);
      await buf.flush();

      buf.addTags('key2', ['tag2']);
      expect(buf.pendingCount).toBe(2);

      mockWrite.mockResolvedValue(undefined);
      await buf.flush();

      expect(mockWrite).toHaveBeenLastCalledWith({ tag1: ['key1'], tag2: ['key2'] }, '1');
      expect(buf.pendingCount).toBe(0);
    });
  });

  describe('precondition conflicts', () => {
    it('should re-read and retry when the write hits a 412', async () => {
      mockRead
        .mockImplementationOnce(async () => snapshot({ a: ['k1'] }, '1'))
        .mockImplementationOnce(async () => snapshot({ a: ['k1'], b: ['k2'] }, '2'));
      mockWrite.mockRejectedValueOnce(httpError(412)).mockResolvedValueOnce(undefined);

      const buf = createBuffer();
      buf.addTags('k3', ['c']);

      await buf.flush();

      expect(mockRead).toHaveBeenCalledTimes(2);
      expect(mockWrite).toHaveBeenNthCalledWith(1, { a: ['k1'], c: ['k3'] }, '1');
      expect(mockWrite).toHaveBeenNthCalledWith(2, { a: ['k1'], b: ['k2'], c: ['k3'] }, '2');
      expect(buf.pendingCount).toBe(0);
    });

    it('should treat repeated 412s as a failed flush and keep the updates', async () => {
      mockWrite.mockRejectedValue(httpError(412));

      const buf = createBuffer(1000, { maxPreconditionRetries: 2 });
      buf.addTags('k1', ['a']);

      await buf.flush();

      expect(mockWrite).toHaveBeenCalledTimes(3);
      expect(buf.pendingCount).toBe(1);
    });
  });

  describe('overlay', () => {
    it('should apply pending updates to a copy without writing', async () => {
      const stored = { tag1: ['key1'], tag2: ['key1', 'key9'] };

      const buf = createBuffer();
      buf.addTags('key2', ['tag1', 'tag3']);
      buf.deleteKey('key9');

      const view = buf.overlay(stored);

      expect(view).toEqual({ tag1: ['key1', 'key2'], tag2: ['key1'], tag3: ['key2'] });
      expect(stored).toEqual({ tag1: ['key1'], tag2: ['key1', 'key9'] });
      expect(mockRead).not.toHaveBeenCalled();
      expect(mockWrite).not.toHaveBeenCalled();
      expect(buf.pendingCount).toBe(2);
    });
  });

  describe('flushIfDue', () => {
    it('should return null while the interval has not elapsed', () => {
      const buf = createBuffer(1000);
      buf.addTags('key1', ['tag1']);

      vi.advanceTimersByTime(500);

      expect(buf.flushIfDue()).toBeNull();
      expect(mockWrite).not.toHaveBeenCalled();
    });

    it('should flush once the interval has elapsed', async () => {
      const buf = createBuffer(1000);
      buf.addTags('key1', ['tag1']);

      vi.setSystemTime(Date.now() + 1000);

      const due = buf.flushIfDue();
      expect(due).not.toBeNull();
      await due;

      expect(mockWrite).toHaveBeenCalledTimes(1);
    });

    it('should return null with nothing pending', () => {
      const buf = createBuffer(1000);
      vi.setSystemTime(Date.now() + 5000);

      expect(buf.flushIfDue()).toBeNull();
    });

    it('should return null while backing off after a failure', async () => {
      vi.spyOn(Math, 'random').mockReturnValue(1); // no jitter: backoff = interval * 2^n
      mockWrite.mockRejectedValueOnce(httpError(429));

      const buf = createBuffer(1000);
      buf.addTags('key1', ['tag1']);
      await buf.flush();

      vi.setSystemTime(Date.now() + 1500);
      expect(buf.flushIfDue()).toBeNull();

      vi.setSystemTime(Date.now() + 600);
      const due = buf.flushIfDue();
      expect(due).not.toBeNull();
      await due;
      expect(mockWrite).toHaveBeenCalledTimes(2);
    });
  });

  describe('backoff', () => {
    it('should grow exponentially up to the cap', async () => {
      vi.spyOn(Math, 'random').mockReturnValue(1);
      mockWrite.mockRejectedValue(httpError(429));

      const buf = createBuffer(1000, { maxBackoffMs: 3000 });
      buf.addTags('key1', ['tag1']);

      await buf.flush(); // failure 1 -> next allowed in 2000ms
      expect(mockWrite).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(1900);
      expect(mockWrite).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(100); // t=2000: failure 2 -> next in 3000ms (capped from 4000)
      expect(mockWrite).toHaveBeenCalledTimes(2);

      await vi.advanceTimersByTimeAsync(2900); // t=4900
      expect(mockWrite).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(200); // t=5100
      expect(mockWrite).toHaveBeenCalledTimes(3);
    });

    it('should warn once per failure streak and once on recovery', async () => {
      mockWrite
        .mockRejectedValueOnce(httpError(429))
        .mockRejectedValueOnce(httpError(429))
        .mockResolvedValue(undefined);

      const buf = createBuffer(1000);
      buf.addTags('key1', ['tag1']);

      await buf.flush();
      await buf.flush();
      expect(console.warn).toHaveBeenCalledTimes(1);
      expect(vi.mocked(console.warn).mock.calls[0][0]).toContain('rate limited (429)');

      await buf.flush();
      expect(console.warn).toHaveBeenCalledTimes(2);
      expect(vi.mocked(console.warn).mock.calls[1][0]).toContain('recovered');
    });

    it('should drop the batch after too many consecutive failures', async () => {
      mockWrite.mockRejectedValue(httpError(429));

      const buf = createBuffer(1000, { maxConsecutiveFailures: 3 });
      buf.addTags('key1', ['tag1']);

      await buf.flush();
      await buf.flush();
      expect(buf.pendingCount).toBe(1);

      await buf.flush();
      expect(buf.pendingCount).toBe(0);
      expect(console.error).toHaveBeenCalledTimes(1);
      expect(vi.mocked(console.error).mock.calls[0][0]).toContain('Dropping 1 pending tag update(s)');

      // A later flush starts a fresh streak
      mockWrite.mockResolvedValue(undefined);
      buf.addTags('key2', ['tag2']);
      await buf.flush();
      expect(buf.pendingCount).toBe(0);
    });
  });

  describe('rate limiting', () => {
    it('should not flush more than once per interval', async () => {
      const buf = createBuffer(1000);

      buf.addTags('key1', ['tag1']);
      buf.addTags('key2', ['tag2']);
      buf.addTags('key3', ['tag3']);

      await vi.advanceTimersByTimeAsync(1100);

      expect(mockWrite).toHaveBeenCalledTimes(1);
      expect(mockWrite).toHaveBeenCalledWith({ tag1: ['key1'], tag2: ['key2'], tag3: ['key3'] }, '1');
    });

    it('should batch updates added before flush timer fires', async () => {
      const buf = createBuffer(1000);

      buf.addTags('key1', ['tag1']);
      buf.addTags('key2', ['tag2']);
      buf.addTags('key3', ['tag3']);

      expect(buf.pendingCount).toBe(3);

      await vi.advanceTimersByTimeAsync(1100);

      expect(mockWrite).toHaveBeenCalledTimes(1);
      expect(mockWrite).toHaveBeenCalledWith({ tag1: ['key1'], tag2: ['key2'], tag3: ['key3'] }, '1');
    });

    it('should wait a full interval before flushing updates queued during a flush', async () => {
      const buf = createBuffer(1000);
      buf.addTags('key1', ['tag1']);

      await vi.advanceTimersByTimeAsync(1000);
      expect(mockWrite).toHaveBeenCalledTimes(1);

      buf.addTags('key2', ['tag2']);
      await vi.advanceTimersByTimeAsync(900);
      expect(mockWrite).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(200);
      expect(mockWrite).toHaveBeenCalledTimes(2);
    });
  });

  describe('concurrent flush protection', () => {
    it('should wait for ongoing flush before starting another', async () => {
      vi.useRealTimers();

      let writeCallCount = 0;
      mockWrite.mockImplementation(async () => {
        writeCallCount++;
        await new Promise((r) => setTimeout(r, 50));
      });

      const buf = createBuffer();
      buf.addTags('key1', ['tag1']);

      const flush1 = buf.flush();

      buf.addTags('key2', ['tag2']);
      const flush2 = buf.flush();

      await Promise.all([flush1, flush2]);

      expect(writeCallCount).toBe(2);
    });
  });

  describe('destroy', () => {
    it('should cancel pending flush timer', async () => {
      const buf = createBuffer();
      buf.addTags('key1', ['tag1']);

      buf.destroy();

      await vi.advanceTimersByTimeAsync(2000);

      expect(mockWrite).not.toHaveBeenCalled();
    });
  });
});

describe('resolveTagsFlushIntervalMs', () => {
  it('defaults when unset or blank', () => {
    expect(resolveTagsFlushIntervalMs(undefined)).toBe(DEFAULT_TAGS_FLUSH_INTERVAL_MS);
    expect(resolveTagsFlushIntervalMs('')).toBe(DEFAULT_TAGS_FLUSH_INTERVAL_MS);
    expect(resolveTagsFlushIntervalMs('  ')).toBe(DEFAULT_TAGS_FLUSH_INTERVAL_MS);
  });

  it('defaults when not a number', () => {
    expect(resolveTagsFlushIntervalMs('fast')).toBe(DEFAULT_TAGS_FLUSH_INTERVAL_MS);
  });

  it('clamps to the per-object write rate', () => {
    expect(resolveTagsFlushIntervalMs('250')).toBe(MIN_TAGS_FLUSH_INTERVAL_MS);
    expect(resolveTagsFlushIntervalMs('0')).toBe(MIN_TAGS_FLUSH_INTERVAL_MS);
  });

  it('accepts larger values', () => {
    expect(resolveTagsFlushIntervalMs('8000')).toBe(8000);
    expect(resolveTagsFlushIntervalMs('8000.9')).toBe(8000);
  });
});
