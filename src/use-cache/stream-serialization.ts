import type { UseCacheEntry, SerializedUseCacheEntry } from './types.js';

/**
 * Convert a ReadableStream<Uint8Array> to a Uint8Array.
 * Consumes the entire stream and concatenates all chunks.
 *
 * @param stream - The stream to consume
 * @returns A single Uint8Array containing all the stream data
 */
export async function streamToBytes(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
    }
  }

  // Handle empty stream
  if (chunks.length === 0) {
    return new Uint8Array(0);
  }

  // Single chunk optimization
  if (chunks.length === 1) {
    return chunks[0];
  }

  // Concatenate all chunks
  const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }

  return result;
}

/**
 * Convert a Uint8Array to a ReadableStream<Uint8Array>.
 * Creates a stream that emits the entire array as a single chunk.
 *
 * @param bytes - The bytes to convert to a stream
 * @returns A ReadableStream that emits the bytes
 */
export function bytesToStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

/**
 * Serialize a UseCacheEntry for persistent storage.
 * Converts the ReadableStream value to a base64-encoded string.
 *
 * @param entry - The cache entry to serialize
 * @returns A serialized entry suitable for JSON storage
 */
export async function serializeUseCacheEntry(entry: UseCacheEntry): Promise<SerializedUseCacheEntry> {
  // Convert stream to bytes
  const bytes = await streamToBytes(entry.value);

  // Convert bytes to base64 for JSON-safe storage
  const base64Value = Buffer.from(bytes).toString('base64');

  return {
    value: base64Value,
    tags: entry.tags,
    stale: entry.stale,
    timestamp: entry.timestamp,
    expire: entry.expire,
    revalidate: entry.revalidate,
  };
}

/**
 * Deserialize a stored cache entry back to UseCacheEntry.
 * Converts the base64-encoded value back to a ReadableStream.
 *
 * @param stored - The serialized entry from storage
 * @returns A UseCacheEntry with a ReadableStream value
 */
export function deserializeUseCacheEntry(stored: SerializedUseCacheEntry): UseCacheEntry {
  // Convert base64 back to bytes
  const bytes = stored.value ? Buffer.from(stored.value, 'base64') : new Uint8Array(0);

  // Convert bytes to Uint8Array (Buffer is a subclass, but be explicit)
  const uint8Array = new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  // Create stream from bytes
  const stream = bytesToStream(uint8Array);

  return {
    value: stream,
    tags: stored.tags,
    stale: stored.stale,
    timestamp: stored.timestamp,
    expire: stored.expire,
    revalidate: stored.revalidate,
  };
}
