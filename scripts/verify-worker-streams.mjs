// Serves real bytes through the built Worker, under the real workerd runtime, through `wrangler
// dev`, on this machine: a meeting's audio with and without Range, and ffmpeg's wasm. Nothing
// here is deployed and no real service is called. Supabase and R2 are fakes in this process, and
// the fake R2 stops part way through an object until it is told to go on, which is what shows
// bytes arriving as a stream, before R2 has finished. Also reads the headers a static asset gets.
//
// Usage:
//   NITRO_PRESET=cloudflare_module pnpm build
//   node scripts/verify-worker-streams.mjs
//   pnpm build    # puts the Node build back: the e2e and browser jobs need it
//
// Not part of `pnpm ci:local`, because it needs a build of its own. It shows nothing of the edge:
// CPU here is `ps` on a Mac, and the free plan's limits are not enforced by wrangler dev.
//
// Runs from a temporary copy, so wrangler cannot find this repo's .env, and with almost nothing
// in the environment, so it cannot find a token either. Never run `wrangler dev` at the repo root
// on a Worker build: nothing stops it there now the wasm is gone, and it reads the real .env.
import { execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { access, cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const rootDir = fileURLToPath(new URL('..', import.meta.url))
const wrangler = join(rootDir, 'node_modules/.bin/wrangler')
const PORT = 8803
const CHUNK = 64 * 1024
const STALL_AFTER = 1024 * 1024
const WAIT_FOR_FIRST_BYTE_MS = 5000

const MEETING = '11111111-1111-4111-8111-111111111111'
const AUDIO_KEY = `meetings/${MEETING}/audio.ogg`
const AUDIO = Buffer.alloc(20 * 1024 * 1024)
for (let i = 0; i < AUDIO.length; i++) AUDIO[i] = (i * 31 + (i >> 8)) % 251

const FORBIDDEN_IN_A_FAILURE = /r2|bucket|assets\/|cloudflarestorage|fake-value|HTTP \d|NoSuchKey|<\?xml|\.mjs/i

let failed = 0
const check = (ok, message) => {
  if (ok) console.log(`ok: ${message}`)
  else {
    failed++
    console.error(`FAIL: ${message}`)
    process.exitCode = 1
  }
}
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

const { preset } = JSON.parse(await readFile(join(rootDir, '.output/nitro.json'), 'utf8'))
if (!preset.startsWith('cloudflare')) {
  console.error(`FAIL: .output is a ${preset} build. Run NITRO_PRESET=cloudflare_module pnpm build first.`)
  process.exit(1)
}
const version = /^export const FFMPEG_CORE_VERSION = '([^']+)'$/m.exec(await readFile(join(rootDir, 'shared/utils/ffmpeg-core.ts'), 'utf8'))?.[1]
const WASM_KEY = `assets/ffmpeg/${version}/ffmpeg-core.wasm`
const WASM = await readFile(join(rootDir, 'node_modules/@ffmpeg/core/dist/esm/ffmpeg-core.wasm'))

// ---------------------------------------------------------------- the world outside the Worker

const objects = new Map([[AUDIO_KEY, AUDIO], [WASM_KEY, WASM]])
/** Every key the fake R2 was asked for, and what the current read has done. */
const asked = []
let read = { written: 0, finished: false, closedEarly: false }
let hold = null
let r2Status = null

const release = () => {
  hold?.resolve()
  hold = null
}
function holdNextRead() {
  let resolve
  const promise = new Promise((done) => {
    resolve = done
  })
  hold = { promise, resolve }
}

/** The socket can take more, or there is no socket any more. */
function drained(res) {
  return new Promise((resolve) => {
    const done = () => {
      res.off('drain', done)
      res.off('close', done)
      resolve()
    }
    res.on('drain', done)
    res.on('close', done)
  })
}

/** Sends the bytes in chunks, and waits where it was told to, part way through. */
async function sendBytes(res, bytes) {
  const current = { written: 0, finished: false, closedEarly: false }
  read = current
  let gone = false
  res.once('close', () => {
    gone = true
    if (!current.finished) current.closedEarly = true
  })
  const waiting = hold
  for (let at = 0; at < bytes.length && !gone; at += CHUNK) {
    const piece = bytes.subarray(at, at + CHUNK)
    if (!res.write(piece)) await drained(res)
    current.written += piece.length
    if (waiting && at < STALL_AFTER && at + CHUNK >= STALL_AFTER) await waiting.promise
  }
  if (gone) return
  res.end()
  current.finished = true
}

const outside = createServer(async (req, res) => {
  const url = req.url
  if (url.startsWith('/db/')) {
    res.setHeader('content-type', 'application/json')
    const now = new Date().toISOString()
    res.end(JSON.stringify([{
      id: MEETING, created_at: now, updated_at: now, title: 'Streams', status: 'ready', source_file_name: 'a.mp4',
      source_bytes: 1, source_mime: null, duration_sec: 10, audio_key: AUDIO_KEY, audio_bytes: AUDIO.length,
      audio_mime: 'audio/ogg', uploaded_at: now, error_message: null, failed_stage: null,
    }]))
    return
  }
  if (!url.startsWith('/r2/')) {
    res.statusCode = 500
    res.end('{"error":"nothing here"}')
    return
  }
  const key = decodeURIComponent(url.replace(/^\/r2\/[^/]+\//, '').split('?')[0])
  asked.push(key)
  if (r2Status) {
    res.statusCode = r2Status
    res.end('<?xml version="1.0"?><Error><Code>AccessDenied</Code><Resource>bucket/assets/secret</Resource></Error>')
    return
  }
  const stored = objects.get(key)
  if (!stored) {
    res.statusCode = 404
    res.end('<?xml version="1.0"?><Error><Code>NoSuchKey</Code></Error>')
    return
  }
  res.setHeader('etag', `"${sha(stored).slice(0, 16)}"`)
  // As any object can be, and neither route may repeat it.
  res.setHeader('content-type', 'text/html')
  res.setHeader('cache-control', 'no-cache')
  const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? '')
  if (range) {
    const start = Number(range[1])
    const end = Math.min(range[2] ? Number(range[2]) : stored.length - 1, stored.length - 1)
    if (start >= stored.length) {
      res.statusCode = 416
      res.setHeader('content-range', `bytes */${stored.length}`)
      res.end()
      return
    }
    res.statusCode = 206
    res.setHeader('content-range', `bytes ${start}-${end}/${stored.length}`)
    res.setHeader('content-length', end - start + 1)
    await sendBytes(res, stored.subarray(start, end + 1))
    return
  }
  res.setHeader('content-length', stored.length)
  await sendBytes(res, stored)
})
await new Promise(resolve => outside.listen(0, '127.0.0.1', resolve))
const outsidePort = outside.address().port

// ---------------------------------------------------------------- the Worker

const dir = await mkdtemp(join(tmpdir(), 'meetmind-worker-streams-'))
await cp(join(rootDir, '.output/server'), join(dir, 'server'), { recursive: true })
await cp(join(rootDir, '.output/public'), join(dir, 'public'), { recursive: true })
await writeFile(join(dir, 'entry.mjs'), `
import built from './server/index.mjs'
const realFetch = globalThis.fetch
globalThis.fetch = (input, init) => {
  const request = new Request(input, init)
  const url = new URL(request.url)
  if (!url.hostname.endsWith('.r2.cloudflarestorage.com')) return realFetch(request)
  return realFetch(new Request('http://127.0.0.1:${outsidePort}/r2' + url.pathname + url.search, request))
}
export default built
`)
const config = (await readFile(join(rootDir, 'wrangler.jsonc'), 'utf8'))
  .split('\n').filter(line => !line.trim().startsWith('//')).join('\n')
const { compatibility_date, compatibility_flags } = JSON.parse(config)
await writeFile(join(dir, 'wrangler.json'), JSON.stringify({
  name: 'meetmind-streams-check',
  main: 'entry.mjs',
  compatibility_date,
  compatibility_flags,
  assets: { directory: 'public', binding: 'ASSETS' },
}))
await writeFile(join(dir, '.dev.vars'), Object.entries({
  NUXT_GROQ_API_KEY: 'fake-value-groq',
  NUXT_WORKERS_AI_ACCOUNT_ID: 'fake-value-account',
  NUXT_WORKERS_AI_API_TOKEN: 'fake-value-token',
  NUXT_SUPABASE_URL: `http://127.0.0.1:${outsidePort}/db`,
  NUXT_SUPABASE_SERVICE_KEY: 'fake-value-service',
  NUXT_R2_ACCOUNT_ID: 'fake-value-r2-account',
  NUXT_R2_ACCESS_KEY_ID: 'fake-value-r2-key',
  NUXT_R2_SECRET_ACCESS_KEY: 'fake-value-r2-secret',
  NUXT_R2_BUCKET: 'bucket',
}).map(([key, value]) => `${key}=${value}`).join('\n'))

const base = `http://127.0.0.1:${PORT}`
let logs = ''
const worker = spawn(wrangler, ['dev', '--port', String(PORT), '--inspector-port', String(PORT + 1), '--ip', '127.0.0.1'], {
  cwd: dir,
  // detached, so the whole group can be stopped: wrangler runs workerd as a child.
  detached: true,
  env: { PATH: process.env.PATH, HOME: process.env.HOME, WRANGLER_SEND_METRICS: 'false', NO_COLOR: '1' },
})
worker.stdout.on('data', chunk => (logs += chunk))
worker.stderr.on('data', chunk => (logs += chunk))

/** Seconds of CPU workerd has used, by `ps`, which is coarse. Only ever this run's group. */
function workerdCpuSeconds() {
  const lines = execFileSync('ps', ['-axo', 'pgid=,time=,command=']).toString().split('\n')
  let total = 0
  for (const line of lines) {
    const [pgid, time, ...command] = line.trim().split(/\s+/)
    if (Number(pgid) !== worker.pid || !command.join(' ').includes('workerd')) continue
    total += time.split(':').map(Number).reduce((sum, part) => sum * 60 + part, 0)
  }
  return total
}

/**
 * One response read as a browser reads it, with the fake R2 stopped part way through the
 * object. Whatever is held back there cannot be in the first chunk unless the Worker streams.
 */
async function readWhileHeld(path, headers) {
  holdNextRead()
  const started = performance.now()
  const cpuBefore = workerdCpuSeconds()
  const firstArrived = (async () => {
    const res = await fetch(`${base}${path}`, { headers })
    const reader = res.body.getReader()
    const first = await reader.read()
    return { res, reader, first }
  })()
  const got = await Promise.race([firstArrived, sleep(WAIT_FOR_FIRST_BYTE_MS).then(() => null)])
  const firstByteMs = Math.round(performance.now() - started)
  const seenAtFirstByte = { written: read.written, finished: read.finished }
  release()
  const { res, reader, first } = got ?? await firstArrived
  const pieces = first.value ? [Buffer.from(first.value)] : []
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    pieces.push(Buffer.from(value))
  }
  // CPU is read a moment later, as `ps` lags what it counts.
  await sleep(200)
  return { res, streamed: got !== null, firstByteMs, seenAtFirstByte, bytes: Buffer.concat(pieces), cpuSeconds: workerdCpuSeconds() - cpuBefore }
}

async function checkStreamed(name, path, headers, wanted, expectations) {
  const { res, streamed, firstByteMs, seenAtFirstByte, bytes, cpuSeconds } = await readWhileHeld(path, headers)
  console.log(`  (${name}: status ${res.status}, ${bytes.length} bytes, first byte at ${firstByteMs} ms with R2 stopped at ${seenAtFirstByte.written} of ${wanted.length} bytes, workerd CPU ${cpuSeconds.toFixed(2)} s)`)
  check(res.status === expectations.status, `${name}: answers ${expectations.status} (got ${res.status})`)
  check(streamed && !seenAtFirstByte.finished && seenAtFirstByte.written < wanted.length, `${name}: the first bytes arrived while R2 was stopped part way through`)
  check(sha(bytes) === sha(wanted), `${name}: every byte arrived, the right ones (${bytes.length} of ${wanted.length})`)
  check(cpuSeconds < 1, `${name}: spent well under a second of CPU, by ps (${cpuSeconds.toFixed(2)} s)`)
  check(res.headers.get('content-length') === String(wanted.length), `${name}: says its length (${res.headers.get('content-length')})`)
  check(res.headers.get('content-type') === expectations.type, `${name}: has the pinned type, not the object's (${res.headers.get('content-type')})`)
  check(res.headers.get('cache-control') === expectations.cache, `${name}: has the pinned cache header (${res.headers.get('cache-control')})`)
  check(res.headers.get('x-content-type-options') === 'nosniff', `${name}: says nosniff, once`)
  return res
}

try {
  let up = false
  for (let i = 0; i < 120 && !up; i++) {
    up = await fetch(`${base}/api/health`).then(res => res.ok, () => false)
    if (!up) await sleep(500)
  }
  if (!up) throw new Error(`the worker never became healthy:\n${logs}`)

  console.log('\n# Audio, 20 MB')
  const audioPath = `/api/meetings/${MEETING}/audio`
  const audio = { type: 'audio/ogg', cache: 'private, max-age=3600, no-transform' }
  const whole = await checkStreamed('no Range', audioPath, {}, AUDIO, { ...audio, status: 200 })
  check(whole.headers.get('accept-ranges') === 'bytes', 'no Range: still offers ranges')
  const open = await checkStreamed('bytes=0-', audioPath, { range: 'bytes=0-' }, AUDIO, { ...audio, status: 206 })
  check(open.headers.get('content-range') === `bytes 0-${AUDIO.length - 1}/${AUDIO.length}`, `bytes=0-: says what it served (${open.headers.get('content-range')})`)
  const window = await checkStreamed('a window of 4 MB', audioPath, { range: 'bytes=1000000-4999999' }, AUDIO.subarray(1000000, 5000000), { ...audio, status: 206 })
  check(window.headers.get('content-range') === `bytes 1000000-4999999/${AUDIO.length}`, `a window: says what it served (${window.headers.get('content-range')})`)

  const past = await fetch(`${base}${audioPath}`, { headers: { range: `bytes=${AUDIO.length}-` } })
  check(past.status === 416 && past.headers.get('content-range') === `bytes */${AUDIO.length}`, `a range past the end: 416 with the true length (got ${past.status})`)

  console.log('\n# Audio, the player seeks away')
  holdNextRead()
  const seek = await fetch(`${base}${audioPath}`, { headers: { range: 'bytes=0-' } })
  const seekReader = seek.body.getReader()
  await seekReader.read()
  await seekReader.cancel()
  const left = read
  release()
  for (let i = 0; i < 40 && !left.closedEarly && !left.finished; i++) await sleep(100)
  console.log(`  (R2 had sent ${left.written} of ${AUDIO.length} bytes when the Worker let go)`)
  check(left.closedEarly && !left.finished, 'cancelling the response stops the read from R2, rather than pulling the rest')

  console.log('\n# ffmpeg\'s wasm')
  await access(join(rootDir, '.output/public/ffmpeg/ffmpeg-core.js'))
  check(await access(join(rootDir, '.output/public/ffmpeg/ffmpeg-core.wasm')).then(() => false, () => true), 'the build has no wasm among its assets')
  const wasm = { type: 'application/wasm', cache: 'public, max-age=31536000, immutable', status: 200 }
  // Without compression, so its length can be read. The same bytes must come out of the
  // compressed answer a browser asks for, whichever runtime is doing it. No check of that
  // one's CPU: here workerd may be compressing, and at the edge that is not the Worker's.
  await checkStreamed('the wasm', `/ffmpeg/ffmpeg-core.wasm?v=${version}`, { 'accept-encoding': 'identity' }, WASM, wasm)
  const compressed = await readWhileHeld(`/ffmpeg/ffmpeg-core.wasm?v=${version}`, { 'accept-encoding': 'gzip' })
  console.log(`  (the wasm, asked for with gzip: content-encoding ${compressed.res.headers.get('content-encoding')}, first byte at ${compressed.firstByteMs} ms, workerd CPU ${compressed.cpuSeconds.toFixed(2)} s)`)
  check(compressed.streamed && sha(compressed.bytes) === sha(WASM), 'the wasm, asked for with gzip: streams, and the same bytes come out')
  // A route for GET answers nothing else, so `curl -I` is no way to look at this one.
  asked.length = 0
  const head = await fetch(`${base}/ffmpeg/ffmpeg-core.wasm?v=${version}`, { method: 'HEAD' })
  check(head.status === 404 && asked.length === 0, `a HEAD answers 404 and costs no read of R2 (got ${head.status}, ${asked.length} reads)`)
  await (await fetch(`${base}/ffmpeg/ffmpeg-core.wasm?key=${encodeURIComponent(AUDIO_KEY)}&v=other`)).body.cancel()
  check(asked.length === 1 && asked[0] === WASM_KEY, `no query steers it to another object (asked for ${JSON.stringify(asked)})`)
  const steer = await fetch(`${base}/ffmpeg/ffmpeg-core.wasm/${encodeURIComponent(`../../${AUDIO_KEY}`)}`)
  await steer.body?.cancel()
  check(asked.length === 1, 'no path steers it either')

  objects.delete(WASM_KEY)
  const missing = await fetch(`${base}/ffmpeg/ffmpeg-core.wasm?v=${version}`)
  const missingText = await missing.text()
  check(missing.status === 404 && !FORBIDDEN_IN_A_FAILURE.test(missingText), `the file not put there yet: a plain 404 (got ${missing.status}: ${missingText})`)
  check(missing.headers.get('cache-control') === 'no-store', 'and that is not cached')
  objects.set(WASM_KEY, WASM)
  r2Status = 403
  const refused = await fetch(`${base}/ffmpeg/ffmpeg-core.wasm?v=${version}`)
  const refusedText = await refused.text()
  r2Status = null
  check(refused.status === 503 && !FORBIDDEN_IN_A_FAILURE.test(refusedText), `R2 refusing: a plain 503 with none of its words (got ${refused.status}: ${refusedText})`)

  console.log('\n# Headers, on everything')
  const assets = await readFile(join(rootDir, '.output/public/_headers'), 'utf8')
  const everything = assets.split(/^\/\*$/m)[1] ?? ''
  for (const line of ['X-Content-Type-Options: nosniff', 'X-Frame-Options: DENY', 'Content-Security-Policy: frame-ancestors \'none\'']) {
    check(everything.includes(line), `the build's _headers has ${line} for /*`)
  }
  for (const path of ['/', '/api/health', '/robots.txt', '/ffmpeg/ffmpeg-core.js', audioPath, '/ffmpeg/ffmpeg-core.wasm']) {
    const res = await fetch(`${base}${path}`)
    await res.body?.cancel()
    const said = ['x-content-type-options', 'x-frame-options', 'content-security-policy'].map(name => res.headers.get(name)).join(' | ')
    check(said === 'nosniff | DENY | frame-ancestors \'none\'', `${path} says all three, once each (${said})`)
  }
  check(!logs.includes('fake-value'), 'logged no value')
}
finally {
  release()
  try {
    process.kill(-worker.pid, 'SIGTERM')
  }
  catch { /* already gone */ }
  await new Promise(resolve => worker.once('exit', resolve))
  outside.closeAllConnections()
  outside.close()
  await rm(dir, { recursive: true, force: true })
}

console.log(failed ? `\nFAILED: ${failed}` : '\nPASSED')
