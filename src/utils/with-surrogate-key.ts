import { NextRequest, NextResponse } from 'next/server.js';
import { RequestContext } from './request-context.js';
import { createLogger } from './logger.js';

const log = createLogger('withSurrogateKey');

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
    // This is a fallback for when AsyncLocalStorage doesn't propagate through Next.js cache mechanism
    const globalTags = (globalThis as Record<string, unknown>).__pantheonSurrogateKeyTags as
      | string[]
      | undefined;
    if (globalTags) {
      globalTags.length = 0;
    }

    // Run handler within request context to capture tags
    return RequestContext.run(async () => {
      // Execute the original handler
      const response = await handler(request, context);

      // Get captured tags from cache hits (primary: AsyncLocalStorage)
      let capturedTags = RequestContext.getTags();

      // Fallback: check global store for cross-context tag propagation
      // This handles cases where Next.js cache mechanism runs outside our AsyncLocalStorage context
      const globalStoreTags = (globalThis as Record<string, unknown>).__pantheonSurrogateKeyTags as
        | string[]
        | undefined;
      if (capturedTags.length === 0 && globalStoreTags && globalStoreTags.length > 0) {
        capturedTags = [...new Set(globalStoreTags)];
        if (debug) {
          log.debug(`Using global store fallback: ${capturedTags.length} tags`);
        }
        // Clear global tags after reading
        globalStoreTags.length = 0;
      }

      if (debug) {
        log.debug(`Captured ${capturedTags.length} tags: ${capturedTags.join(', ')}`);
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
          newResponse.headers.set('x-cache-tags-count', String(capturedTags.length));
        }
      } else if (fallbackKey) {
        newResponse.headers.set('Surrogate-Key', fallbackKey);

        if (debug) {
          log.debug(`No tags captured, using fallback: ${fallbackKey}`);
        }
      }

      return newResponse;
    });
  };
}
