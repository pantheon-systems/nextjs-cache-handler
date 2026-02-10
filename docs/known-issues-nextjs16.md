# Known Issues with Next.js 16 cacheHandlers API

## Overview

This document tracks known issues and limitations when using the Next.js 16 `cacheHandlers` (plural) API for the `'use cache'` directive.

## Issue: Empty Tags in `set()` Method

### Status
**Open** - Upstream Next.js issue

### Description

When using `cacheTag()` inside a function marked with `'use cache'`, Next.js passes empty `tags: []` to the cache handler's `set()` method. This prevents tag-based revalidation from working correctly.

### Expected Behavior

When a cached function uses `cacheTag()`:

```typescript
async function getTaggedProducts() {
  'use cache';
  cacheTag('component-products');
  cacheLife('hours');

  return await fetchProducts();
}
```

The cache handler's `set()` method should receive the entry with tags:

```typescript
async set(cacheKey: string, pendingEntry: Promise<UseCacheEntry>): Promise<void> {
  const entry = await pendingEntry;
  console.log(entry.tags); // Expected: ['component-products']
}
```

### Actual Behavior

The `entry.tags` array is always empty:

```typescript
async set(cacheKey: string, pendingEntry: Promise<UseCacheEntry>): Promise<void> {
  const entry = await pendingEntry;
  console.log(entry.tags); // Actual: []
}
```

This prevents:
1. Storing tags with the cache entry
2. Tag-based revalidation via `revalidateTag()`
3. The `updateTags()` method from correctly invalidating entries

### Impact

The following tests fail due to this issue:
- Tag revalidation tests (tags not stored, so revalidation has no effect)
- Cache stats tests expecting tag metadata

### Related Next.js Issues

1. **[#78864](https://github.com/vercel/next.js/issues/78864)** - "CacheHandler set (full page): tags prop missing from ctx"
   - Reported for the legacy `cacheHandler` (singular) API
   - Similar behavior affects the newer `cacheHandlers` (plural) API

2. **[#78095](https://github.com/vercel/next.js/issues/78095)** - Related issue with workaround discussion

### Workaround for Legacy cacheHandler (Singular)

For the legacy `cacheHandler` API (used for ISR/pages), tags can be extracted from response headers:

```typescript
async set(key: string, data: any, ctx: any) {
  // Extract tags from response headers as workaround
  const tags = ctx.tags ?? data?.headers?.['x-next-cache-tags']?.split(',') ?? [];

  await store.set(key, { ...data, tags });
}
```

**Note**: This workaround applies to the legacy `cacheHandler` API. The new `cacheHandlers` (plural) API receives a `UseCacheEntry` with a `ReadableStream` value and does not have access to response headers.

### Workaround for cacheHandlers (Plural) - Not Available

Currently, there is no known workaround for the `cacheHandlers` (plural) API. The entry structure is:

```typescript
interface UseCacheEntry {
  value: ReadableStream<Uint8Array>;  // Serialized component/data
  tags: string[];                      // Always empty []
  stale: number;
  timestamp: number;
  expire: number;
  revalidate: number;
}
```

The tags are not embedded in the stream value, and there's no alternative source to extract them from.

### Diagnostic Logging

To verify this issue in your environment, add logging to the `set()` method:

```typescript
async set(cacheKey: string, pendingEntry: Promise<UseCacheEntry>): Promise<void> {
  const entry = await pendingEntry;

  console.log(`SET entry structure for ${cacheKey}:`, {
    hasTags: !!entry.tags,
    tags: entry.tags,
    tagsLength: entry.tags?.length ?? 0,
    entryKeys: Object.keys(entry),
  });
}
```

If you see `tagsLength: 0` and `tags: []` for entries that should have tags from `cacheTag()`, you're affected by this issue.

### Affected Versions

- Next.js 16.1.x (confirmed in 16.1.6)
- Likely affects all Next.js 16.x versions with `cacheHandlers` support

### Test Results

With this issue present, the following test results are expected:

```
✓ Basic caching tests - PASS (caching works)
✓ cacheLife() profile tests - PASS (timing works)
✗ cacheTag() revalidation tests - FAIL (tags empty)
✗ Tag metadata in cache stats - FAIL (tags empty)
```

### Recommended Actions

1. **Monitor Next.js releases** for fixes to issues #78864 and #78095
2. **File a new issue** specifically for `cacheHandlers` (plural) if one doesn't exist
3. **Mark affected tests as known failures** in CI to prevent false negatives
4. **Use time-based revalidation** (`cacheLife()`) as an alternative to tag-based revalidation

### References

- [Next.js cacheHandlers docs](https://nextjs.org/docs/app/api-reference/config/next-config-js/cacheHandlers)
- [cacheTag function docs](https://nextjs.org/docs/app/api-reference/functions/cacheTag)
- [GitHub Issue #78864](https://github.com/vercel/next.js/issues/78864)
- [GitHub Issue #78095](https://github.com/vercel/next.js/issues/78095)
