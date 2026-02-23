import type {
  CacheHandler as NextCacheHandler,
  CacheHandlerValue as NextCacheHandlerValue,
} from "next/dist/server/lib/incremental-cache";

import type FileSystemCache from "next/dist/server/lib/incremental-cache/file-system-cache";

// ============================================================================
// Cache Handler Configuration Types
// ============================================================================

/**
 * Configuration options for creating a cache handler instance.
 */
export interface CacheHandlerConfig {
  /**
   * Handler type selection:
   * - 'auto': Automatically detect based on environment (GCS if CACHE_BUCKET is set, otherwise file)
   * - 'file': Use file-based caching (local development)
   * - 'gcs': Use Google Cloud Storage (production/Pantheon)
   */
  type?: 'auto' | 'file' | 'gcs';
}

// ============================================================================
// Cache Context and Entry Types
// ============================================================================

export interface CacheContext {
  fetchCache?: boolean;
  fetchUrl?: string;
  fetchIdx: number;
  tags?: string[];
  isImplicitBuildTimeCache: false;
}

export interface CacheEntry {
  value: unknown;
  lastModified: number;
  tags: string[];
}

export interface CacheData {
  [key: string]: unknown;
}

// ============================================================================
// Serialization Types
// ============================================================================

export interface SerializedBuffer {
  type: 'Buffer';
  data: string; // base64 encoded buffer data
}

export interface SerializedMap {
  type: 'Map';
  data: Record<string, unknown>;
}

export type SerializableValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | SerializedBuffer
  | SerializedMap
  | Record<string, unknown>
  | unknown[];

export interface SerializedCacheData {
  [key: string]: {
    value: SerializableValue;
    lastModified: number;
    tags: Readonly<string[]>;
  };
}

// ============================================================================
// Cache Statistics Types
// ============================================================================

export interface CacheEntryInfo {
  key: string;
  tags: string[];
  lastModified?: number;
  type: 'fetch' | 'route';
}

export interface CacheStats {
  size: number;
  keys: string[];
  entries: CacheEntryInfo[];
}

// ============================================================================
// Cache Handler Interface Types
// ============================================================================

export type CacheHandlerParametersGet = Parameters<NextCacheHandler["get"]>;
export type CacheHandlerParametersSet = Parameters<NextCacheHandler["set"]>;
export type FileSystemCacheContext = ConstructorParameters<typeof FileSystemCache>[0];
export type CacheHandlerParametersRevalidateTag = Parameters<NextCacheHandler["revalidateTag"]>;

export type CacheHandlerValue = NextCacheHandlerValue & {
  /**
   * Timestamp in milliseconds when the cache entry was last modified.
   */
  lastModified: number;
  /**
   * Tags associated with the cache entry. They are used for on-demand revalidation.
   */
  tags: Readonly<string[]>;
};

export type Revalidate = false | number;

// ============================================================================
// Cache Handler Abstract Interface
// ============================================================================

/**
 * Cache handler interface that extends the Next.js CacheHandler.
 * This is the interface that all cache handler implementations must implement.
 */
export declare class CacheHandler implements NextCacheHandler {
  /**
   * Creates a new CacheHandler instance.
   */
  constructor(context: FileSystemCacheContext);

  get(
    cacheKey: CacheHandlerParametersGet[0],
    ctx?: CacheHandlerParametersGet[1],
  ): Promise<CacheHandlerValue | null>;

  set(
    cacheKey: CacheHandlerParametersSet[0],
    incrementalCacheValue: CacheHandlerParametersSet[1],
    ctx: CacheHandlerParametersSet[2] & {
      internal_lastModified?: number;
    },
  ): Promise<void>;

  revalidateTag(tag: CacheHandlerParametersRevalidateTag[0]): Promise<void>;

  resetRequestCache(): void;
}
