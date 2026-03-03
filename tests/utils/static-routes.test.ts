import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { getStaticRoutes } from '../../src/utils/static-routes.js';

vi.mock('fs');

describe('static-routes', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  describe('getStaticRoutes', () => {
    it('should return empty set when manifest does not exist', () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);

      const result = getStaticRoutes();

      expect(result.size).toBe(0);
    });

    it('should return empty set when manifest has no routes', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({}));

      const result = getStaticRoutes();

      expect(result.size).toBe(0);
    });

    it('should return static routes with initialRevalidateSeconds: false', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify({
          routes: {
            '/ssg-page': { initialRevalidateSeconds: false },
            '/isr-page': { initialRevalidateSeconds: 60 },
            '/another-static': { initialRevalidateSeconds: false },
          },
        })
      );

      const result = getStaticRoutes();

      expect(result.size).toBe(2);
      expect(result.has('_ssg-page')).toBe(true);
      expect(result.has('_another-static')).toBe(true);
      expect(result.has('_isr-page')).toBe(false);
    });

    it('should convert root route to _index', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify({
          routes: {
            '/': { initialRevalidateSeconds: false },
          },
        })
      );

      const result = getStaticRoutes();

      expect(result.has('_index')).toBe(true);
    });

    it('should convert nested routes with slashes to underscores', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify({
          routes: {
            '/blog/posts/my-post': { initialRevalidateSeconds: false },
          },
        })
      );

      const result = getStaticRoutes();

      expect(result.has('_blog_posts_my-post')).toBe(true);
    });

    it('should exclude ISR routes (initialRevalidateSeconds is a number)', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify({
          routes: {
            '/isr-10': { initialRevalidateSeconds: 10 },
            '/isr-60': { initialRevalidateSeconds: 60 },
            '/isr-3600': { initialRevalidateSeconds: 3600 },
          },
        })
      );

      const result = getStaticRoutes();

      expect(result.size).toBe(0);
    });

    it('should return empty set when reading manifest throws', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockImplementation(() => {
        throw new Error('Read error');
      });

      const result = getStaticRoutes();

      expect(result.size).toBe(0);
    });

    it('should read from correct manifest path', () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);

      getStaticRoutes();

      expect(fs.existsSync).toHaveBeenCalledWith(path.join(process.cwd(), '.next', 'prerender-manifest.json'));
    });
  });
});
