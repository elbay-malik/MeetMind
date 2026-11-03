// Runs the cron sweeper under the real workerd runtime, through `wrangler dev`, on this machine,
// by asking wrangler for scheduled events: a meeting with no tab open goes from uploaded to ready.
// Nothing here is deployed and no real service is called. The database is real SQL on a throwaway
// Postgres with PostgREST in front (scripts/lib/throwaway-postgrest.mjs). R2, Groq and Workers AI
// are fakes in this process, which see and count every request the Worker sends.
//
// Usage (needs Docker):
//   NITRO_PRESET=cloudflare_module pnpm build
//   node scripts/verify-worker-sweep.mjs
//   pnpm build    # puts the Node build back: the e2e and browser jobs need it
//
// Not part of `pnpm ci:local`, because it needs a build of its own. It proves everything short of
// the acceptance in ADR-0012's step 11, a meeting reaching `ready` on the deployed Worker, which
// waits for Phase 13. A real cron, real CPU limits and real providers are all out of its reach.
//
// Runs from a temporary copy, so wrangler cannot find this repo's .env, and with almost nothing
// in the environment, so it cannot find a token either. The copy's entry wraps the build's own,
// sending what would go to a provider's host to the fakes here: that is `fetch` on those hosts
// and nothing else, so the build runs as it is. Local wrangler runs no cron by itself, so each
// tick is /cdn-cgi/local/scheduled, which a deployed Worker does not have.
import { spawn } from 'node:child_process'
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startThrowawayPostgrest } from './lib/throwaway-postgrest.mjs'

const rootDir = fileURLToPath(new URL('..', import.meta.url))
const wrangler = join(rootDir, 'node_modules/.bin/wrangler')
const PORT = 8801

/** What a tick may spend, in `tests/unit/sweep.spec.ts`, which adds it up by name. */
const WORST_CASE_SUBREQUESTS = 23
const SECRET_BODY = 'SECRET-PROVIDER-BODY'
const FAKE_VALUE = 'fake-value'

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

// ---------------------------------------------------------------- the world outside the Worker

/** Every request the Worker sent outside itself, in order. */
const sent = []
const objects = new Map()
const script = {
  /** What Whisper answers with: nothing means a good reply, otherwise a status and a body. */
  whisper: null,
  /** Answer for the embedding service. */
  embed: null,
  /** Held until this resolves, to keep a Whisper step out at the provider. */
  holdWhisper: null,
}
let pgUrl = ''

const LINES = Array.from({ length: 6 }, (_, i) => `Line ${i} of the meeting, where it was agreed that something ${i} would happen by Friday.`)
const WHISPER_REPLY = JSON.stringify({
  task: 'transcribe',
  language: 'english',
  duration: LINES.length * 2,
  text: LINES.join(' '),
  segments: LINES.map((text, i) => ({ id: i, seek: i * 100, start: i * 2, end: i * 2 + 1.5, text: ` ${text}`, tokens: [1, 2], temperature: 0 })),
})
const VECTOR = Array.from({ length: 1024 }, (_, i) => (i === 0 ? 1 : 0))

const ETAG = bytes => `"${bytes.length}-${bytes.subarray(0, 8).toString('hex')}"`

function answerR2(req, res, body, key) {
  const stored = objects.get(key)
  if (req.method === 'PUT') {
    objects.set(key, body)
    res.setHeader('etag', ETAG(body))
    res.end()
    return
  }
  if (req.method === 'DELETE') {
    objects.delete(key)
    res.statusCode = 204
    res.end()
    return
  }
  if (!stored) {
    res.statusCode = 404
    res.end()
    return
  }
  res.setHeader('etag', ETAG(stored))
  res.setHeader('content-type', 'application/octet-stream')
  const range = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range ?? '')
  if (range) {
    const start = Number(range[1])
    const end = Math.min(Number(range[2]), stored.length - 1)
    if (start >= stored.length) {
      res.statusCode = 416
      res.setHeader('content-range', `bytes */${stored.length}`)
      res.end()
      return
    }
    res.statusCode = 206
    res.setHeader('content-range', `bytes ${start}-${end}/${stored.length}`)
    res.end(stored.subarray(start, end + 1))
    return
  }
  res.setHeader('content-length', stored.length)
  res.end(req.method === 'HEAD' ? undefined : stored)
}

const outside = createServer(async (req, res) => {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  const body = Buffer.concat(chunks)
  const url = req.url
  sent.push({ method: req.method, url, body: body.length < 2000 ? body.toString() : '' })

  if (url.startsWith('/db/')) {
    const headers = new Headers()
    for (const [name, value] of Object.entries(req.headers)) {
      if (typeof value === 'string' && !['host', 'content-length', 'connection'].includes(name)) headers.set(name, value)
    }
    const answer = await fetch(`${pgUrl}${url.replace(/^\/db\/rest\/v1/, '')}`, { method: req.method, headers, body: body.length ? body : undefined })
    res.statusCode = answer.status
    answer.headers.forEach((value, name) => {
      if (!['content-encoding', 'transfer-encoding', 'content-length'].includes(name)) res.setHeader(name, value)
    })
    res.end(Buffer.from(await answer.arrayBuffer()))
    return
  }
  if (url.startsWith('/r2/')) {
    answerR2(req, res, body, decodeURIComponent(url.replace(/^\/r2\/[^/]+\//, '').split('?')[0]))
    return
  }
  res.setHeader('content-type', 'application/json')
  if (url.startsWith('/groq/openai/v1/audio/')) {
    await script.holdWhisper
    if (script.whisper) {
      res.statusCode = script.whisper.status
      res.end(script.whisper.body)
      return
    }
    res.end(WHISPER_REPLY)
    return
  }
  if (url.startsWith('/groq/openai/v1/chat/')) {
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ summary: 'They agreed on Friday.', decisions: [], actionItems: [] }) } }] }))
    return
  }
  if (url.startsWith('/ai/')) {
    if (script.embed) {
      res.statusCode = script.embed.status
      res.end(script.embed.body)
      return
    }
    const { text } = JSON.parse(body.toString())
    res.end(JSON.stringify({ success: true, result: { data: text.map(() => VECTOR), shape: [text.length, 1024] } }))
    return
  }
  res.statusCode = 500
  res.end('{"error":"nothing here"}')
})
await new Promise(resolve => outside.listen(0, '127.0.0.1', resolve))
const outsidePort = outside.address().port

const pg = await startThrowawayPostgrest({ name: 'meetmind-worker-sweep', port: 55437 })
pgUrl = pg.url

// ---------------------------------------------------------------- the Worker

const dir = await mkdtemp(join(tmpdir(), 'meetmind-worker-sweep-'))
await cp(join(rootDir, '.output/server'), join(dir, 'server'), { recursive: true })
await cp(join(rootDir, '.output/public'), join(dir, 'public'), { recursive: true, filter: source => !source.includes('/public/ffmpeg') })
await writeFile(join(dir, 'entry.mjs'), `
import built from './server/index.mjs'
const realFetch = globalThis.fetch
const routes = [
  [/^api\\.groq\\.com$/, '/groq'],
  [/^api\\.cloudflare\\.com$/, '/ai'],
  [/\\.r2\\.cloudflarestorage\\.com$/, '/r2'],
]
globalThis.fetch = (input, init) => {
  const request = new Request(input, init)
  const url = new URL(request.url)
  const route = routes.find(([host]) => host.test(url.hostname))
  if (!route) return realFetch(request)
  return realFetch(new Request('http://127.0.0.1:${outsidePort}' + route[1] + url.pathname + url.search, request))
}
export default built
`)
// The real one's compatibility settings and its cron, since wrangler reading the cron is part of what is checked.
const config = (await readFile(join(rootDir, 'wrangler.jsonc'), 'utf8'))
  .split('\n').filter(line => !line.trim().startsWith('//')).join('\n')
const { compatibility_date, compatibility_flags, triggers } = JSON.parse(config)
check(JSON.stringify(triggers?.crons) === '["*/5 * * * *"]', `wrangler.jsonc asks for one cron, every 5 minutes (${JSON.stringify(triggers?.crons)})`)
await writeFile(join(dir, 'wrangler.json'), JSON.stringify({
  name: 'meetmind-sweep-check',
  main: 'entry.mjs',
  compatibility_date,
  compatibility_flags,
  triggers,
  assets: { directory: 'public', binding: 'ASSETS' },
}))

const DB_URL = `http://127.0.0.1:${outsidePort}/db`
const EVERY_SETTING = {
  NUXT_GROQ_API_KEY: `${FAKE_VALUE}-groq`,
  NUXT_WORKERS_AI_ACCOUNT_ID: `${FAKE_VALUE}-account`,
  NUXT_WORKERS_AI_API_TOKEN: `${FAKE_VALUE}-token`,
  NUXT_SUPABASE_URL: DB_URL,
  NUXT_SUPABASE_SERVICE_KEY: pg.serviceKey,
  NUXT_R2_ACCOUNT_ID: `${FAKE_VALUE}-r2-account`,
  NUXT_R2_ACCESS_KEY_ID: `${FAKE_VALUE}-r2-key`,
  NUXT_R2_SECRET_ACCESS_KEY: `${FAKE_VALUE}-r2-secret`,
  NUXT_R2_BUCKET: 'bucket',
  // The slots still go through the ledger. A tick here is not 5 minutes after the last.
  NUXT_GROQ_CHAT_INTERVAL_MS: '0',
  NUXT_EMBED_INTERVAL_MS: '0',
}

const base = `http://127.0.0.1:${PORT}`

/** One `wrangler dev` with these settings, for as long as `work` runs. Hands `work` what has been logged. */
async function withWorker(vars, work) {
  await writeFile(join(dir, '.dev.vars'), Object.entries(vars).map(([key, value]) => `${key}=${value}`).join('\n'))
  sent.length = 0
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

const ANSI_COLOURS = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g')

/** What the tick itself logged, without what wrangler dresses a warning in. */
const sweepLines = logs => logs().replace(ANSI_COLOURS, '').split('\n').filter(line => line.includes('[meetmind] sweep'))

/** One scheduled event, waited out: what wrangler says of it, and what it sent. */
async function tick() {
  const before = sent.length
  const res = await fetch(`${base}/cdn-cgi/local/scheduled?format=json&cron=${encodeURIComponent('*/5 * * * *')}`)
  const answer = await res.json()
  const spent = sent.slice(before)
  return {
    answer,
    spent,
    claims: spent.filter(r => r.url.includes('/rpc/claim_step')).length,
    providers: spent.filter(r => r.url.startsWith('/groq/') || r.url.startsWith('/ai/')).length,
  }
}

/** A row as `POST /api/meetings` and `complete` leave one, with its audio in the fake bucket. */
async function uploaded(id, status = 'uploaded', extra = '') {
  await pg.sql(`insert into public.meetings (id,title,status,source_file_name,source_bytes,audio_key,audio_bytes,uploaded_at${extra ? ',failed_stage,error_message' : ''})
    values ('${id}','Sweep','${status}','a.mp4',1,'meetings/${id}/audio.ogg',4096,now()${extra});`)
  objects.set(`meetings/${id}/audio.ogg`, Buffer.alloc(4096, 7))
}
/** A finished meeting with something in every store, created that many days ago. */
async function fullMeeting(id, daysOld) {
  await uploaded(id, 'ready')
  objects.set(`meetings/${id}/whisper-reply.json`, Buffer.from('{}'))
  const vector = `array_fill(0.1::real, array[1024])::extensions.vector`
  await pg.sql(`
    update public.meetings set created_at = now() - make_interval(days => ${daysOld}) where id = '${id}';
    insert into public.transcript_segments (meeting_id, idx, start_ms, end_ms, text) values ('${id}', 0, 0, 1000, 'hello');
    insert into public.meeting_summaries (meeting_id, summary, provider) values ('${id}', 'They agreed.', 'groq');
    insert into public.transcript_windows (meeting_id, idx, first_segment_idx, last_segment_idx, start_ms, end_ms, content, content_hash, model, embedding)
      values ('${id}', 0, 0, 0, 0, 1000, 'hello', '${'a'.repeat(64)}', '@cf/baai/bge-m3', ${vector});
    insert into public.meeting_index_state (meeting_id, text_hash, model, window_count, complete)
      values ('${id}', public.transcript_hash('${id}'), '@cf/baai/bge-m3', 1, true);`)
}
/** How many rows of it each table holds, in one line. */
const rowsOf = async id => (await pg.sql(`select 'meeting ' || (select count(*) from public.meetings where id = '${id}')
  || ', lines ' || (select count(*) from public.transcript_segments where meeting_id = '${id}')
  || ', summary ' || (select count(*) from public.meeting_summaries where meeting_id = '${id}')
  || ', marker ' || (select count(*) from public.meeting_index_state where meeting_id = '${id}')
  || ', windows ' || (select count(*) from public.transcript_windows where meeting_id = '${id}');`)).trim()
const statusOf = async id => (await pg.sql(`select status from public.meetings where id = '${id}';`)).trim()
const indexOf = async id => (await pg.sql(`select coalesce((select complete from public.meeting_index_state where meeting_id = '${id}'), false);`)).trim()
const clearAll = () => pg.sql(`delete from public.meetings; delete from public.provider_slots;
  update public.sweep_state set last_created_at = null, last_meeting_id = null;`)

const ONE = '00000000-0000-4000-8000-000000000001'
const TWO = '00000000-0000-4000-8000-000000000002'
const DEMO = '00000000-0000-4000-8000-00000000000d'
const FAILS = '00000000-0000-4000-8000-00000000000f'
const EXPIRED = '00000000-0000-4000-8000-00000000000e'

try {
  console.log('\n# No settings at all, with the opt-in and every stub flag')
  await withWorker({ NUXT_ALLOW_LOCAL_DRIVERS: 'true', NUXT_SUMMARY_STUB_CANARY: 'true', NUXT_TRANSCRIBE_STUB_QUOTA_FAIL: 'true' }, async (logs) => {
    const { answer, spent } = await tick()
    check(answer.outcome === 'ok', `a scheduled event that is refused ends well, not as an exception (${answer.outcome})`)
    check(answer.noRetry === true, 'it asks for no retry')
    check(spent.length === 0, `it reached nothing (${spent.length} requests)`)
    await new Promise(resolve => setTimeout(resolve, 500))
    const lines = logs().split('\n').filter(line => line.includes('refusing requests'))
    check(lines.length === 1 && lines[0].includes('Cloudflare Worker'), `it logged the refusal once, as a Worker's (${lines.length})`)
    check(lines[0]?.includes('NUXT_SUPABASE_URL') && lines[0]?.includes('NUXT_GROQ_API_KEY'), 'and named what is missing')
    check(sweepLines(logs).length === 0, 'and added no line of its own')
    check(!/unenv|not implemented/.test(logs()), 'it reached no local driver, which would fail on a missing fs')
  })

  console.log('\n# Every setting but Groq, with the opt-in')
  await withWorker({ ...EVERY_SETTING, NUXT_ALLOW_LOCAL_DRIVERS: 'true', NUXT_GROQ_API_KEY: '' }, async (logs) => {
    const { answer, spent } = await tick()
    check(answer.outcome === 'ok' && spent.length === 0, `the hazard itself reaches nothing either (${spent.length} requests)`)
    await new Promise(resolve => setTimeout(resolve, 500))
    check(logs().includes('Missing: NUXT_GROQ_API_KEY'), 'and says which')
    check(!logs().includes(FAKE_VALUE), 'logged no value')
  })

  console.log('\n# Every setting, with nothing to do')
  await clearAll()
  await pg.sql(`update public.sweep_state set last_tick_at = now() - interval '1 day';`)
  await withWorker(EVERY_SETTING, async (logs) => {
    for (let i = 0; i < 3; i++) {
      const { answer, spent } = await tick()
      check(answer.outcome === 'ok' && answer.noRetry === true, 'a tick ends well, asking for no retry')
      check(spent.length === 1 && spent[0].method === 'POST' && spent[0].url === '/db/rest/v1/rpc/sweep_next_meeting', `one request, the database's: ${spent.map(r => `${r.method} ${r.url}`).join(', ')}`)
    }
    const moved = (await pg.sql(`select last_tick_at > now() - interval '1 minute' from public.sweep_state;`)).trim()
    check(moved === 't', 'a tick with nothing to do wrote to Postgres, which is the keep-alive')
    await new Promise(resolve => setTimeout(resolve, 500))
    check(sweepLines(logs).length === 0, 'and logged nothing, as there are 288 of those a day')
    check(!/\berror\b/i.test(logs().split('Ready on')[1] ?? ''), 'and no error')

    console.log('\n# No route starts a tick')
    sent.length = 0
    await pg.sql(`update public.sweep_state set last_tick_at = now() - interval '1 day';`)
    const paths = ['/__scheduled', '/__scheduled?cron=*/5+*+*+*+*', '/api/sweep', '/api/sweeper', '/sweep', '/_nitro/tasks', '/_nitro/tasks/sweep', '/api/cron', '/api/_scheduled']
    for (const path of paths) {
      for (const method of ['GET', 'POST']) {
        const res = await fetch(`${base}${path}`, { method })
        check(res.status === 404 || res.status === 405, `${method} ${path} answers ${res.status}`)
      }
    }
    check(!sent.some(r => r.url.includes('sweep')), `none of them reached the sweep's function (${sent.length} requests to anything)`)
    const untouched = (await pg.sql(`select last_tick_at < now() - interval '1 hour' from public.sweep_state;`)).trim()
    check(untouched === 't', 'and none of them counted as a tick')
  })

  console.log('\n# A meeting with no tab open, from uploaded to ready')
  await clearAll()
  await uploaded(ONE)
  await uploaded(TWO)
  await uploaded(DEMO)
  await withWorker({ ...EVERY_SETTING, NUXT_PUBLIC_DEMO_MEETING_ID: DEMO }, async (logs) => {
    const page = await (await fetch(`${base}/meetings/${ONE}`, { headers: { accept: 'text/html' } })).text()
    check(page.includes('at most one step every 5 minutes'), 'the meeting\'s page says what happens with it closed, on a Worker')

    let ticks = 0
    let most = 0
    let steps = 0
    let last = null
    for (; ticks < 80; ticks++) {
      last = await tick()
      most = Math.max(most, last.spent.length)
      if (last.answer.outcome !== 'ok' || last.claims > 1 || last.providers > 1 || last.spent.length > WORST_CASE_SUBREQUESTS) {
        fail(`tick ${ticks}: ${JSON.stringify({ outcome: last.answer.outcome, claims: last.claims, providers: last.providers, spent: last.spent.length })}`)
      }
      if (last.spent.length === 1) break
      if (last.claims === 1) steps++
    }
    check(last.spent.length === 1, `it ended on a tick with nothing to do, after ${ticks} ticks`)
    for (const id of [ONE, TWO]) {
      check(await statusOf(id) === 'ready', `${id} reached ready`)
      check(await indexOf(id) === 't', `and its index is complete`)
    }
    check(!objects.has(`meetings/${ONE}/whisper-reply.json`), 'the raw reply is gone from the bucket')
    check((await pg.sql(`select count(*) from public.transcript_segments where meeting_id = '${ONE}';`)).trim() === String(LINES.length), 'its transcript is stored')
    check((await pg.sql(`select count(*) from public.meeting_summaries where meeting_id = '${ONE}';`)).trim() === '1', 'its summary is stored')
    console.log(`  (${steps} steps in ${ticks} ticks over two meetings, at most ${most} subrequests in one tick, against ${WORST_CASE_SUBREQUESTS} worked out and 50 allowed)`)

    check(await statusOf(DEMO) === 'uploaded', 'the public demo was not moved')
    check(!sent.some(r => r.url.includes(DEMO) && !r.url.includes('sweep_next_meeting')), 'nor read')

    const whisper = sent.filter(r => r.url.startsWith('/groq/openai/v1/audio/')).length
    check(whisper === 2, `Whisper was asked once per meeting (${whisper})`)

    await new Promise(resolve => setTimeout(resolve, 500))
    const lines = sweepLines(logs)
    check(lines.length === steps, `one line per step and none for the rest (${lines.length} lines, ${steps} steps)`)
    check(lines.every(line => /\[meetmind\] sweep: (transcription|extraction|indexing) step, \w+/.test(line)), 'naming the kind of step and nothing else')
    check(!logs().includes(FAKE_VALUE) && !logs().includes('Line 0 of the meeting'), 'no value and no transcript text')
  })

  console.log('\n# With nobody watching: a provider that keeps failing')
  await clearAll()
  await uploaded(FAILS)
  script.whisper = { status: 500, body: JSON.stringify({ error: SECRET_BODY }) }
  await withWorker(EVERY_SETTING, async (logs) => {
    for (let i = 0; i < 10; i++) {
      await tick()
      await new Promise(resolve => setTimeout(resolve, 5_100 / 10))
      if (i === 0) await pg.sql(`update public.pipeline_runs set retry_at = null where meeting_id = '${FAILS}';`)
    }
    const whisper = sent.filter(r => r.url.startsWith('/groq/openai/v1/audio/')).length
    check(whisper === 2, `Whisper was asked twice at most (${whisper})`)
    check(await statusOf(FAILS) === 'failed', 'and the meeting has failed')
    await pg.sql(`alter table public.meetings disable trigger meetings_set_updated_at;
      update public.meetings set updated_at = now() - interval '1 day' where id = '${FAILS}';
      alter table public.meetings enable trigger meetings_set_updated_at;`)
    const { providers, claims } = await tick()
    check(providers === 0 && claims === 0, 'and long past its cooldown it is not retried: that takes a click')
    await new Promise(resolve => setTimeout(resolve, 500))
    check(!logs().includes(SECRET_BODY), 'no provider body in the log')
  })
  script.whisper = null

  console.log('\n# With nobody watching: the daily limit')
  await clearAll()
  await uploaded(ONE, 'ready')
  await pg.sql(`insert into public.transcript_segments (meeting_id, idx, start_ms, end_ms, text) values ('${ONE}', 0, 0, 1000, 'hello');`)
  script.embed = { status: 429, body: JSON.stringify({ success: false, errors: [{ code: 3036, message: SECRET_BODY }] }) }
  await withWorker(EVERY_SETTING, async (logs) => {
    const first = await tick()
    check(first.providers === 1, `the first tick asks, and is refused (${first.providers})`)
    const blocked = (await pg.sql(`select blocked_until > now() from public.provider_slots where provider = 'workers-ai-embed';`)).trim()
    check(blocked === 't', 'the account is blocked until it resets')
    for (let i = 0; i < 3; i++) {
      const { providers, claims, spent } = await tick()
      check(providers === 0 && claims === 0 && spent.length === 1, 'the next ticks ask nothing, and claim nothing')
    }
    await new Promise(resolve => setTimeout(resolve, 500))
    check(!logs().includes(SECRET_BODY), 'no provider body in the log')
  })
  script.embed = null

  console.log('\n# A tab and a tick on one step')
  await clearAll()
  await uploaded(ONE)
  let release
  script.holdWhisper = new Promise((resolve) => {
    release = resolve
  })
  await withWorker(EVERY_SETTING, async () => {
    const out = tick()
    for (let i = 0; i < 100 && !sent.some(r => r.url.startsWith('/groq/openai/v1/audio/')); i++) await new Promise(resolve => setTimeout(resolve, 50))
    check(sent.some(r => r.url.startsWith('/groq/openai/v1/audio/')), 'the tick\'s step is out at the provider')
    const res = await fetch(`${base}/api/meetings/${ONE}/advance`, { method: 'POST' })
    const told = await res.json()
    check(res.status === 200 && told.next === 'wait', `a tab asking meanwhile is told to wait (${res.status} ${told.next})`)
    const deleted = await fetch(`${base}/api/meetings/${ONE}/pipeline`)
    check(deleted.status === 200, 'and can read how it stands')
    const other = await tick()
    check(other.providers === 0 && other.answer.outcome === 'ok', 'a second tick meanwhile finds nothing to do')
    release()
    const { providers, answer } = await out
    check(answer.outcome === 'ok' && providers >= 1, 'the first tick ends well')
    const whisper = sent.filter(r => r.url.startsWith('/groq/openai/v1/audio/')).length
    check(whisper === 1, `Whisper was asked once (${whisper})`)
  })
  script.holdWhisper = null

  console.log('\n# The retention purge, off as it is by default')
  await clearAll()
  await fullMeeting(EXPIRED, 400)
  await pg.sql(`update public.sweep_state set last_created_at = null, last_meeting_id = null;`)
  await withWorker({ ...EVERY_SETTING, NUXT_PUBLIC_DEMO_MEETING_ID: DEMO }, async () => {
    for (let i = 0; i < 3; i++) await tick()
    check(await rowsOf(EXPIRED) === 'meeting 1, lines 1, summary 1, marker 1, windows 1', 'nothing is deleted, however old')
    check(objects.has(`meetings/${EXPIRED}/audio.ogg`), 'and neither is its audio')
    const home = await (await fetch(`${base}/`, { headers: { accept: 'text/html' } })).text()
    check(home.includes('you cannot delete it yourself') && !home.includes('deleted about'), 'and the upload page promises no deletion')
  })

  console.log('\n# The retention purge, on')
  await clearAll()
  const STALE = '00000000-0000-4000-8000-0000000000c1'
  const YOUNG = '00000000-0000-4000-8000-0000000000c2'
  const LEASED = '00000000-0000-4000-8000-0000000000c3'
  await fullMeeting(EXPIRED, 90)
  await fullMeeting(STALE, 60)
  await fullMeeting(YOUNG, 10)
  await fullMeeting(LEASED, 300)
  await fullMeeting(DEMO, 400)
  await pg.sql(`insert into public.pipeline_runs (meeting_id, stage, step_token, step_lease_until)
    values ('${LEASED}', 'summarization', gen_random_uuid(), now() + interval '1 hour');`)
  await withWorker({ ...EVERY_SETTING, NUXT_PUBLIC_DEMO_MEETING_ID: DEMO, NUXT_RETENTION_PURGE_DAYS: '30' }, async (logs) => {
    const home = await (await fetch(`${base}/`, { headers: { accept: 'text/html' } })).text()
    check(home.includes('deleted about 30 days after upload'), 'the upload page says the true number of days')
    const list = await (await fetch(`${base}/meetings`, { headers: { accept: 'text/html' } })).text()
    check(list.includes('deployment-facts') && list.includes('purgeDays'), 'and a visit that lands on another page has it for the next one')

    const first = await tick()
    check(first.answer.outcome === 'ok' && first.claims === 0 && first.providers === 0, 'a tick deletes with no claim and no provider')
    check(first.spent.length <= 22, `within what the spec adds up (${first.spent.length} subrequests)`)
    check(await rowsOf(EXPIRED) === 'meeting 0, lines 0, summary 0, marker 0, windows 0', 'the oldest expired meeting has no row left anywhere')
    check(!objects.has(`meetings/${EXPIRED}/audio.ogg`) && !objects.has(`meetings/${EXPIRED}/whisper-reply.json`), 'and no object')
    check(await rowsOf(STALE) === 'meeting 1, lines 1, summary 1, marker 1, windows 1' && objects.has(`meetings/${STALE}/audio.ogg`), 'one a tick: the next expired one is untouched')

    await tick()
    check(await rowsOf(STALE) === 'meeting 0, lines 0, summary 0, marker 0, windows 0' && !objects.has(`meetings/${STALE}/audio.ogg`), 'the next tick takes it')

    for (let i = 0; i < 3; i++) await tick()
    check(await rowsOf(YOUNG) === 'meeting 1, lines 1, summary 1, marker 1, windows 1' && objects.has(`meetings/${YOUNG}/audio.ogg`), 'a meeting inside its days stays')
    check(await rowsOf(DEMO) === 'meeting 1, lines 1, summary 1, marker 1, windows 1' && objects.has(`meetings/${DEMO}/audio.ogg`), 'the public demo stays, 400 days old')
    check(await rowsOf(LEASED) === 'meeting 1, lines 1, summary 1, marker 1, windows 1' && objects.has(`meetings/${LEASED}/audio.ogg`), 'a meeting a step is live on stays')

    await pg.sql(`update public.pipeline_runs set step_token = null, step_lease_until = null where meeting_id = '${LEASED}';`)
    await tick()
    check(await rowsOf(LEASED) === 'meeting 0, lines 0, summary 0, marker 0, windows 0', 'and goes once its step is over')
    await new Promise(resolve => setTimeout(resolve, 500))
    const lines = sweepLines(logs).filter(line => line.includes('deleted one meeting'))
    check(lines.length === 3, `one line for each one deleted (${lines.length})`)
    check(![EXPIRED, STALE, LEASED].some(id => logs().includes(id)), 'and no id in the log, since an id is the way in')
  })

  console.log('\n# The retention purge, set wrongly')
  await clearAll()
  await fullMeeting(EXPIRED, 400)
  for (const [name, vars, says] of [
    ['not a whole number', { NUXT_RETENTION_PURGE_DAYS: 'thirty', NUXT_PUBLIC_DEMO_MEETING_ID: DEMO }, 'NUXT_RETENTION_PURGE_DAYS is not a positive whole number'],
    ['a fraction', { NUXT_RETENTION_PURGE_DAYS: '30.5', NUXT_PUBLIC_DEMO_MEETING_ID: DEMO }, 'NUXT_RETENTION_PURGE_DAYS is not a positive whole number'],
    ['with no demo to leave out', { NUXT_RETENTION_PURGE_DAYS: '30' }, 'NUXT_PUBLIC_DEMO_MEETING_ID is not a meeting id'],
    ['with a mistyped demo', { NUXT_RETENTION_PURGE_DAYS: '30', NUXT_PUBLIC_DEMO_MEETING_ID: '00000000-0000-4000-8000-000000000bad' }, 'NUXT_PUBLIC_DEMO_MEETING_ID names no meeting'],
  ]) {
    await withWorker({ ...EVERY_SETTING, ...vars }, async (logs) => {
      for (let i = 0; i < 3; i++) await tick()
      check(await rowsOf(EXPIRED) === 'meeting 1, lines 1, summary 1, marker 1, windows 1', `${name}: nothing is deleted`)
      const home = await (await fetch(`${base}/`, { headers: { accept: 'text/html' } })).text()
      // A mistyped id looks like any other from the page, and its demo link opens a 404: ADR-0017.
      if (name !== 'with a mistyped demo') check(!home.includes('deleted about'), `${name}: and the upload page promises none`)
      await new Promise(resolve => setTimeout(resolve, 500))
      const lines = sweepLines(logs).filter(line => line.includes(says))
      check(lines.length >= 1 && lines.length <= 3, `${name}: and it says why, without the value (${lines.length} lines in 3 ticks)`)
      check(!sweepLines(logs).some(line => line.includes('thirty') || line.includes('30.5')), `${name}: no value`)
    })
  }

  console.log('\n# The database out')
  await withWorker({ ...EVERY_SETTING, NUXT_SUPABASE_URL: 'http://127.0.0.1:9' }, async (logs) => {
    const { answer } = await tick()
    check(answer.outcome === 'ok' && answer.noRetry === true, `a tick that cannot reach it ends well, asking for no retry (${answer.outcome})`)
    await new Promise(resolve => setTimeout(resolve, 500))
    const lines = sweepLines(logs)
    check(lines.length === 1 && /\[meetmind\] sweep failed: \w+$/.test(lines[0]?.trim()), `one line, with the kind of error and nothing else: ${lines[0]}`)
    check(!logs().includes(FAKE_VALUE) && !logs().includes(pg.serviceKey), 'no value')
  })
}
finally {
  outside.close()
  await pg.stop()
  await rm(dir, { recursive: true, force: true })
}
console.log(process.exitCode ? '\nFAILED' : '\nPASSED')
