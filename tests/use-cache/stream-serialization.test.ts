import { describe, it, expect } from 'vitest';
import {
  streamToBytes,
  bytesToStream,
  serializeUseCacheEntry,
  deserializeUseCacheEntry,
} from '../../src/use-cache/stream-serialization.js';
import type { UseCacheEntry } from '../../src/use-cache/types.js';

describe('streamToBytes', () => {
  it('should convert a ReadableStream to Uint8Array', async () => {
    const data = new Uint8Array([1, 2, 3, 4, 5]);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(data);
        controller.close();
      },
    });

    const result = await streamToBytes(stream);

    expect(result).toBeInstanceOf(Uint8Array);
    expect(Array.from(result)).toEqual([1, 2, 3, 4, 5]);
  });

  it('should handle multiple chunks', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2]));
        controller.enqueue(new Uint8Array([3, 4]));
        controller.enqueue(new Uint8Array([5]));
        controller.close();
      },
    });

    const result = await streamToBytes(stream);

    expect(Array.from(result)).toEqual([1, 2, 3, 4, 5]);
  });

  it('should handle empty stream', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.close();
      },
    });

    const result = await streamToBytes(stream);

    expect(result).toBeInstanceOf(Uint8Array);
    expect(result.length).toBe(0);
  });

  it('should handle large data', async () => {
    const largeData = new Uint8Array(100000);
    for (let i = 0; i < largeData.length; i++) {
      largeData[i] = i % 256;
    }

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        // Send in chunks
        const chunkSize = 16384;
        for (let i = 0; i < largeData.length; i += chunkSize) {
          controller.enqueue(largeData.slice(i, i + chunkSize));
        }
        controller.close();
      },
    });

    const result = await streamToBytes(stream);

    expect(result.length).toBe(100000);
    expect(result[0]).toBe(0);
    expect(result[255]).toBe(255);
    expect(result[256]).toBe(0);
  });
});

describe('bytesToStream', () => {
  it('should convert Uint8Array to ReadableStream', async () => {
    const data = new Uint8Array([1, 2, 3, 4, 5]);
    const stream = bytesToStream(data);

    expect(stream).toBeInstanceOf(ReadableStream);

    // Read the stream to verify content
    const reader = stream.getReader();
    const { value, done } = await reader.read();

    expect(done).toBe(false);
    expect(Array.from(value!)).toEqual([1, 2, 3, 4, 5]);

    const { done: done2 } = await reader.read();
    expect(done2).toBe(true);
  });

  it('should handle empty Uint8Array', async () => {
    const data = new Uint8Array([]);
    const stream = bytesToStream(data);

    const reader = stream.getReader();
    const { value, done } = await reader.read();

    // Empty array should still enqueue, then close
    expect(value?.length ?? 0).toBe(0);
  });

  it('should create a reusable stream', async () => {
    const data = new Uint8Array([10, 20, 30]);
    const stream = bytesToStream(data);

    // First read
    const reader = stream.getReader();
    const chunks: Uint8Array[] = [];

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      chunks.push(value);
    }

    const combined = new Uint8Array(chunks.reduce((acc, c) => acc + c.length, 0));
    let offset = 0;
    for (const chunk of chunks) {
      combined.set(chunk, offset);
      offset += chunk.length;
    }

    expect(Array.from(combined)).toEqual([10, 20, 30]);
  });
});

describe('round-trip stream conversion', () => {
  it('should preserve data through stream -> bytes -> stream', async () => {
    const originalData = new Uint8Array([100, 200, 50, 25, 0, 255]);

    // Create initial stream
    const stream1 = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(originalData);
        controller.close();
      },
    });

    // Convert to bytes
    const bytes = await streamToBytes(stream1);

    // Convert back to stream
    const stream2 = bytesToStream(bytes);

    // Read and verify
    const finalBytes = await streamToBytes(stream2);

    expect(Array.from(finalBytes)).toEqual(Array.from(originalData));
  });
});

describe('serializeUseCacheEntry', () => {
  it('should serialize entry with stream to storable format', async () => {
    const data = new Uint8Array([1, 2, 3]);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(data);
        controller.close();
      },
    });

    const entry: UseCacheEntry = {
      value: stream,
      tags: ['tag1', 'tag2'],
      stale: 60,
      timestamp: 1234567890,
      expire: 3600,
      revalidate: 300,
    };

    const serialized = await serializeUseCacheEntry(entry);

    // Should have bytes as base64 string
    expect(typeof serialized.value).toBe('string');
    expect(serialized.tags).toEqual(['tag1', 'tag2']);
    expect(serialized.stale).toBe(60);
    expect(serialized.timestamp).toBe(1234567890);
    expect(serialized.expire).toBe(3600);
    expect(serialized.revalidate).toBe(300);
  });

  it('should preserve all metadata fields', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.close();
      },
    });

    const entry: UseCacheEntry = {
      value: stream,
      tags: [],
      stale: 0,
      timestamp: 0,
      expire: 0,
      revalidate: 0,
    };

    const serialized = await serializeUseCacheEntry(entry);

    expect(serialized.stale).toBe(0);
    expect(serialized.timestamp).toBe(0);
    expect(serialized.expire).toBe(0);
    expect(serialized.revalidate).toBe(0);
  });
});

describe('deserializeUseCacheEntry', () => {
  it('should deserialize stored format back to UseCacheEntry', async () => {
    const data = new Uint8Array([1, 2, 3]);
    const base64Value = Buffer.from(data).toString('base64');

    const stored = {
      value: base64Value,
      tags: ['tag1'],
      stale: 60,
      timestamp: 1234567890,
      expire: 3600,
      revalidate: 300,
    };

    const entry = deserializeUseCacheEntry(stored);

    expect(entry.value).toBeInstanceOf(ReadableStream);
    expect(entry.tags).toEqual(['tag1']);
    expect(entry.stale).toBe(60);
    expect(entry.timestamp).toBe(1234567890);

    // Verify stream content
    const bytes = await streamToBytes(entry.value);
    expect(Array.from(bytes)).toEqual([1, 2, 3]);
  });

  it('should handle empty value', async () => {
    const stored = {
      value: '',
      tags: [],
      stale: 0,
      timestamp: 0,
      expire: 0,
      revalidate: 0,
    };

    const entry = deserializeUseCacheEntry(stored);

    expect(entry.value).toBeInstanceOf(ReadableStream);
    const bytes = await streamToBytes(entry.value);
    expect(bytes.length).toBe(0);
  });
});

describe('round-trip serialization', () => {
  it('should preserve entry through serialize/deserialize cycle', async () => {
    const originalData = new Uint8Array([10, 20, 30, 40, 50]);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(originalData);
        controller.close();
      },
    });

    const originalEntry: UseCacheEntry = {
      value: stream,
      tags: ['blog', 'posts'],
      stale: 120,
      timestamp: Date.now(),
      expire: 7200,
      revalidate: 600,
    };

    // Serialize
    const serialized = await serializeUseCacheEntry(originalEntry);

    // Deserialize
    const restored = deserializeUseCacheEntry(serialized);

    // Verify metadata
    expect(restored.tags).toEqual(['blog', 'posts']);
    expect(restored.stale).toBe(120);
    expect(restored.timestamp).toBe(originalEntry.timestamp);
    expect(restored.expire).toBe(7200);
    expect(restored.revalidate).toBe(600);

    // Verify stream content
    const restoredBytes = await streamToBytes(restored.value);
    expect(Array.from(restoredBytes)).toEqual(Array.from(originalData));
  });
});
