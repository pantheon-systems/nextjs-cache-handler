import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  cacheHandler: path.resolve(__dirname, './cache-handler.mjs'),
  cacheMaxMemorySize: 0, // disable default in-memory caching
  outputFileTracingRoot: __dirname,
};

export default nextConfig;
