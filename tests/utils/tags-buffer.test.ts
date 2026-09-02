import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TagsBuffer } from '../../src/utils/tags-buffer.js';

describe('TagsBuffer', () => {
  let mockRead: ReturnType<typeof vi.fn>;
  let mockWrite: ReturnType<typeof vi.fn>;
  let buffer: TagsBuffer;

  beforeEach(() => {
    vi.useFakeTimers();
    mockRead = vi.fn().mockResolvedValue({});
    mockWrite = vi.fn().mockResolvedValue(undefined);
  });

  afterEach(() => {
    buffer?.destroy();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function createBuffer(flushIntervalMs = 1000) {
    buffer = new TagsBuffer({
      flushIntervalMs,
      readTagsMapping: mockRead,
      writeTagsMapping: mockWrite,
      handlerName: 'TestBuffer',
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

    it('should schedule a flush after adding tags', async () => {
      const buf = createBuffer();
      buf.addTags('key1', ['tag1']);

      // Fast-forward past flush interval
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
    it('should read, apply updates, and write', async () => {
      mockRead.mockResolvedValue({ existingTag: ['existingKey'] });

      const buf = createBuffer();
      buf.addTags('key1', ['tag1']);

      await buf.flush();

      expect(mockRead).toHaveBeenCalled();
      expect(mockWrite).toHaveBeenCalledWith({
        existingTag: ['existingKey'],
        tag1: ['key1'],
      });
    });

    it('should merge multiple additions for same tag', async () => {
      const buf = createBuffer();
      buf.addTags('key1', ['tag1']);
      buf.addTags('key2', ['tag1']);

      await buf.flush();

      expect(mockWrite).toHaveBeenCalledWith({
        tag1: ['key1', 'key2'],
      });
    });

    it('should handle deletions', async () => {
      mockRead.mockResolvedValue({
        tag1: ['key1', 'key2'],
        tag2: ['key1'],
      });

      const buf = createBuffer();
      buf.deleteKey('key1');

      await buf.flush();

      expect(mockWrite).toHaveBeenCalledWith({
        tag1: ['key2'],
        // tag2 should be removed since it's now empty
      });
    });

    it('should handle mixed additions and deletions', async () => {
      mockRead.mockResolvedValue({
        tag1: ['oldKey'],
      });

      const buf = createBuffer();
      buf.deleteKey('oldKey');
      buf.addTags('newKey', ['tag1', 'tag2']);

      await buf.flush();

      expect(mockWrite).toHaveBeenCalledWith({
        tag1: ['newKey'],
        tag2: ['newKey'],
      });
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

    it('should retry on failure', async () => {
      mockWrite.mockRejectedValueOnce(new Error('Rate limited'));
      mockWrite.mockResolvedValueOnce(undefined);

      const buf = createBuffer();
      buf.addTags('key1', ['tag1']);

      // First flush will fail
      await buf.flush();

      // Updates should be restored
      expect(buf.pendingCount).toBe(1);

      // Reset read mock for retry
      mockRead.mockResolvedValue({});

      // Fast-forward to retry
      await vi.advanceTimersByTimeAsync(2100);

      expect(mockWrite).toHaveBeenCalledTimes(2);
    });
  });

  describe('rate limiting', () => {
    it('should not flush more than once per interval', async () => {
      const buf = createBuffer(1000);

      buf.addTags('key1', ['tag1']);
      buf.addTags('key2', ['tag2']);
      buf.addTags('key3', ['tag3']);

      // Fast-forward just past the interval
      await vi.advanceTimersByTimeAsync(1100);

      // Should have flushed once with all updates batched
      expect(mockWrite).toHaveBeenCalledTimes(1);
      expect(mockWrite).toHaveBeenCalledWith({
        tag1: ['key1'],
        tag2: ['key2'],
        tag3: ['key3'],
      });
    });

    it('should batch updates added before flush timer fires', async () => {
      const buf = createBuffer(1000);

      // Add first update - this schedules flush in 1000ms
      buf.addTags('key1', ['tag1']);

      // Add more updates before the timer fires (these should be batched)
      buf.addTags('key2', ['tag2']);
      buf.addTags('key3', ['tag3']);

      expect(buf.pendingCount).toBe(3);

      // Fast-forward to trigger the flush
      await vi.advanceTimersByTimeAsync(1100);

      // All updates should be in a single write
      expect(mockWrite).toHaveBeenCalledTimes(1);
      expect(mockWrite).toHaveBeenCalledWith({
        tag1: ['key1'],
        tag2: ['key2'],
        tag3: ['key3'],
      });
    });
  });

  describe('concurrent flush protection', () => {
    it('should wait for ongoing flush before starting another', async () => {
      vi.useRealTimers(); // Use real timers for this async test

      let writeCallCount = 0;
      mockWrite.mockImplementation(async () => {
        writeCallCount++;
        // Simulate slow write
        await new Promise((r) => setTimeout(r, 50));
      });

      const buf = createBuffer();
      buf.addTags('key1', ['tag1']);

      // Start first flush
      const flush1 = buf.flush();

      // Add more and try to flush again while first is in progress
      buf.addTags('key2', ['tag2']);
      const flush2 = buf.flush();

      // Wait for both
      await Promise.all([flush1, flush2]);

      // Both flushes should have completed
      expect(writeCallCount).toBe(2);
    });
  });

  describe('destroy', () => {
    it('should cancel pending flush timer', async () => {
      const buf = createBuffer();
      buf.addTags('key1', ['tag1']);

      buf.destroy();

      // Fast-forward past when flush would have occurred
      await vi.advanceTimersByTimeAsync(2000);

      // Flush should not have happened
      expect(mockWrite).not.toHaveBeenCalled();
    });
  });
});
