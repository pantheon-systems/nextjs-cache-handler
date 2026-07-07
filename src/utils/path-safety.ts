import * as path from 'path';

/**
 * Safely join one or more filename segments onto a base directory, guarding
 * against path traversal.
 *
 * This helper is **total**: it never throws and always returns an absolute path
 * that is guaranteed to stay inside `baseDir`. Callers can treat it as a pure
 * "sanitize" step rather than a validation step that might explode at runtime.
 *
 * Each segment is reduced to a bare filename with `path.basename()`, which strips
 * every directory separator (and therefore any `..` / absolute-path traversal),
 * so the value appended to `baseDir` cannot escape it. The degenerate results
 * that `basename` can still return — `''`, `'.'`, and `'..'` (e.g. from `''`,
 * `'/'`, or `'a/..'`) — cannot form a usable filename, so they are replaced with
 * a deterministic sanitized fallback rather than escaping the base directory.
 *
 * Because every produced segment is a bare, separator-free filename that is
 * never `'.'`/`'..'`, the result always starts with `baseDir + path.sep`; there
 * is no reachable case in which it escapes the base, so no containment check /
 * throw is needed.
 *
 * NOTE: segments are treated as individual filename components — this helper does
 * not build nested subdirectories. That matches every current call site (cache
 * keys and directory-listing entries are always single filenames).
 *
 * @param baseDir  The trusted base directory that the result will stay within.
 * @param segments Filename segment(s) to append.
 * @returns The absolute path, guaranteed to be inside `baseDir`.
 */
export function safeJoin(baseDir: string, ...segments: string[]): string {
  const resolvedBase = path.resolve(baseDir);

  const safeSegments = segments.map(sanitizeSegment);

  // Each entry in safeSegments is a bare filename (no separators), so joining
  // them onto the base with path.sep is equivalent to path.join but keeps the
  // already-sanitised values out of the path.* API taint sinks.
  return safeSegments.length > 0 ? resolvedBase + path.sep + safeSegments.join(path.sep) : resolvedBase;
}

/**
 * Reduce an arbitrary string to a single safe filename component: no directory
 * separators, and never `''`, `'.'`, or `'..'`. This is what guarantees the
 * joined result cannot traverse out of the base directory.
 */
function sanitizeSegment(segment: string): string {
  const name = path.basename(segment);
  if (name !== '' && name !== '.' && name !== '..') {
    return name;
  }

  // '', '.', and '..' can't be used as a filename. Encode the raw segment so
  // distinct bad inputs stay distinct, and prefix it so the fallback can never
  // itself collapse back to '', '.', or '..'.
  const encoded = segment.replace(/[^a-zA-Z0-9._-]/g, '_');
  return `_seg_${encoded}`;
}
