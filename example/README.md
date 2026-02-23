# Example: Next.js with Custom Cache Handler

This is a Next.js application demonstrating how to use `@pantheon-systems/nextjs-cache-handler` for custom caching.

## What This Example Shows

- Configuring a custom cache handler via `cache-handler.mjs`
- Wiring the handler into `next.config.mjs`
- Auto-detecting GCS vs file-based caching based on environment

## Running the Example

```bash
npm install
npm run dev
```

For GCS caching, set `CACHE_BUCKET` to your bucket name before starting.

See the [main README](../README.md) for full documentation.
