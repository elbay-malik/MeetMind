// Runs ADR-0016's gate under the real workerd runtime, through `wrangler dev`, on this
// machine. Nothing here is deployed and no real service is called: the Supabase URL points at
// a fake in this process, which counts what reaches it, and every other credential is made up.
//
// Usage:
//   NITRO_PRESET=cloudflare_module pnpm build
//   node scripts/verify-worker-gate.mjs
//   pnpm build    # puts the Node build back: the e2e and browser jobs need it
//
// Not part of `pnpm ci:local`, because it needs a build of its own. It proves what a Worker
// does with its settings as `wrangler dev` hands them over, and not what a deployment does
// with its secrets: that waits for Phase 13.
//
// Runs from a temporary copy, so wrangler cannot find this repo's .env, and with almost
// nothing in the environment, so it cannot find a token either. The copy leaves out
// public/ffmpeg, which is over the assets limit (ADR-0009).
//
// Never run `wrangler dev` at the repo root on a Worker build. Nothing stops it there now the wasm
// is gone from the build, and it reads the real .env, with the real database and quota behind it.
import { spawn } from 'node:child_process'
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const rootDir = fileURLToPath(new URL('..', import.meta.url))
const wrangler = join(rootDir, 'node_modules/.bin/wrangler')
const PORT = 8799

const MEETING = '00000000-0000-4000-8000-000000000001'
const REFUSED = 'MeetMind is not available at the moment. Try again later.'
const INVITE = 'worker-invite-code-0123456789abcdefghij'
const ADMIN = 'worker-admin-token-0123456789abcdefghij'

const fail = (message) => {
  console.error(`FAIL: ${message}`)
  process.exitCode = 1
}
const check = (ok, message) => {
  if (ok) console.log(`ok: ${message}`)
  else fail(message)
}

const { preset } = JSON.parse(await readFile(join(rootDir, '.output/nitro.json'), 'utf8'))
if (!preset.startsWith('cloudflare')) {
  console.error(`FAIL: .output is a ${preset} build. Run NITRO_PRESET=cloudflare_module pnpm build first.`)
  process.exit(1)
}

const dir = await mkdtemp(join(tmpdir(), 'meetmind-worker-gate-'))
await cp(join(rootDir, '.output/server'), join(dir, 'server'), { recursive: true })
await cp(join(rootDir, '.output/public'), join(dir, 'public'), { recursive: true, filter: source => !source.includes('/public/ffmpeg') })
// The real one's compatibility settings, since those decide what `process.env` and `navigator` are.
const config = (await readFile(join(rootDir, 'wrangler.jsonc'), 'utf8'))
  .split('\n').filter(line => !line.trim().startsWith('//')).join('\n')
const { compatibility_date, compatibility_flags } = JSON.parse(config)
await writeFile(join(dir, 'wrangler.json'), JSON.stringify({
  name: 'meetmind-gate-check',
  main: 'server/index.mjs',
  compatibility_date,
  compatibility_flags,
  assets: { directory: 'public', binding: 'ASSETS' },
}))

const realCalls = []
let answer = '[]'
const fakeSupabase = createServer((req, res) => {
  realCalls.push(`${req.method} ${req.url}`)
  req.resume()
  res.setHeader('content-type', 'application/json')
  res.end(answer)
})
await new Promise(resolve => fakeSupabase.listen(0, '127.0.0.1', resolve))

const EVERY_SETTING = {
  NUXT_GROQ_API_KEY: 'fake-value-groq',
  NUXT_WORKERS_AI_ACCOUNT_ID: 'fake-value-account',
  NUXT_WORKERS_AI_API_TOKEN: 'fake-value-token',
  NUXT_SUPABASE_URL: `http://127.0.0.1:${fakeSupabase.address().port}`,
  NUXT_SUPABASE_SERVICE_KEY: 'fake-value-service',
  NUXT_R2_ACCOUNT_ID: 'fake-value-r2-account',
  NUXT_R2_ACCESS_KEY_ID: 'fake-value-r2-key',
  NUXT_R2_SECRET_ACCESS_KEY: 'fake-value-r2-secret',
  NUXT_R2_BUCKET: 'fake-value-bucket',
}
const OPT_IN_AND_FLAGS = {
  NUXT_ALLOW_LOCAL_DRIVERS: 'true',
  NUXT_SUMMARY_STUB_CANARY: 'true',
  NUXT_TRANSCRIBE_STUB_QUOTA_FAIL: 'true',
  NUXT_SUMMARY_STUB_FAIL_ONCE_RETRYABLE: 'true',
  NUXT_ANSWER_STUB_PACED: 'true',
  NUXT_EMBED_STUB_QUOTA_CANARY: 'canary',
  NUXT_STUB_FAILURE_CANARY: 'canary',
}
const ALWAYS = { NUXT_INVITE_CODE: INVITE, NUXT_ADMIN_TOKEN: ADMIN }

const base = `http://127.0.0.1:${PORT}`
const json = { 'content-type': 'application/json' }
const invited = { authorization: `Bearer ${INVITE}` }
const meetingBody = JSON.stringify({ title: 'Gate', sourceFileName: 'g.mp4', sourceBytes: 1_000_000, sourceMime: 'video/mp4', durationSec: 30, audioBytes: 4096 })
const ROUTES = [
  ['POST', '/api/invite-check', invited],
  ['POST', '/api/meetings', { ...invited, ...json }, meetingBody],
  ['GET', `/api/meetings/${MEETING}`],
  ['DELETE', `/api/meetings/${MEETING}`, { authorization: `Bearer ${ADMIN}` }],
  ['POST', `/api/meetings/${MEETING}/advance`],
  ['POST', `/api/meetings/${MEETING}/ask`, json, JSON.stringify({ question: 'What was decided?' })],
  ['GET', `/api/meetings/${MEETING}/audio`],
  ['POST', `/api/meetings/${MEETING}/complete`],
  ['GET', `/api/meetings/${MEETING}/pipeline`],
  ['GET', `/api/meetings/${MEETING}/search-index`],
  ['POST', `/api/meetings/${MEETING}/search-index`],
  ['POST', `/api/meetings/${MEETING}/summarize`],
  ['GET', `/api/meetings/${MEETING}/summary`],
  ['POST', `/api/meetings/${MEETING}/transcribe`],
  ['GET', `/api/meetings/${MEETING}/transcript`],
  ['PUT', '/api/uploads/any-token-at-all', { 'content-type': 'audio/ogg' }, 'x'],
]
const ask = ([method, path, headers, body]) => fetch(`${base}${path}`, { method, headers, body })

/** One `wrangler dev` with these settings, for as long as `work` runs. Hands `work` what has been logged. */
async function withWorker(vars, work) {
  await writeFile(join(dir, '.dev.vars'), Object.entries(vars).map(([key, value]) => `${key}=${value}`).join('\n'))
  realCalls.length = 0
  let logs = ''
  const worker = spawn(wrangler, ['dev', '--port', String(PORT), '--inspector-port', String(PORT + 1), '--ip', '127.0.0.1'], {
    cwd: dir,
    // detached, so the whole group can be stopped: wrangler runs workerd as a child.
    detached: true,
    env: { PATH: process.env.PATH, HOME: process.env.HOME, WRANGLER_SEND_METRICS: 'false', NO_COLOR: '1' },
  })
  worker.stdout.on('data', chunk => (logs += chunk))
  worker.stderr.on('data', chunk => (logs += chunk))
  try {
    let up = false
    for (let i = 0; i < 120 && !up; i++) {
      up = await fetch(`${base}/api/health`).then(res => res.ok, () => false)
      if (!up) await new Promise(resolve => setTimeout(resolve, 500))
    }
    if (!up) throw new Error(`the worker never became healthy:\n${logs}`)
    await work(() => logs)
    // Its console output arrives through wrangler, a moment after the response.
    await new Promise(resolve => setTimeout(resolve, 500))
  }
  finally {
    try {
      process.kill(-worker.pid, 'SIGTERM')
    }
    catch { /* already gone */ }
    await new Promise(resolve => worker.once('exit', resolve))
  }
}

async function checkAllRefused(logs, missing) {
  for (const route of ROUTES) {
    const res = await ask(route)
    const text = await res.text()
    const named = /NUXT_|fake-value|groq|supabase|\br2\b|bucket/i.test(text)
    check(res.status === 503 && JSON.parse(text).message === REFUSED && !named, `${route[0]} ${route[1]} answers the one 503 (got ${res.status})`)
  }
  check(realCalls.length === 0, `nothing reached the database (${realCalls.length} requests)`)
  await new Promise(resolve => setTimeout(resolve, 500))
  const lines = logs().split('\n').filter(line => line.includes('refusing requests'))
  // Once per isolate, and a request can land on a fresh one, so not exactly once here.
  check(lines.length >= 1 && lines.length < ROUTES.length, `logged the refusal without one line per request (${lines.length})`)
  check(lines.every(line => line.includes('Cloudflare Worker')), 'says it was refused as a Worker')
  for (const name of missing) check(lines[0]?.includes(name), `names ${name}`)
  check(!logs().includes('fake-value'), 'logged no value')
  check(!/unenv|not implemented/.test(logs()), 'reached no local driver, which would fail on a missing fs')
}

console.log('\n# The opt-in, every stub flag and nothing else set')
await withWorker({ ...ALWAYS, ...OPT_IN_AND_FLAGS }, async (logs) => {
  await checkAllRefused(logs, Object.keys(EVERY_SETTING))
  check((await fetch(`${base}/api/health`)).status === 200, 'the health check still answers')
  // Not a JSON route, so its own plain answer. scripts/verify-worker-streams.mjs has the rest of it.
  const wasm = await fetch(`${base}/ffmpeg/ffmpeg-core.wasm`)
  check(wasm.status === 503 && await wasm.text() === REFUSED, `the ffmpeg wasm route answers the same sentence, in plain text (got ${wasm.status})`)
  check((await fetch(`${base}/`, { headers: { accept: 'text/html' } })).status === 200, 'the home page still renders')
  const page = await fetch(`${base}/meetings/${MEETING}`, { headers: { accept: 'text/html' } })
  const html = await page.text()
  check(page.status === 503 && html.replace(/<script[\s\S]*?<\/script>/g, '').includes('This page could not be loaded') && !/\.mjs|NUXT_GROQ/.test(html), `a meeting page shows a plain failure (got ${page.status})`)
})

console.log('\n# The opt-in, every stub flag, and every setting but Groq: the hazard itself')
await withWorker({ ...ALWAYS, ...OPT_IN_AND_FLAGS, ...EVERY_SETTING, NUXT_GROQ_API_KEY: '' }, async (logs) => {
  await checkAllRefused(logs, ['NUXT_GROQ_API_KEY'])
})

console.log('\n# Every setting, and no opt-in')
await withWorker({ ...ALWAYS, ...EVERY_SETTING }, async (logs) => {
  for (const path of [`/api/meetings/${MEETING}`, `/api/meetings/${MEETING}/pipeline`, `/api/meetings/${MEETING}/search-index`]) {
    const before = realCalls.length
    const res = await fetch(`${base}${path}`)
    check(res.status === 404 && realCalls.length > before, `GET ${path} reached the database (got ${res.status})`)
  }
  for (const route of ['transcribe', 'summarize', 'search-index', 'advance']) {
    const before = realCalls.length
    const res = await fetch(`${base}/api/meetings/${MEETING}/${route}`, { method: 'POST' })
    check(res.status === 404 && realCalls.length > before, `POST ${route} reached the database (got ${res.status})`)
  }
  check((await ask(ROUTES[0])).status === 204, 'the invite check accepts the code')
  check(!logs().includes('refusing requests'), 'refused nothing')
})

console.log('\n# A demo question, with a limit Nitro\'s env layer reads as nothing')
const now = new Date().toISOString()
answer = JSON.stringify([{
  id: MEETING, created_at: now, updated_at: now, title: 'Demo', status: 'ready', source_file_name: 'd.mp4',
  source_bytes: 1, source_mime: null, duration_sec: 10, audio_key: null, audio_bytes: null,
  audio_mime: null, uploaded_at: now, error_message: null, failed_stage: null,
}])
const askDemo = ROUTES.find(([, path]) => path.endsWith('/ask'))
const WARNED = 'NUXT_DEMO_QUESTIONS_PER_DAY is not a positive whole number'
for (const written of ['null', 'undefined', ' NULL ', 'abc']) {
  await withWorker({ ...ALWAYS, ...EVERY_SETTING, NUXT_PUBLIC_DEMO_MEETING_ID: MEETING, NUXT_DEMO_QUESTIONS_PER_DAY: `"${written}"` }, async (logs) => {
    const res = await ask(askDemo)
    const { message } = await res.json()
    check(res.status === 429 && message === 'The demo has used its questions for today.', `${written}: refused as over the count (got ${res.status}: ${message})`)
    check(!realCalls.some(call => call.includes('/rpc/')), `${written}: called no function, at any limit (${realCalls.join(', ')})`)
    for (let i = 0; i < 20 && !logs().includes(WARNED); i++) await new Promise(resolve => setTimeout(resolve, 100))
    check(logs().includes(WARNED), `${written}: logged the setting by name`)
  })
}
// The same request with a real limit, so the refusals above are the setting's and nothing else's.
await withWorker({ ...ALWAYS, ...EVERY_SETTING, NUXT_PUBLIC_DEMO_MEETING_ID: MEETING, NUXT_DEMO_QUESTIONS_PER_DAY: '5' }, async (logs) => {
  await (await ask(askDemo)).body?.cancel()
  check(realCalls.some(call => call.includes('/rpc/demo_question_gate')), `5: asks the gate (${realCalls.join(', ')})`)
  check(!logs().includes(WARNED), '5: logs nothing about the setting')
})

fakeSupabase.close()
await rm(dir, { recursive: true, force: true })
console.log(process.exitCode ? '\nFAILED' : '\nPASSED')
