import { createRequire } from 'node:module';

/** Major version of the installed `next`, which CI switches between 15 and 16. */
export const nextMajor = Number(
  (createRequire(import.meta.url)('next/package.json') as { version: string }).version.split('.')[0]
);

/** Next.js 16 keeps a tag stale (still served) before it expires; Next.js 15 only expires. */
export const hasStaleTags = nextMajor >= 16;
