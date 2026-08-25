/**
 * Races a promise against a timeout, falling back to `onTimeout()` if the
 * promise hasn't settled in time. The original promise is left running in
 * the background (not cancelled) -- if it eventually succeeds, that's fine
 * (best-effort), and if the process exits first (a short-lived build worker),
 * that's fine too, matching the existing "fire and forget" pattern already
 * used elsewhere in this package (e.g. `EdgeCacheClear.nukeCacheInBackground`).
 *
 * Intended to be used gated on `isBuildPhase()` only -- see
 * `handlers/gcs.ts`'s `readCacheEntry`/`writeCacheEntry`. At runtime, a
 * slow-but-working GCS call should still be allowed to complete normally;
 * this exists specifically for the build/prerender phase, where a hanging or
 * slowly-failing GCS call (e.g. the Google Auth library's default
 * multi-second ADC-probing retry sequence when no credentials are reachable)
 * can otherwise block an entire page's static generation for real wall-clock
 * time. Under Next's `cacheComponents`, that blocking delay -- not a thrown
 * exception, since GCS errors are already caught and logged, never
 * rethrown -- is itself what trips "Uncached data was accessed outside of
 * <Suspense>" for a `fetch({ cache: 'force-cache' })` call the handler is
 * backing (see the adapter repo's ticket 7 for the full live-repro trace).
 */
export async function withBuildTimeout<T>(promise: Promise<T>, timeoutMs: number, onTimeout: () => T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(onTimeout()), timeoutMs);
  });

  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
