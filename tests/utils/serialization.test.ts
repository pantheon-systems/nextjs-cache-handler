import { describe, it, expect } from 'vitest';
import { serializeForStorage, deserializeFromStorage } from '../../src/utils/serialization.js';

describe('serialization', () => {
  describe('serializeForStorage', () => {
    it('should pass through simple cache data unchanged', () => {
      const data = {
        'test-key': {
          value: { kind: 'FETCH', data: 'test' },
          lastModified: 1234567890,
          tags: ['tag1'],
        },
      };

      const result = serializeForStorage(data);

      expect(result['test-key'].value).toEqual({ kind: 'FETCH', data: 'test' });
      expect(result['test-key'].lastModified).toBe(1234567890);
    });

    it('should convert Buffer body to base64 serialized format', () => {
      const buffer = Buffer.from('hello world');
      const data = {
        'test-key': {
          value: { body: buffer },
          lastModified: 1234567890,
          tags: [],
        },
      };

      const result = serializeForStorage(data);

      expect(result['test-key'].value).toEqual({
        body: {
          type: 'Buffer',
          data: buffer.toString('base64'),
        },
      });
    });

    it('should convert Buffer rscData to base64 serialized format', () => {
      const buffer = Buffer.from('rsc content');
      const data = {
        'test-key': {
          value: { rscData: buffer },
          lastModified: 1234567890,
          tags: [],
        },
      };

      const result = serializeForStorage(data);

      expect(result['test-key'].value).toEqual({
        rscData: {
          type: 'Buffer',
          data: buffer.toString('base64'),
        },
      });
    });

    it('should convert the image cache buffer to base64 serialized format', () => {
      const buffer = Buffer.from('fake-jpeg-bytes');
      const data = {
        'test-key': {
          value: { kind: 'IMAGE', etag: 'abc', upstreamEtag: 'def', extension: 'jpg', buffer },
          lastModified: 1234567890,
          tags: [],
        },
      };

      const result = serializeForStorage(data);

      expect(result['test-key'].value).toEqual({
        kind: 'IMAGE',
        etag: 'abc',
        upstreamEtag: 'def',
        extension: 'jpg',
        buffer: {
          type: 'Buffer',
          data: buffer.toString('base64'),
        },
      });
    });

    it('should convert Map with Buffers to serialized format', () => {
      const segmentMap = new Map<string, Buffer>();
      segmentMap.set('segment1', Buffer.from('data1'));
      segmentMap.set('segment2', Buffer.from('data2'));

      const data = {
        'test-key': {
          value: { segmentData: segmentMap },
          lastModified: 1234567890,
          tags: [],
        },
      };

      const result = serializeForStorage(data);

      expect(result['test-key'].value).toEqual({
        segmentData: {
          type: 'Map',
          data: {
            segment1: { type: 'Buffer', data: Buffer.from('data1').toString('base64') },
            segment2: { type: 'Buffer', data: Buffer.from('data2').toString('base64') },
          },
        },
      });
    });

    it('should handle entries without value property', () => {
      const data = {
        'test-key': 'simple-value',
      };

      const result = serializeForStorage(data as any);

      expect(result['test-key']).toBe('simple-value');
    });
  });

  describe('deserializeFromStorage', () => {
    it('should pass through simple data unchanged', () => {
      const data = {
        'test-key': {
          value: { kind: 'FETCH', data: 'test' },
          lastModified: 1234567890,
          tags: ['tag1'],
        },
      };

      const result = deserializeFromStorage(data);

      expect(result['test-key']).toEqual(data['test-key']);
    });

    it('should convert serialized body back to Buffer', () => {
      const originalContent = 'hello world';
      const data = {
        'test-key': {
          value: {
            body: {
              type: 'Buffer' as const,
              data: Buffer.from(originalContent).toString('base64'),
            },
          },
          lastModified: 1234567890,
          tags: [],
        },
      };

      const result = deserializeFromStorage(data);

      expect(Buffer.isBuffer((result['test-key'] as any).value.body)).toBe(true);
      expect((result['test-key'] as any).value.body.toString()).toBe(originalContent);
    });

    it('should convert serialized rscData back to Buffer', () => {
      const originalContent = 'rsc content';
      const data = {
        'test-key': {
          value: {
            rscData: {
              type: 'Buffer' as const,
              data: Buffer.from(originalContent).toString('base64'),
            },
          },
          lastModified: 1234567890,
          tags: [],
        },
      };

      const result = deserializeFromStorage(data);

      expect(Buffer.isBuffer((result['test-key'] as any).value.rscData)).toBe(true);
      expect((result['test-key'] as any).value.rscData.toString()).toBe(originalContent);
    });

    it('should convert the serialized image cache buffer back to a Buffer', () => {
      const originalContent = 'fake-jpeg-bytes';
      const data = {
        'test-key': {
          value: {
            kind: 'IMAGE' as const,
            buffer: {
              type: 'Buffer' as const,
              data: Buffer.from(originalContent).toString('base64'),
            },
          },
          lastModified: 1234567890,
          tags: [],
        },
      };

      const result = deserializeFromStorage(data);

      expect(Buffer.isBuffer((result['test-key'] as any).value.buffer)).toBe(true);
      expect((result['test-key'] as any).value.buffer.toString()).toBe(originalContent);
    });

    it('should convert serialized Map back to Map with Buffers', () => {
      const data = {
        'test-key': {
          value: {
            segmentData: {
              type: 'Map' as const,
              data: {
                segment1: { type: 'Buffer' as const, data: Buffer.from('data1').toString('base64') },
                segment2: { type: 'Buffer' as const, data: Buffer.from('data2').toString('base64') },
              },
            },
          },
          lastModified: 1234567890,
          tags: [],
        },
      };

      const result = deserializeFromStorage(data);

      const segmentData = (result['test-key'] as any).value.segmentData;
      expect(segmentData instanceof Map).toBe(true);
      expect(Buffer.isBuffer(segmentData.get('segment1'))).toBe(true);
      expect(segmentData.get('segment1').toString()).toBe('data1');
      expect(segmentData.get('segment2').toString()).toBe('data2');
    });
  });

  describe('round-trip serialization', () => {
    it('should preserve data through serialize/deserialize cycle', () => {
      const buffer = Buffer.from('test content');
      const segmentMap = new Map<string, Buffer>();
      segmentMap.set('seg1', Buffer.from('segment1'));

      const original = {
        'cache-key': {
          value: {
            kind: 'APP_PAGE',
            body: buffer,
            rscData: Buffer.from('rsc'),
            segmentData: segmentMap,
            otherData: 'preserved',
          },
          lastModified: Date.now(),
          tags: ['tag1', 'tag2'],
        },
      };

      const serialized = serializeForStorage(original);
      const deserialized = deserializeFromStorage(serialized);

      const result = deserialized['cache-key'] as any;
      expect(result.value.kind).toBe('APP_PAGE');
      expect(result.value.body.toString()).toBe('test content');
      expect(result.value.rscData.toString()).toBe('rsc');
      expect(result.value.segmentData.get('seg1').toString()).toBe('segment1');
      expect(result.value.otherData).toBe('preserved');
      expect(result.tags).toEqual(['tag1', 'tag2']);
    });
  });
});
