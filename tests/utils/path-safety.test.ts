import { describe, it, expect } from 'vitest';
import * as path from 'path';
import { safeJoin } from '../../src/utils/path-safety.js';

const base = path.resolve('/tmp/cache-base');
const inside = (result: string) => result === base || result.startsWith(base + path.sep);

describe('safeJoin', () => {
  it('joins a normal filename onto the base', () => {
    expect(safeJoin(base, 'entry.json')).toBe(path.join(base, 'entry.json'));
  });

  it('joins multiple bare filename segments', () => {
    expect(safeJoin(base, 'a', 'b')).toBe(path.join(base, 'a', 'b'));
  });

  it('returns the base itself when no segments are given', () => {
    expect(safeJoin(base)).toBe(base);
  });

  it('strips directory components from a segment', () => {
    // basename reduces this to the final component; result stays inside base.
    const result = safeJoin(base, 'sub/dir/entry.json');
    expect(result).toBe(path.join(base, 'entry.json'));
    expect(inside(result)).toBe(true);
  });

  // Traversal / degenerate inputs must never escape the base and must never throw.
  const hostile = ['..', '../..', '../../etc/passwd', 'a/..', '/', '', '.', '/etc/passwd', './', '../'];

  for (const seg of hostile) {
    it(`never escapes base and never throws for segment ${JSON.stringify(seg)}`, () => {
      let result!: string;
      expect(() => {
        result = safeJoin(base, seg);
      }).not.toThrow();
      expect(inside(result)).toBe(true);
      // The joined portion must not reintroduce a separator or a dot-only token.
      const appended = result.slice(base.length + path.sep.length);
      expect(appended).not.toContain(path.sep);
      expect(appended).not.toBe('.');
      expect(appended).not.toBe('..');
    });
  }

  it('produces distinct fallbacks for distinct degenerate segments', () => {
    // Defensive: bad inputs should not silently collide onto one file.
    expect(safeJoin(base, '/')).not.toBe(safeJoin(base, ''));
  });
});
