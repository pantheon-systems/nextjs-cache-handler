import { NextRequest, NextResponse } from 'next/server.js';
import { CacheTagContext } from './cache-tag-context.js';
import { createLogger } from './logger.js';

const log = createLogger('withSurrogateKey');

/**
 * Symbol for registering path→surrogate-key mappings with the use-cache handler.
 * When withSurrogateKey captures tags, it registers them so revalidatePath
 * can resolve _N_T_ path tags to the correct CDN surrogate keys.
 */
const PATH_TAGS_REGISTRY_SYMBOL = Symbol.for('@nextjs-cache-handler/path-tags-registry');

export interface SurrogateKeyOptions {
  /** Fallback Surrogate-Key when no tags are captured */
  fallbackKey?: string;
  /** Enable debug logging */
  debug?: boolean;
}

type RouteHandler = (
  request: NextRequest,
  context?: { params?: Promise<Record<string, string>> }
) => Promise<NextResponse> | NextResponse;

/**
 * Wraps a route handler to automatically set Surrogate-Key headers.
 *
 * Tags are captured from cache hits during request processing and
 * added to the response as a Surrogate-Key header for CDN integration.
 *
 * @example
 * ```typescript
 * // app/api/posts/route.ts
 * import { withSurrogateKey } from '@pantheon-systems/nextjs-cache-handler';
 *
 * async function handler(request: NextRequest) {
 *   const posts = await getCachedPosts(); // Tags captured from cache hits
 *   return NextResponse.json(posts);
 * }
 *
 * export const GET = withSurrogateKey(handler);
 * ```
 */
export function withSurrogateKey(
  handler: RouteHandler,
  options: SurrogateKeyOptions = {}
): RouteHandler {
  const { fallbackKey = 'page-content', debug = false } = options;

  return async (request: NextRequest, context?: { params?: Promise<Record<string, string>> }) => {
    // Clear any stale global tags before starting request
    // This is kept as a last-resort fallback for environments where Symbol.for doesn't propagate
    const globalTags = (globalThis as Record<string, unknown>).__pantheonSurrogateKeyTags as
      | string[]
      | undefined;
    if (globalTags) {
      globalTags.length = 0;
    }

    // Run handler within CacheTagContext (uses Symbol.for pattern for cross-context propagation)
    return CacheTagContext.run(async () => {
      const requestId = CacheTagContext.getRequestId();
      if (debug) {
        log.debug(`Starting request ${requestId}`);
      }

      // Execute the original handler
      const response = await handler(request, context);

      // Primary: Get captured tags from CacheTagContext (Symbol.for pattern)
      let capturedTags = CacheTagContext.getTags();
      let tagSource = 'CacheTagContext';

      if (debug && capturedTags.length > 0) {
        log.debug(`CacheTagContext captured ${capturedTags.length} tags: ${capturedTags.join(', ')}`);
      }

      // Fallback: check global store for cross-context tag propagation
      // This handles cases where even the Symbol.for pattern doesn't propagate
      if (capturedTags.length === 0) {
        const globalStoreTags = (globalThis as Record<string, unknown>).__pantheonSurrogateKeyTags as
          | string[]
          | undefined;
        if (globalStoreTags && globalStoreTags.length > 0) {
          capturedTags = [...new Set(globalStoreTags)];
          tagSource = 'globalStore';
          if (debug) {
            log.debug(`Using global store fallback: ${capturedTags.length} tags`);
          }
          // Clear global tags after reading
          globalStoreTags.length = 0;
        }
      }

      if (debug) {
        log.debug(`Captured ${capturedTags.length} tags from ${tagSource}: ${capturedTags.join(', ')}`);
      }

      // Register path→surrogate-key mapping for revalidatePath CDN clearing
      if (capturedTags.length > 0) {
        const requestPath = new URL(request.url).pathname;
        const registerFn = (globalThis as Record<symbol, unknown>)[PATH_TAGS_REGISTRY_SYMBOL] as
          | ((path: string, tags: string[]) => void)
          | undefined;
        if (registerFn) {
          registerFn(requestPath, capturedTags);
          if (debug) {
            log.debug(`Registered path tags: ${requestPath} → [${capturedTags.join(', ')}]`);
          }
        }
      }

      // Clone response to modify headers
      const newResponse = new NextResponse(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: new Headers(response.headers),
      });

      // Set Surrogate-Key header
      if (capturedTags.length > 0) {
        const surrogateKey = capturedTags.join(' ');
        newResponse.headers.set('Surrogate-Key', surrogateKey);

        if (debug) {
          log.debug(`Set Surrogate-Key: ${surrogateKey}`);
          // TODO: Remove these debug headers before production release
          // These are temporary headers to validate tag capture while Surrogate-Key
          // is being stripped by the proxy layer. Remove once proxy issue is resolved.
          newResponse.headers.set('x-cache-tags-count', String(capturedTags.length));
          newResponse.headers.set('x-cache-tags-source', tagSource);
          newResponse.headers.set('x-surrogate-key-debug', surrogateKey);
        }
      } else if (fallbackKey) {
        newResponse.headers.set('Surrogate-Key', fallbackKey);

        if (debug) {
          log.debug(`No tags captured, using fallback: ${fallbackKey}`);
          // TODO: Remove this debug header before production release
          newResponse.headers.set('x-surrogate-key-debug', fallbackKey);
        }
      }

      return newResponse;
    });
  };
}
