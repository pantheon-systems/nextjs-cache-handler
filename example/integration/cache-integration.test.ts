/**
 * Comprehensive cache integration test
 * Tests both filesystem caching and tagged cache behavior with shared server
 */

import { spawn, ChildProcess } from 'child_process'
import * as fs from 'fs/promises'
import * as path from 'path'
import { NextJsCacheFile, isValidNextJsCacheFile, decodeCacheBody } from './types'

const PORT = 3003 // Use different port to avoid conflicts
const BASE_URL = `http://localhost:${PORT}`

// Type for tags mapping file
interface TagsMapping {
  [tag: string]: string[] // tag -> array of cache keys
}

describe('Cache Integration Tests', () => {
  let nextServer: ChildProcess
  let isServerReady = false

  const cacheDir = path.join(process.cwd(), '.next', 'cache')
  const fetchCacheDir = path.join(cacheDir, 'fetch-cache')
  const tagsDir = path.join(cacheDir, 'tags')
  const tagsMappingPath = path.join(tagsDir, 'tags.json')

  /**
   * Start Next.js server for testing
   */
  const startNextServer = (): Promise<void> => {
    return new Promise((resolve, reject) => {
      console.log('Starting Next.js server for cache integration tests...')

      // Build the application first
      const buildProcess = spawn('npm', ['run', 'build'], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          ...process.env,
          NODE_ENV: 'production',
          PORT: PORT.toString()
        }
      })

      buildProcess.on('close', (buildCode) => {
        if (buildCode !== 0) {
          reject(new Error(`Build failed with code ${buildCode}`))
          return
        }

        // Start the server in its own process group so we can kill the whole
        // tree (npm wrapper + node grandchild) cleanly during teardown.
        nextServer = spawn('npm', ['run', 'start'], {
          stdio: ['pipe', 'pipe', 'pipe'],
          detached: true,
          env: {
            ...process.env,
            NODE_ENV: 'production',
            PORT: PORT.toString()
          }
        })

        // Wait for server to be ready
        const timeout = setTimeout(() => {
          reject(new Error('Server startup timeout'))
        }, 60000) // 60 second timeout

        nextServer.stdout?.on('data', (data) => {
          const output = data.toString()
          console.log('[Next.js]', output)

          if (output.includes('Ready') || output.includes(`localhost:${PORT}`)) {
            clearTimeout(timeout)
            isServerReady = true
            resolve()
          }
        })

        nextServer.stderr?.on('data', (data) => {
          console.error('[Next.js Error]', data.toString())
        })

        nextServer.on('close', (code) => {
          console.log(`Next.js server exited with code ${code}`)
          isServerReady = false
        })

        nextServer.on('error', (error) => {
          clearTimeout(timeout)
          reject(error)
        })
      })
    })
  }

  /**
   * Stop Next.js server
   */
  const killProcessGroup = (signal: NodeJS.Signals): void => {
    if (!nextServer?.pid) return
    try {
      process.kill(-nextServer.pid, signal)
    } catch (err: any) {
      if (err.code !== 'ESRCH') throw err
    }
  }

  const stopNextServer = (): Promise<void> => {
    return new Promise((resolve) => {
      if (!nextServer || nextServer.killed) {
        resolve()
        return
      }

      let resolved = false
      const done = () => {
        if (resolved) return
        resolved = true
        resolve()
      }

      const forceKillTimeout = setTimeout(() => {
        killProcessGroup('SIGKILL')
        done()
      }, 5000)

      nextServer.on('close', () => {
        clearTimeout(forceKillTimeout)
        done()
      })

      killProcessGroup('SIGTERM')
    })
  }

  /**
   * Wait for server to be ready
   */
  const waitForServer = async (): Promise<void> => {
    const maxAttempts = 30
    let attempts = 0

    while (attempts < maxAttempts && !isServerReady) {
      try {
        const response = await fetch(`${BASE_URL}/api/posts/force-cache`)
        if (response.ok) {
          return
        }
      } catch (error) {
        // Server not ready yet
      }

      await new Promise(resolve => setTimeout(resolve, 1000))
      attempts++
    }

    if (!isServerReady) {
      throw new Error('Server failed to become ready within timeout')
    }
  }

  /**
   * Clear cache directory
   */
  const clearCacheDirectory = async (): Promise<void> => {
    try {
      const exists = await fs.access(cacheDir).then(() => true).catch(() => false)
      if (exists) {
        await fs.rm(cacheDir, { recursive: true, force: true })
      }
    } catch (error) {
      console.log('Cache directory clear error:', error)
    }
  }

  /**
   * List all files in a directory
   */
  const listCacheFiles = async (dir: string): Promise<string[]> => {
    try {
      const exists = await fs.access(dir).then(() => true).catch(() => false)
      if (!exists) return []

      const files = await fs.readdir(dir)
      return files.filter(file => file.endsWith('.json'))
    } catch (error) {
      return []
    }
  }

  /**
   * Read and parse cache file
   */
  const readCacheFile = async (filePath: string): Promise<NextJsCacheFile | null> => {
    try {
      const content = await fs.readFile(filePath, 'utf-8')
      return JSON.parse(content) as NextJsCacheFile
    } catch (error) {
      console.error(`Error reading cache file ${filePath}:`, error)
      return null
    }
  }

  /**
   * Read and parse tags mapping file
   */
  const readTagsMapping = async (): Promise<TagsMapping | null> => {
    try {
      const content = await fs.readFile(tagsMappingPath, 'utf-8')
      return JSON.parse(content) as TagsMapping
    } catch (error) {
      console.error(`Error reading tags mapping file:`, error)
      return null
    }
  }

  beforeAll(async () => {
    await clearCacheDirectory()
    await startNextServer()
    await waitForServer()
  }, 120000) // 2 minute timeout for server startup

  afterAll(async () => {
    await stopNextServer()
  }, 30000)

  describe('Basic Filesystem Caching', () => {
    beforeEach(async () => {
      // Clear cache before each test group
      await clearCacheDirectory()
    })

    test('should create cache files when calling force-cache endpoint', async () => {
      console.log('Testing basic cache file creation...')

      // Verify cache directory is initially empty
      const initialFetchFiles = await listCacheFiles(fetchCacheDir)
      expect(initialFetchFiles).toHaveLength(0)

      // Make request to force-cache endpoint
      const response = await fetch(`${BASE_URL}/api/posts/force-cache`)
      expect(response.status).toBe(200)

      const responseData = await response.json()
      expect(responseData.cache_strategy).toBe('force-cache')
      expect(responseData.data).toBeDefined()
      expect(Array.isArray(responseData.data)).toBe(true)

      console.log('API response:', {
        strategy: responseData.cache_strategy,
        duration: responseData.duration_ms,
        dataLength: responseData.data?.length
      })

      // Wait a moment for cache files to be written
      await new Promise(resolve => setTimeout(resolve, 1000))

      // Check that cache files were created
      const fetchFiles = await listCacheFiles(fetchCacheDir)
      console.log('Cache files found:', fetchFiles)

      expect(fetchFiles.length).toBeGreaterThan(0)

      // Read and validate cache file content
      const cacheFilePath = path.join(fetchCacheDir, fetchFiles[0])
      const cacheData = await readCacheFile(cacheFilePath)

      expect(cacheData).not.toBeNull()

      // Assert that cacheData is not null for TypeScript
      if (!cacheData) {
        throw new Error('Cache data is null')
      }

      console.log('Cache file structure:', {
        keys: Object.keys(cacheData),
        hasKind: !!(cacheData.value && cacheData.value.kind),
        hasData: !!(cacheData.value && cacheData.value.data),
        hasRevalidate: !!(cacheData.value && cacheData.value.revalidate),
        hasBody: !!(cacheData.value && cacheData.value.data && cacheData.value.data.body),
        hasValue: !!cacheData.value
      })

      // The cache file should have the correct Next.js cache structure
      expect(cacheData).toBeTruthy()
      expect(isValidNextJsCacheFile(cacheData)).toBe(true)

      const cacheDataValue = cacheData.value

      // Validate the cache value structure using the extracted value
      expect(cacheDataValue.kind).toBe('FETCH')
      expect(cacheDataValue.data).toBeDefined()
      expect(typeof cacheDataValue.revalidate).toBe('number')

      // Validate the HTTP response data structure
      expect(cacheDataValue.data.status).toBe(200)
      expect(cacheDataValue.data.url).toContain('jsonplaceholder.typicode.com')
      expect(cacheDataValue.data.body).toBeDefined()
      expect(cacheDataValue.data.headers).toBeDefined()
      expect(typeof cacheDataValue.data.headers).toBe('object')

      // Validate the cache metadata
      expect(typeof cacheData.lastModified).toBe('number')
      expect(Array.isArray(cacheData.tags)).toBe(true)

      // Validate we can decode the cached response body
      const decodedBody = decodeCacheBody(cacheDataValue.data.body)
      const parsedBody = JSON.parse(decodedBody)
      expect(Array.isArray(parsedBody)).toBe(true)
      expect(parsedBody.length).toBe(3) // Should have 3 posts from the API

      console.log('Cache file validation successful:', {
        kind: cacheDataValue.kind,
        status: cacheDataValue.data.status,
        url: cacheDataValue.data.url,
        revalidate: cacheDataValue.revalidate,
        lastModified: cacheData.lastModified,
        tagsCount: cacheData.tags.length,
        postsInBody: parsedBody.length
      })
    })

    test('should reuse cache files on subsequent requests', async () => {
      console.log('Testing cache file reuse...')

      // First request - should create cache
      const firstResponse = await fetch(`${BASE_URL}/api/posts/force-cache`)
      const firstData = await firstResponse.json()

      expect(firstResponse.status).toBe(200)

      console.log('First request:', {
        duration: firstData.duration_ms,
        timestamp: firstData.fetched_at
      })

      await new Promise(resolve => setTimeout(resolve, 1000))

      // Check cache files after first request
      const filesAfterFirst = await listCacheFiles(fetchCacheDir)
      expect(filesAfterFirst.length).toBeGreaterThan(0)

      // Second request - should use existing cache
      const secondResponse = await fetch(`${BASE_URL}/api/posts/force-cache`)
      const secondData = await secondResponse.json()

      expect(secondResponse.status).toBe(200)

      console.log('Second request:', {
        duration: secondData.duration_ms,
        timestamp: secondData.fetched_at
      })

      // Verify cache behavior
      expect(secondData.cache_strategy).toBe('force-cache')

      // With force-cache, subsequent requests should be much faster
      expect(secondData.duration_ms).toBeLessThan(firstData.duration_ms * 0.8)

      // Or they should return the same timestamp (indicating cached data)
      const sameData = firstData.fetched_at === secondData.fetched_at
      const fasterResponse = secondData.duration_ms < 10 // Very fast indicates cache hit

      expect(sameData || fasterResponse).toBe(true)

      console.log('Cache validation:', {
        sameTimestamp: sameData,
        veryFastResponse: fasterResponse,
        speedImprovement: `${Math.round((1 - secondData.duration_ms / firstData.duration_ms) * 100)}%`
      })
    })

    test('should create proper cache directory structure', async () => {
      console.log('Testing cache directory structure...')

      // Make a request to trigger cache creation
      await fetch(`${BASE_URL}/api/posts/force-cache`)

      // Wait for cache to be written
      await new Promise(resolve => setTimeout(resolve, 1000))

      // Verify directory structure exists
      const cacheDirExists = await fs.access(cacheDir).then(() => true).catch(() => false)
      const fetchCacheDirExists = await fs.access(fetchCacheDir).then(() => true).catch(() => false)
      const tagsDirExists = await fs.access(tagsDir).then(() => true).catch(() => false)

      expect(cacheDirExists).toBe(true)
      expect(fetchCacheDirExists).toBe(true)
      expect(tagsDirExists).toBe(true)

      console.log('Directory structure validation:', {
        cacheDir: cacheDirExists,
        fetchCacheDir: fetchCacheDirExists,
        tagsDir: tagsDirExists
      })

      // Check that tags mapping file was created if needed
      const tagsMappingExists = await fs.access(tagsMappingPath).then(() => true).catch(() => false)

      if (tagsMappingExists) {
        const tagsContent = await readCacheFile(tagsMappingPath)
        expect(tagsContent).not.toBeNull()
        expect(typeof tagsContent).toBe('object')
        console.log('Tags mapping created:', Object.keys(tagsContent || {}).length, 'tags')
      }
    })
  })

  describe('Tagged Cache Functionality', () => {
    beforeEach(async () => {
      // Clear cache before each test group
      await clearCacheDirectory()
    })

    test('should create tagged cache files when calling with-tags endpoint', async () => {
      console.log('Testing tagged cache file creation...')

      // Verify cache directory is initially empty
      const initialFetchFiles = await listCacheFiles(fetchCacheDir)
      expect(initialFetchFiles).toHaveLength(0)

      // Make request to tagged cache endpoint
      const response = await fetch(`${BASE_URL}/api/posts/with-tags`)
      expect(response.status).toBe(200)

      const responseData = await response.json()
      expect(responseData.cache_strategy).toBe('tags-revalidate-5m')
      expect(responseData.cache_tags).toEqual(['api-posts', 'external-data'])
      expect(responseData.data).toBeDefined()
      expect(Array.isArray(responseData.data)).toBe(true)

      console.log('Tagged API response:', {
        strategy: responseData.cache_strategy,
        tags: responseData.cache_tags,
        duration: responseData.duration_ms,
        dataLength: responseData.data?.length
      })

      // Wait a moment for cache files to be written
      await new Promise(resolve => setTimeout(resolve, 1000))

      // Check that cache files were created
      const fetchFiles = await listCacheFiles(fetchCacheDir)
      console.log('Tagged cache files found:', fetchFiles)

      expect(fetchFiles.length).toBeGreaterThan(0)

      // Read and validate cache file content
      const cacheFilePath = path.join(fetchCacheDir, fetchFiles[0])
      const cacheData = await readCacheFile(cacheFilePath)

      expect(cacheData).not.toBeNull()

      // Assert that cacheData is not null for TypeScript
      if (!cacheData) {
        throw new Error('Cache data is null')
      }

      console.log('Tagged cache file structure:', {
        keys: Object.keys(cacheData),
        hasValue: !!cacheData.value,
        hasLastModified: !!cacheData.lastModified,
        hasTags: !!cacheData.tags,
        tagsCount: cacheData.tags?.length || 0,
        tags: cacheData.tags
      })

      // The cache file should have the correct Next.js cache structure
      expect(cacheData).toBeTruthy()
      expect(isValidNextJsCacheFile(cacheData)).toBe(true)

      // Validate the cache contains expected tags
      expect(Array.isArray(cacheData.tags)).toBe(true)
      expect(cacheData.tags.length).toBeGreaterThan(0)

      // The tags should include our expected tags (may also have additional framework tags)
      const expectedTags = ['api-posts', 'external-data']
      const hasExpectedTags = expectedTags.some(tag => cacheData.tags.includes(tag))
      expect(hasExpectedTags).toBe(true)

      console.log('Tagged cache validation successful:', {
        kind: cacheData.value.kind,
        status: cacheData.value.data.status,
        url: cacheData.value.data.url,
        revalidate: cacheData.value.revalidate,
        lastModified: cacheData.lastModified,
        tags: cacheData.tags,
        tagsIncluded: expectedTags.filter(tag => cacheData.tags.includes(tag))
      })
    })

    test('should create and update tags mapping file', async () => {
      console.log('Testing tags mapping file creation...')

      // Make request to create tagged cache
      const response = await fetch(`${BASE_URL}/api/posts/with-tags`)
      expect(response.status).toBe(200)

      // Wait for cache files to be written
      await new Promise(resolve => setTimeout(resolve, 1000))

      // Check that tags mapping file was created
      const tagsMappingExists = await fs.access(tagsMappingPath).then(() => true).catch(() => false)
      expect(tagsMappingExists).toBe(true)

      // Read and validate tags mapping content
      const tagsMapping = await readTagsMapping()
      expect(tagsMapping).not.toBeNull()

      if (!tagsMapping) {
        throw new Error('Tags mapping is null')
      }

      console.log('Tags mapping structure:', {
        keys: Object.keys(tagsMapping),
        apiPostsKeys: tagsMapping['api-posts']?.length || 0,
        externalDataKeys: tagsMapping['external-data']?.length || 0
      })

      // Verify tags mapping contains our expected tags
      expect(typeof tagsMapping).toBe('object')

      // Should have mappings for our cache tags
      const hasApiPosts = 'api-posts' in tagsMapping
      const hasExternalData = 'external-data' in tagsMapping

      // At least one of our expected tags should be present
      expect(hasApiPosts || hasExternalData).toBe(true)

      if (hasApiPosts) {
        expect(Array.isArray(tagsMapping['api-posts'])).toBe(true)
        expect(tagsMapping['api-posts'].length).toBeGreaterThan(0)
      }

      if (hasExternalData) {
        expect(Array.isArray(tagsMapping['external-data'])).toBe(true)
        expect(tagsMapping['external-data'].length).toBeGreaterThan(0)
      }

      console.log('Tags mapping validation successful:', {
        totalTags: Object.keys(tagsMapping).length,
        apiPostsEntries: tagsMapping['api-posts']?.length || 0,
        externalDataEntries: tagsMapping['external-data']?.length || 0,
        sampleKeys: hasApiPosts ? tagsMapping['api-posts'].slice(0, 2) : []
      })
    })

    test('should invalidate tagged cache when revalidating specific tag', async () => {
      console.log('Testing tagged cache revalidation...')

      // First request - create initial cache
      const firstResponse = await fetch(`${BASE_URL}/api/posts/with-tags`)
      const firstData = await firstResponse.json()
      expect(firstResponse.status).toBe(200)

      console.log('First tagged request:', {
        duration: firstData.duration_ms,
        timestamp: firstData.fetched_at
      })

      await new Promise(resolve => setTimeout(resolve, 1000))

      // Verify cache files exist
      const filesAfterFirst = await listCacheFiles(fetchCacheDir)
      expect(filesAfterFirst.length).toBeGreaterThan(0)

      // Second request - should use cache (fast)
      const secondResponse = await fetch(`${BASE_URL}/api/posts/with-tags`)
      const secondData = await secondResponse.json()
      expect(secondResponse.status).toBe(200)

      console.log('Second tagged request (before revalidation):', {
        duration: secondData.duration_ms,
        timestamp: secondData.fetched_at,
        sameTimestamp: firstData.fetched_at === secondData.fetched_at
      })

      // Should be a cache hit (much faster or same timestamp)
      const isCacheHit = secondData.duration_ms < 10 || firstData.fetched_at === secondData.fetched_at
      expect(isCacheHit).toBe(true)

      // Now revalidate the cache tag
      const revalidateResponse = await fetch(`${BASE_URL}/api/revalidate?tag=api-posts`)
      expect(revalidateResponse.status).toBe(200)

      const revalidateData = await revalidateResponse.json()
      expect(revalidateData.message).toContain('api-posts')
      expect(revalidateData.tag).toBe('api-posts')

      console.log('Revalidation response:', {
        message: revalidateData.message,
        tag: revalidateData.tag,
        revalidatedAt: revalidateData.revalidated_at
      })

      // Wait a moment for revalidation to take effect
      await new Promise(resolve => setTimeout(resolve, 500))

      // Third request - should fetch fresh data (slower)
      const thirdResponse = await fetch(`${BASE_URL}/api/posts/with-tags`)
      const thirdData = await thirdResponse.json()
      expect(thirdResponse.status).toBe(200)

      console.log('Third tagged request (after revalidation):', {
        duration: thirdData.duration_ms,
        timestamp: thirdData.fetched_at
      })

      // After revalidation, should either:
      // 1. Have a different timestamp (fresh fetch)
      // 2. Take longer (cache miss)
      const isDifferentTimestamp = thirdData.fetched_at !== secondData.fetched_at
      const isSlowerResponse = thirdData.duration_ms > secondData.duration_ms * 2

      expect(isDifferentTimestamp || isSlowerResponse).toBe(true)

      console.log('Cache revalidation validation:', {
        differentTimestamp: isDifferentTimestamp,
        slowerAfterRevalidation: isSlowerResponse,
        firstDuration: firstData.duration_ms,
        secondDuration: secondData.duration_ms,
        thirdDuration: thirdData.duration_ms
      })
    })

    test('should handle multiple tags revalidation independently', async () => {
      console.log('Testing multiple tags revalidation...')

      // Create tagged cache
      const response = await fetch(`${BASE_URL}/api/posts/with-tags`)
      expect(response.status).toBe(200)

      await new Promise(resolve => setTimeout(resolve, 1000))

      // Revalidate first tag
      const revalidate1 = await fetch(`${BASE_URL}/api/revalidate?tag=api-posts`)
      expect(revalidate1.status).toBe(200)

      const revalidate1Data = await revalidate1.json()
      expect(revalidate1Data.tag).toBe('api-posts')

      // Revalidate second tag
      const revalidate2 = await fetch(`${BASE_URL}/api/revalidate?tag=external-data`)
      expect(revalidate2.status).toBe(200)

      const revalidate2Data = await revalidate2.json()
      expect(revalidate2Data.tag).toBe('external-data')

      // Both should have different timestamps
      expect(revalidate1Data.revalidated_at).toBeDefined()
      expect(revalidate2Data.revalidated_at).toBeDefined()

      console.log('Multiple tag revalidation successful:', {
        tag1: revalidate1Data.tag,
        tag1Time: revalidate1Data.revalidated_at,
        tag2: revalidate2Data.tag,
        tag2Time: revalidate2Data.revalidated_at
      })
    })
  })

  describe('Cross-Strategy Cache Validation', () => {
    test('should handle both basic and tagged caching simultaneously', async () => {
      console.log('Testing mixed cache strategies...')

      // First, create a basic cache entry
      const basicResponse = await fetch(`${BASE_URL}/api/posts/force-cache`)
      expect(basicResponse.status).toBe(200)

      // Then, create a tagged cache entry
      const taggedResponse = await fetch(`${BASE_URL}/api/posts/with-tags`)
      expect(taggedResponse.status).toBe(200)

      await new Promise(resolve => setTimeout(resolve, 1000))

      // Check that both types of cache files exist
      const cacheFiles = await listCacheFiles(fetchCacheDir)
      expect(cacheFiles.length).toBeGreaterThan(1) // Should have both cache entries

      // Verify tags mapping includes tagged entries
      const tagsMapping = await readTagsMapping()
      expect(tagsMapping).not.toBeNull()

      if (tagsMapping) {
        const hasApiPosts = 'api-posts' in tagsMapping
        const hasExternalData = 'external-data' in tagsMapping
        expect(hasApiPosts || hasExternalData).toBe(true)
      }

      console.log('Mixed cache strategies validation successful:', {
        totalCacheFiles: cacheFiles.length,
        hasTags: !!tagsMapping,
        tagKeys: tagsMapping ? Object.keys(tagsMapping) : []
      })
    })
  })
})