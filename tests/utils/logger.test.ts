import { describe, it, expect } from 'vitest';
import { summarizeList } from '../../src/utils/logger.js';

describe('summarizeList', () => {
  it('lists every value when there are few', () => {
    expect(summarizeList(['/a', '/b'])).toBe('/a, /b');
    expect(summarizeList([])).toBe('');
  });

  it('shows the first values and counts the rest', () => {
    const paths = Array.from({ length: 40000 }, (_, i) => `/p${i}`);

    expect(summarizeList(paths, 3)).toBe('/p0, /p1, /p2 and 39997 more');
    expect(summarizeList(paths).length).toBeLessThan(100);
  });
});
