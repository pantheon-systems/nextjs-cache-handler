import { NextRequest, NextResponse } from 'next/server.js';
import { RequestContext } from '../utils/request-context.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('SurrogateKeyMiddleware');

export interface SurrogateKeyMiddlewareConfig {
  /** Enable debug logging for middleware operations */
  debug?: boolean;
  /** Fallback Surrogate-Key when no tags are captured */
  fallbackKey?: string;
  /** Custom matcher pattern for middleware */
  matcher?: string[];
}

/**
 * Creates middleware that propagates cache tags to Surrogate-Key headers.
 *
 * @param config - Optional configuration
 * @returns Next.js middleware function
 */
export function createSurrogateKeyMiddleware(config: SurrogateKeyMiddlewareConfig = {}) {
  const {
    debug = false,
    fallbackKey = 'page-content',
    matcher,
  } = config;

  return function middleware(request: NextRequest) {
    const { pathname } = request.nextUrl;

    if (debug) {
      log.debug(`Processing request: ${pathname}`);
    }

    // Initialize request context for tag tracking
    return RequestContext.run(() => {
      const response = NextResponse.next();

      // Get all tags accumulated during request (from cache hits)
      const capturedTags = RequestContext.getTags();

      // Merge with any existing Surrogate-Key from next.config.mjs or other sources
      const existingKey = response.headers.get('Surrogate-Key');
      const existingTags = existingKey && existingKey !== 'unknown'
        ? existingKey.split(/\s+/).filter(Boolean)
        : [];

      // Combine and deduplicate all tags
      const allTags = [...new Set([...existingTags, ...capturedTags])];

      if (allTags.length > 0) {
        // Set Surrogate-Key header with space-separated tags
        const surrogateKey = allTags.join(' ');
        response.headers.set('Surrogate-Key', surrogateKey);

        if (debug) {
          log.debug(`Set Surrogate-Key: ${surrogateKey}`);
          response.headers.set('x-cache-tags-count', String(capturedTags.length));
        }
      } else if (fallbackKey) {
        // No tags captured - use fallback if provided
        if (!existingKey) {
          response.headers.set('Surrogate-Key', fallbackKey);
        }
        if (debug) {
          log.debug(`No cache tags captured, using fallback: ${fallbackKey}`);
        }
      }

      return response;
    });
  };
}

/**
 * Default middleware instance with standard configuration.
 * Import and re-export from your app's middleware.ts for zero-config setup.
 */
export const middleware = createSurrogateKeyMiddleware();

/**
 * Default matcher that excludes static assets and Next.js internals.
 * Can be customized by passing config to createSurrogateKeyMiddleware.
 */
export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|.*\\.png|.*\\.jpg|.*\\.jpeg|.*\\.gif|.*\\.svg).*)',
  ],
};
