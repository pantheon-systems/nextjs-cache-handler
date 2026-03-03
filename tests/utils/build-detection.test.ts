import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { getBuildId, isBuildPhase } from '../../src/utils/build-detection.js';

vi.mock('fs');

describe('build-detection', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  afterEach(() => {
    delete process.env.NEXT_PHASE;
  });

  describe('isBuildPhase', () => {
    it('should return true when NEXT_PHASE is phase-production-build', () => {
      process.env.NEXT_PHASE = 'phase-production-build';
      expect(isBuildPhase()).toBe(true);
    });

    it('should return false when NEXT_PHASE is not set', () => {
      delete process.env.NEXT_PHASE;
      expect(isBuildPhase()).toBe(false);
    });

    it('should return false when NEXT_PHASE is something else', () => {
      process.env.NEXT_PHASE = 'phase-development-server';
      expect(isBuildPhase()).toBe(false);
    });
  });

  describe('getBuildId', () => {
    it('should read build ID from .next/BUILD_ID file', () => {
      const buildId = 'abc123xyz';
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(buildId);

      const result = getBuildId();

      expect(result).toBe(buildId);
      expect(fs.existsSync).toHaveBeenCalledWith(path.join(process.cwd(), '.next', 'BUILD_ID'));
    });

    it('should trim whitespace from build ID', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue('  build123  \n');

      const result = getBuildId();

      expect(result).toBe('build123');
    });

    it('should extract build ID from build-manifest.json when BUILD_ID does not exist', () => {
      vi.mocked(fs.existsSync).mockImplementation((filePath) => {
        if (String(filePath).includes('BUILD_ID')) return false;
        if (String(filePath).includes('build-manifest.json')) return true;
        return false;
      });

      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify({
          lowPriorityFiles: [
            'static/DsOqQ6QE7Bo_OEhUjVFCD/_buildManifest.js',
            'static/DsOqQ6QE7Bo_OEhUjVFCD/_ssgManifest.js',
          ],
        })
      );

      const result = getBuildId();

      expect(result).toBe('DsOqQ6QE7Bo_OEhUjVFCD');
    });

    it('should return fallback ID when no build files exist', () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);

      const result = getBuildId();

      expect(result).toMatch(/^fallback-\d+$/);
    });

    it('should return fallback ID when reading BUILD_ID throws', () => {
      vi.mocked(fs.existsSync).mockImplementation((filePath) => {
        if (String(filePath).includes('BUILD_ID')) return true;
        return false;
      });
      vi.mocked(fs.readFileSync).mockImplementation(() => {
        throw new Error('File read error');
      });

      const result = getBuildId();

      expect(result).toMatch(/^fallback-\d+$/);
    });

    it('should return fallback ID when manifest has no matching files', () => {
      vi.mocked(fs.existsSync).mockImplementation((filePath) => {
        if (String(filePath).includes('BUILD_ID')) return false;
        if (String(filePath).includes('build-manifest.json')) return true;
        return false;
      });

      vi.mocked(fs.readFileSync).mockReturnValue(
        JSON.stringify({
          lowPriorityFiles: ['some/other/file.js'],
        })
      );

      const result = getBuildId();

      expect(result).toMatch(/^fallback-\d+$/);
    });
  });
});
