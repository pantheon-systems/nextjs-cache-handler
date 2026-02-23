# Example Next.js App with Custom Cache Handler

## Overview

This is a Next.js application that demonstrates using `@pantheon-systems/nextjs-cache-handler` for custom caching with Google Cloud Storage or file-based storage.

### Project Structure

```
example/
├── app/                   # Next.js App Router pages and API routes
├── cache-handler.mjs      # Cache handler configuration (uses createCacheHandler)
├── next.config.mjs        # Next.js config pointing to cache-handler.mjs
├── lib/                   # Shared utilities
├── integration/           # Integration tests
└── public/                # Static assets
```

### How the Cache Handler Works

- `cache-handler.mjs` imports `createCacheHandler` from the package and exports a configured handler
- `next.config.mjs` sets `cacheHandler` to point to `cache-handler.mjs` and disables in-memory caching
- The handler auto-detects: uses GCS when `CACHE_BUCKET` is set, otherwise file-based

### Environment Variables

- `CACHE_BUCKET` - GCS bucket name (enables GCS handler when set)
- `CACHE_DEBUG` - Enable debug logging (`true` or `1`)
- `OUTBOUND_PROXY_ENDPOINT` - Edge cache proxy endpoint (Pantheon infrastructure)

## Development Guidelines

- Prefer small, focused functions with single responsibilities
- Use early returns and guard clauses to reduce nesting
- Use targeted try-catch blocks rather than wrapping large sections
- Use descriptive function names that indicate purpose
