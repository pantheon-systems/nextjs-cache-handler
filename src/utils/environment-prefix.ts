/**
 * Returns a GCS object key prefix based on the Pantheon environment.
 *
 * - `live` (production) → "" (no prefix; prod has its own bucket)
 * - Any other value (multidev) → "environments/{env}/"
 * - Unset → "" (local dev / non-Pantheon; falls back to no prefix)
 */
export function getEnvironmentPrefix(): string {
  const env = process.env.PANTHEON_ENVIRONMENT;

  if (!env || env === 'live') {
    return '';
  }

  return `environments/${env}/`;
}
