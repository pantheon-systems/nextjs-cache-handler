/**
 * A deploy against GCS, in real `next start` processes: the build check, the
 * background route cache clean-up and its lock across processes, the CDN
 * purge and the tags map pruning.
 *
 * Runs only with CACHE_GCS_API_ENDPOINT set, against a GCS emulator
 * (fake-gcs-server in CI). The emulator ignores delete preconditions, so an
 * entry rewritten during the delete is covered by the unit tests instead.
 */

import { spawn, type ChildProcess } from 'child_process'
import { createHash } from 'crypto'
import * as fs from 'fs/promises'
import * as http from 'http'
import * as path from 'path'

const endpoint = process.env.CACHE_GCS_API_ENDPOINT
const describeWithEmulator = endpoint ? describe : describe.skip

const OLD_BUILD = 'old-build'
const OLD_ENTRIES = 10_000
const PORTS = [3201, 3202, 3203]
const JOB = 'route-cache-cleanup.json'

// toObjectName (src/utils/object-names.ts) for keys starting with `/`, which are always hashed.
const routeObject = (key: string) =>
  `route-cache/${key.replace(/[^a-zA-Z0-9-]/g, '_').slice(0, 183)}_${createHash('sha256')
    .update(key)
    .digest('hex')
    .slice(0, 16)}.json`

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function waitFor<T>(what: string, fn: () => Promise<T | undefined>, timeoutMs: number): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await fn().catch(() => undefined)
    if (value !== undefined) return value
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`)
    await sleep(500)
  }
}

interface Server {
  port: number
  process: ChildProcess
  /** Log lines with the time each arrived. */
  lines: Array<{ at: number; text: string }>
}

interface StoredObject {
  name: string
  generation: string
  metadata?: { generation?: string }
}

describeWithEmulator('GCS deploy across processes', () => {
  const bucketName = `deploy-${Date.now()}`
  // The emulator's JSON API through fetch: the storage library's streams fail under Jest.
  const objectUrl = (name: string) => `${endpoint}/storage/v1/b/${bucketName}/o/${encodeURIComponent(name)}`

  const purges: string[] = []
  let purgeStub: http.Server
  let servers: Server[] = []
  let generation: string
  let firstResponseAt = 0
  let firstResponseMs = 0
  let jobPendingDuringWrite = false

  /** Write an object, stamped as the handler stamps route entries; resolves to the HTTP status. */
  async function save(name: string, value: unknown, stampedWith?: string, ifGenerationMatch?: string) {
    const boundary = 'integration-boundary'
    const metadata = { name, contentType: 'application/json', ...(stampedWith ? { metadata: { generation: stampedWith } } : {}) }
    const body =
      `--${boundary}\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(metadata)}\r\n` +
      `--${boundary}\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(value)}\r\n--${boundary}--`
    const query = ifGenerationMatch === undefined ? '' : `&ifGenerationMatch=${ifGenerationMatch}`
    const response = await fetch(`${endpoint}/upload/storage/v1/b/${bucketName}/o?uploadType=multipart${query}`, {
      method: 'POST',
      headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
      body,
    })
    if (!response.ok && response.status !== 412) throw new Error(`saving ${name}: HTTP ${response.status}`)
    return response.status
  }
  async function stat(name: string): Promise<StoredObject | undefined> {
    const response = await fetch(objectUrl(name))
    if (response.status === 404) return undefined
    if (!response.ok) throw new Error(`reading ${name}: HTTP ${response.status}`)
    return response.json()
  }
  async function readJson(name: string) {
    const response = await fetch(`${objectUrl(name)}?alt=media`)
    if (!response.ok) throw new Error(`downloading ${name}: HTTP ${response.status}`)
    return response.json()
  }
  const exists = async (name: string) => (await stat(name)) !== undefined
  async function list(prefix: string): Promise<StoredObject[]> {
    const objects: StoredObject[] = []
    let pageToken: string | undefined
    do {
      const query = new URLSearchParams({ prefix, ...(pageToken ? { pageToken } : {}) })
      const page = await (await fetch(`${endpoint}/storage/v1/b/${bucketName}/o?${query}`)).json()
      objects.push(...(page.items ?? []))
      pageToken = page.nextPageToken
    } while (pageToken)
    return objects
  }
  const logged = (pattern: RegExp) =>
    servers.flatMap((server) => server.lines.filter((line) => pattern.test(line.text)))

  /** Add `key` under `tag` in tags.json, as another instance's conditional flush would. */
  async function addTagKey(tag: string, key: string) {
    const tagsKey = 'cache/tags/tags.json'
    for (let attempt = 0; attempt < 10; attempt++) {
      const { generation: stored } = (await stat(tagsKey))!
      const mapping = await readJson(tagsKey)
      mapping[tag] = [...new Set([...(mapping[tag] ?? []), key])]
      if ((await save(tagsKey, mapping, undefined, stored)) !== 412) return
    }
    throw new Error('tags.json kept changing')
  }

  function startServer(port: number): Server {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      NODE_ENV: 'production',
      CACHE_BUCKET: bucketName,
      OUTBOUND_PROXY_ENDPOINT: `127.0.0.1:${(purgeStub.address() as { port: number }).port}`,
      // One delete at a time, so the clean-up outlasts the first requests.
      CACHE_INVALIDATION_DELETE_CONCURRENCY: '1',
    }
    delete env.PANTHEON_ENVIRONMENT
    const next = require.resolve('next/dist/bin/next', { paths: [process.cwd()] })
    const child = spawn(process.execPath, [next, 'start', '-p', String(port)], {
      cwd: process.cwd(),
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const server: Server = { port, process: child, lines: [] }
    const collect = (chunk: Buffer) => {
      for (const text of chunk.toString().split('\n').filter(Boolean)) {
        server.lines.push({ at: Date.now(), text })
      }
    }
    child.stdout!.on('data', collect)
    child.stderr!.on('data', collect)
    return server
  }

  beforeAll(async () => {
    const created = await fetch(`${endpoint}/storage/v1/b?project=test`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: bucketName }),
    })
    expect(created.ok).toBe(true)

    purgeStub = http.createServer((req, res) => {
      purges.push(`${req.method} ${req.url}`)
      res.writeHead(200, { 'Content-Type': 'application/json' }).end('{}')
    })
    await new Promise<void>((resolve) => purgeStub.listen(0, '127.0.0.1', resolve))

    // Built without CACHE_BUCKET: the build writes nothing to the bucket.
    await new Promise<void>((resolve, reject) => {
      const build = spawn('npm', ['run', 'build'], { cwd: process.cwd(), stdio: 'inherit', env: process.env })
      build.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`Build failed with code ${code}`))))
    })
    generation = (await fs.readFile(path.join(process.cwd(), '.next', 'BUILD_ID'), 'utf-8')).trim()

    // The previous build's cache, as it stands when the deploy starts.
    await save('build-meta.json', { buildId: OLD_BUILD, timestamp: 1 })
    const names = Array.from({ length: OLD_ENTRIES }, (_, i) => `route-cache/old-${String(i).padStart(5, '0')}.json`)
    for (let i = 0; i < names.length; i += 50) {
      await Promise.all(names.slice(i, i + 50).map((name) => save(name, { value: null }, OLD_BUILD)))
    }
    await save(routeObject('/old-page'), { value: null }, OLD_BUILD)
    await save('route-cache/unstamped.json', { value: null }) // written before 0.13.4
    // A page an instance of the new build cached before this one started.
    await save(routeObject('/current-page'), { value: null }, generation)
    await save('cache/tags/tags.json', { posts: ['/old-page', '/current-page'], data: ['a1b2c3'] })

    servers = PORTS.map(startServer)
    await waitFor(
      'every server to listen',
      async () => (servers.every((server) => server.lines.some((line) => /Ready in/.test(line.text))) ? true : undefined),
      120_000
    )
    // Every process's first request at once, so they all find the previous build and race for the clean-up.
    const started = Date.now()
    const responses = await Promise.all(PORTS.map((port) => fetch(`http://127.0.0.1:${port}/`)))
    firstResponseAt = Date.now()
    firstResponseMs = firstResponseAt - started
    expect(responses.map((response) => response.status)).toEqual(PORTS.map(() => 200))

    // A new-build instance caches a page while the clean-up runs.
    jobPendingDuringWrite = await exists(JOB)
    await save(routeObject('/during'), { value: null }, generation)
    await addTagKey('posts', '/during')

    await waitFor('the clean-up to finish', async () => ((await exists(JOB)) ? undefined : true), 300_000)
  }, 600_000)

  afterAll(async () => {
    for (const server of servers) {
      server.process.kill('SIGTERM')
    }
    await new Promise((resolve) => purgeStub?.close(resolve))
  })

  it('records the new build and answers before the clean-up finishes', async () => {
    expect((await readJson('build-meta.json')).buildId).toBe(generation)
    const [finished] = logged(/Route cache clean-up for build .* finished/)
    expect(finished).toBeDefined()
    expect(firstResponseAt).toBeLessThan(finished.at)
    expect(firstResponseMs).toBeLessThan(5_000)
  })

  it('has every process find the previous build', () => {
    for (const server of servers) {
      expect(server.lines.some((line) => /New build detected \(old-build -> /.test(line.text))).toBe(true)
    }
  })

  it('deletes every entry of earlier builds, and keeps the new build’s', async () => {
    expect(jobPendingDuringWrite).toBe(true)
    const stamps = new Map((await list('route-cache/')).map((object) => [object.name, object.metadata?.generation]))
    // Next may also have cached pages of its own by now; all of them are the new build's.
    expect([...stamps.values()].every((stamp) => stamp === generation)).toBe(true)
    expect(stamps.has(routeObject('/current-page'))).toBe(true)
    expect(stamps.has(routeObject('/during'))).toBe(true)
  })

  it('keeps the new build’s keys and fetch keys in tags.json', async () => {
    const mapping = await readJson('cache/tags/tags.json')
    expect([...mapping.posts].sort()).toEqual(['/current-page', '/during'])
    expect(mapping.data).toEqual(['a1b2c3'])
  })

  it('runs the clean-up in one process only, and logs its totals', async () => {
    expect(logged(/Route cache clean-up for build .* (started|resumed)/)).toHaveLength(1)
    const finished = logged(/Route cache clean-up for build .* finished/)
    expect(finished).toHaveLength(1)
    expect(finished[0].text).toContain(`build ${generation} finished: deleted ${OLD_ENTRIES + 2} objects of earlier builds`)
    expect(finished[0].text).toContain(' 0 failed')
  })

  it('purges the whole CDN', () => {
    expect(purges).toContain('DELETE /rest/v0alpha1/cache')
  })
})
