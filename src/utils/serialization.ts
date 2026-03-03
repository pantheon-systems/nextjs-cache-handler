import type { CacheData, SerializedCacheData, SerializableValue, SerializedBuffer, SerializedMap } from '../types.js';

/**
 * Serializes cache data for JSON storage.
 * Converts Buffers to base64 strings and Maps to serializable objects.
 */
export function serializeForStorage(data: CacheData): SerializedCacheData {
  const serialized: SerializedCacheData = {};

  for (const [key, entry] of Object.entries(data)) {
    if (!isValidCacheEntry(entry)) {
      serialized[key] = entry as SerializedCacheData[string];
      continue;
    }

    const value = (entry as { value: unknown }).value;

    if (!value || typeof value !== 'object') {
      serialized[key] = entry as SerializedCacheData[string];
      continue;
    }

    const serializedValue = serializeValue(value as Record<string, unknown>);
    serialized[key] = {
      ...(entry as SerializedCacheData[string]),
      value: serializedValue,
    };
  }

  return serialized;
}

/**
 * Deserializes cache data from JSON storage.
 * Converts base64 strings back to Buffers and serialized Maps back to Map objects.
 */
export function deserializeFromStorage(data: SerializedCacheData): CacheData {
  const deserialized: CacheData = {};

  for (const [key, entry] of Object.entries(data)) {
    if (!isValidCacheEntry(entry)) {
      deserialized[key] = entry;
      continue;
    }

    const value = entry.value;

    if (!value || typeof value !== 'object') {
      deserialized[key] = entry;
      continue;
    }

    const deserializedValue = deserializeValue(value as Record<string, unknown>);
    deserialized[key] = {
      ...entry,
      value: deserializedValue,
    };
  }

  return deserialized;
}

function isValidCacheEntry(entry: unknown): boolean {
  return entry !== null && typeof entry === 'object' && 'value' in entry;
}

function serializeValue(value: Record<string, unknown>): SerializableValue {
  const serializedValue: Record<string, unknown> = { ...value };

  // Convert body Buffer to base64 string for storage
  if (isBuffer(serializedValue.body)) {
    serializedValue.body = bufferToSerializable(serializedValue.body as Buffer);
  }

  // Handle rscData if it's a Buffer
  if (isBuffer(serializedValue.rscData)) {
    serializedValue.rscData = bufferToSerializable(serializedValue.rscData as Buffer);
  }

  // Handle segmentData if it's a Map with Buffers
  if (serializedValue.segmentData instanceof Map) {
    serializedValue.segmentData = mapToSerializable(serializedValue.segmentData);
  }

  return serializedValue;
}

function deserializeValue(value: Record<string, unknown>): Record<string, unknown> {
  const deserializedValue: Record<string, unknown> = { ...value };

  // Convert base64 string back to Buffer for body
  if (isSerializedBuffer(deserializedValue.body)) {
    deserializedValue.body = serializableToBuffer(deserializedValue.body as SerializedBuffer);
  }

  // Convert base64 string back to Buffer for rscData
  if (isSerializedBuffer(deserializedValue.rscData)) {
    deserializedValue.rscData = serializableToBuffer(deserializedValue.rscData as SerializedBuffer);
  }

  // Convert serialized Map back to Map with Buffers
  if (isSerializedMap(deserializedValue.segmentData)) {
    deserializedValue.segmentData = serializableToMap(deserializedValue.segmentData as SerializedMap);
  }

  return deserializedValue;
}

function isBuffer(value: unknown): boolean {
  return Buffer.isBuffer(value);
}

function isSerializedBuffer(value: unknown): boolean {
  return (
    value !== null &&
    typeof value === 'object' &&
    'type' in value &&
    (value as SerializedBuffer).type === 'Buffer' &&
    'data' in value
  );
}

function isSerializedMap(value: unknown): boolean {
  return (
    value !== null &&
    typeof value === 'object' &&
    'type' in value &&
    (value as SerializedMap).type === 'Map' &&
    'data' in value
  );
}

function bufferToSerializable(buffer: Buffer): SerializedBuffer {
  return {
    type: 'Buffer',
    data: buffer.toString('base64'),
  };
}

function serializableToBuffer(serialized: SerializedBuffer): Buffer {
  return Buffer.from(serialized.data, 'base64');
}

function mapToSerializable(map: Map<string, unknown>): SerializedMap {
  const segmentObj: Record<string, SerializableValue> = {};

  for (const [segKey, segValue] of map.entries()) {
    if (Buffer.isBuffer(segValue)) {
      segmentObj[segKey] = bufferToSerializable(segValue);
    } else {
      segmentObj[segKey] = segValue as SerializableValue;
    }
  }

  return {
    type: 'Map',
    data: segmentObj,
  };
}

function serializableToMap(serialized: SerializedMap): Map<string, unknown> {
  const segmentMap = new Map<string, unknown>();

  for (const [segKey, segValue] of Object.entries(serialized.data)) {
    if (isSerializedBuffer(segValue)) {
      segmentMap.set(segKey, serializableToBuffer(segValue as SerializedBuffer));
    } else {
      segmentMap.set(segKey, segValue);
    }
  }

  return segmentMap;
}
