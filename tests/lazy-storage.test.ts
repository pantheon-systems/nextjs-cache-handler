import { describe, it, expect, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

// Next.js 16.4 bundles `config.cacheHandler` into Node middleware. A top-level
// import of @google-cloud/storage puts the library in every middleware bundle,
// and with `experimental.turbopackModuleFragments` its evaluation there throws
// "Cannot access '<x>' before initialization" (SITE-6759). The library must load
// only when a GCS bucket is first needed.

const storageLoads = vi.hoisted(() => ({ modules: 0, clients: 0 }));

vi.mock('@google-cloud/storage', () => {
  storageLoads.modules++;
  return {
    Storage: function Storage() {
      storageLoads.clients++;
      return { bucket: (name: string) => ({ name }) };
    },
    RETRYABLE_ERR_FN_DEFAULT: () => true,
  };
});

const here = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.join(here, '..', 'src');

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return entry.name.endsWith('.ts') ? [full] : [];
  });
}

describe('@google-cloud/storage is loaded lazily', () => {
  it('no source file imports it as a value', () => {
    for (const file of sourceFiles(srcDir)) {
      const code = fs
        .readFileSync(file, 'utf-8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:])\/\/.*$/gm, '$1');
      const staticImports = code.match(/^\s*(import|export)\b[^;]*?from\s*['"]@google-cloud\/storage['"]/gm) ?? [];
      for (const statement of staticImports) {
        expect(statement, `${path.relative(srcDir, file)}: ${statement.trim()}`).toMatch(
          /^\s*(import|export)\s+type\b/
        );
      }
      expect(code, path.relative(srcDir, file)).not.toMatch(/require\(\s*['"]@google-cloud\/storage['"]\s*\)/);
    }
  });

  it('importing the Node entry does not load it; the first bucket does, once', async () => {
    await import('../src/index.js');
    expect(storageLoads.modules).toBe(0);

    const { getSharedBucket } = await import('../src/utils/gcs-json-object.js');
    const entries = getSharedBucket('test-bucket', 'entries');
    const tags = getSharedBucket('test-bucket', 'tags');
    expect(getSharedBucket('test-bucket', 'entries')).toBe(entries);

    await expect(entries).resolves.toEqual({ name: 'test-bucket' });
    await expect(tags).resolves.toEqual({ name: 'test-bucket' });
    expect(storageLoads.modules).toBe(1);
    expect(storageLoads.clients).toBe(2);
  });
});
