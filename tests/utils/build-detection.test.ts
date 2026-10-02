import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { getBuildId, getCacheGenerationId, isBuildPhase } from '../../src/utils/build-detection.js';

vi.mock('fs');

const originalDeploymentId = process.env.NEXT_DEPLOYMENT_ID;

describe('build-detection', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  afterEach(() => {
    delete process.env.NEXT_PHASE;
    if (originalDeploymentId === undefined) delete process.env.NEXT_DEPLOYMENT_ID;
    else process.env.NEXT_DEPLOYMENT_ID = originalDeploymentId;
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

  describe('getCacheGenerationId', () => {
    const BUILD_ID = 'build-TfctsWXpff2fKS';

    // Fake .next files keyed by basename; a function value simulates a read error.
    function mockFiles(files: Record<string, string | (() => string)>) {
      vi.mocked(fs.existsSync).mockImplementation((p) => path.basename(String(p)) in files);
      vi.mocked(fs.readFileSync).mockImplementation(((p: unknown) => {
        const v = files[path.basename(String(p))];
        return typeof v === 'function' ? v() : v;
      }) as typeof fs.readFileSync);
    }
    const manifest = (deploymentId: unknown) => JSON.stringify({ deploymentId });

    beforeEach(() => {
      delete process.env.NEXT_DEPLOYMENT_ID;
    });

    describe('without a deployment ID', () => {
      it('returns exactly BUILD_ID when env is unset and there is no routes-manifest', () => {
        mockFiles({ BUILD_ID });
        expect(getCacheGenerationId()).toBe(BUILD_ID);
      });

      it.each([
        ['empty', ''],
        ['whitespace', '   '],
      ])('ignores %s NEXT_DEPLOYMENT_ID', (_n, v) => {
        process.env.NEXT_DEPLOYMENT_ID = v;
        mockFiles({ BUILD_ID });
        expect(getCacheGenerationId()).toBe(BUILD_ID);
      });

      it('ignores a manifest with no deploymentId', () => {
        mockFiles({ BUILD_ID, 'routes-manifest.json': '{}' });
        expect(getCacheGenerationId()).toBe(BUILD_ID);
      });

      it('ignores an empty manifest deploymentId', () => {
        mockFiles({ BUILD_ID, 'routes-manifest.json': manifest('') });
        expect(getCacheGenerationId()).toBe(BUILD_ID);
      });

      it.each([[123], [null], [{ a: 1 }]])('ignores a non-string manifest deploymentId (%j)', (v) => {
        mockFiles({ BUILD_ID, 'routes-manifest.json': manifest(v) });
        expect(getCacheGenerationId()).toBe(BUILD_ID);
      });

      it('does not throw on invalid manifest JSON', () => {
        mockFiles({ BUILD_ID, 'routes-manifest.json': '{not json' });
        expect(getCacheGenerationId()).toBe(BUILD_ID);
      });

      it('does not throw when reading the manifest fails', () => {
        mockFiles({
          BUILD_ID,
          'routes-manifest.json': () => {
            throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
          },
        });
        expect(getCacheGenerationId()).toBe(BUILD_ID);
      });
    });

    describe('with a deployment ID', () => {
      it('appends NEXT_DEPLOYMENT_ID', () => {
        process.env.NEXT_DEPLOYMENT_ID = 'dpl-1';
        mockFiles({ BUILD_ID });
        expect(getCacheGenerationId()).toBe(`${BUILD_ID}:dpl-1`);
      });

      it('falls back to the manifest when env is empty (useSkewCookie)', () => {
        process.env.NEXT_DEPLOYMENT_ID = '';
        mockFiles({ BUILD_ID, 'routes-manifest.json': manifest('dpl-1') });
        expect(getCacheGenerationId()).toBe(`${BUILD_ID}:dpl-1`);
      });

      it('prefers env over the manifest', () => {
        process.env.NEXT_DEPLOYMENT_ID = 'dpl-env';
        mockFiles({ BUILD_ID, 'routes-manifest.json': manifest('dpl-file') });
        expect(getCacheGenerationId()).toBe(`${BUILD_ID}:dpl-env`);
      });

      it('differs across deployment IDs for the same BUILD_ID', () => {
        mockFiles({ BUILD_ID });
        process.env.NEXT_DEPLOYMENT_ID = 'dpl-1';
        const first = getCacheGenerationId();
        process.env.NEXT_DEPLOYMENT_ID = 'dpl-2';
        expect(getCacheGenerationId()).not.toBe(first);
      });

      it('trims the env value', () => {
        process.env.NEXT_DEPLOYMENT_ID = '  dpl-1 \n';
        mockFiles({ BUILD_ID });
        expect(getCacheGenerationId()).toBe(`${BUILD_ID}:dpl-1`);
      });
    });

    describe('other paths', () => {
      it('uses the build-manifest.json build ID with a deployment ID', () => {
        process.env.NEXT_DEPLOYMENT_ID = 'dpl-1';
        mockFiles({
          'build-manifest.json': JSON.stringify({ lowPriorityFiles: ['static/DsOqQ6QE7Bo/_buildManifest.js'] }),
        });
        expect(getCacheGenerationId()).toBe('DsOqQ6QE7Bo:dpl-1');
      });

      it('uses the fallback ID, suffixed only when a deployment ID exists', () => {
        mockFiles({});
        expect(getCacheGenerationId()).toMatch(/^fallback-\d+$/);
        process.env.NEXT_DEPLOYMENT_ID = 'dpl-1';
        expect(getCacheGenerationId()).toMatch(/^fallback-\d+:dpl-1$/);
      });

      it('leaves getBuildId() as the plain BUILD_ID', () => {
        process.env.NEXT_DEPLOYMENT_ID = 'dpl-1';
        mockFiles({ BUILD_ID });
        expect(getBuildId()).toBe(BUILD_ID);
      });
    });
  });
});
