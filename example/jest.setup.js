// Jest setup file for integration tests

// Set test environment variables
process.env.NODE_ENV = 'test'
process.env.CACHE_HANDLER = 'file' // Force file cache handler for testing

// Ensure we have a clean cache directory for each test
const fs = require('fs')
const path = require('path')

// Clean up cache directory before tests
beforeAll(async () => {
  const projectRoot = path.resolve(process.cwd())
  const cacheDir = path.resolve(projectRoot, '.next', 'cache')

  // Defence-in-depth: only ever delete a directory that lives inside the
  // project's own .next/cache. The path is built from constants, but the
  // explicit containment check keeps the recursive delete provably scoped.
  if (
    cacheDir !== projectRoot &&
    cacheDir.startsWith(projectRoot + path.sep) &&
    fs.existsSync(cacheDir)
  ) {
    fs.rmSync(cacheDir, { recursive: true, force: true })
  }
})