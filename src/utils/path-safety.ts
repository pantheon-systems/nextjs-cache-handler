import * as path from 'path';

/**
 * Safely join one or more filename segments onto a base directory, guarding
 * against path traversal.
 *
 * Each segment is reduced to a bare filename with `path.basename()`, which strips
 * every directory separator (and therefore any `..` / absolute-path traversal),
 * so the value appended to `baseDir` cannot escape it. A final containment check
 * verifies the resolved path is still within `baseDir` as defence-in-depth.
 *
 * NOTE: segments are treated as individual filename components — this helper does
 * not build nested subdirectories. That matches every current call site (cache
 * keys and directory-listing entries are always single filenames).
 *
 * @param baseDir  The trusted base directory that the result must stay within.
 * @param segments Filename segment(s) to append.
 * @returns The absolute path, guaranteed to be inside `baseDir`.
 * @throws If a segment is not a valid filename or the result escapes `baseDir`.
 */
export function safeJoin(baseDir: string, ...segments: string[]): string {
  const resolvedBase = path.resolve(baseDir);

  // path.basename() removes all directory separators, neutralising traversal at
  // the source. The empty/`.`/`..` results that basename can still return are
  // rejected explicitly.
  const safeSegments = segments.map((segment) => {
    const name = path.basename(segment);
    if (name === '' || name === '.' || name === '..') {
      throw new Error(`Invalid path segment "${segment}"`);
    }
    return name;
  });

  // Each entry in safeSegments is a bare filename (no separators), so joining
  // them onto the base with path.sep is equivalent to path.join but keeps the
  // already-sanitised values out of the path.* API taint sinks.
  const target =
    safeSegments.length > 0 ? resolvedBase + path.sep + safeSegments.join(path.sep) : resolvedBase;

  // Defence-in-depth: the resolved target must be the base directory itself or a
  // descendant of it.
  if (target !== resolvedBase && !target.startsWith(resolvedBase + path.sep)) {
    throw new Error(
      `Path traversal detected: resolved path "${target}" escapes base directory "${resolvedBase}"`
    );
  }

  return target;
}
