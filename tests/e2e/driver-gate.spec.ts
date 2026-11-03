import { createServer } from 'node:http'
import { mkdtemp, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { fetch, getServerLogs, setup, startServer } from '@nuxt/test-utils/e2e'
import { INVITE_CODE, inviteHeaders } from './helpers/invite'
import { LOCAL_DRIVERS, REAL_SETTINGS_ABSENT } from './helpers/local-drivers'

const rootDir = fileURLToPath(new URL('../..', import.meta.url))
const dataDir = await mkdtemp(join(tmpdir(), 'meetmind-driver-gate-'))

const ADMIN_TOKEN = 'e2e-admin-token-0123456789abcdefghijkl'
const MEETING = '00000000-0000-4000-8000-000000000001'
const REFUSED = 'MeetMind is not available at the moment. Try again later.'
const STUB_FLAGS = {
  NUXT_SUMMARY_STUB_CANARY: 'true',
  NUXT_TRANSCRIBE_STUB_QUOTA_FAIL: 'true',
  NUXT_SUMMARY_STUB_FAIL_ONCE_RETRYABLE: 'true',
  NUXT_ANSWER_STUB_PACED: 'true',
  NUXT_EMBED_STUB_QUOTA_CANARY: 'canary',
}

// Really absent, not just empty, even when the shell running the tests has one.
delete process.env.NUXT_ALLOW_LOCAL_DRIVERS

/**
 * A fake of the real database, which is how "nothing was touched" gets its proof: a refusal
 * leaves this at zero requests, and a real selection is seen arriving here. It answers every
 * read with no rows, so a route that gets this far finds no meeting and stops.
 */
const realCalls: string[] = []
const fakeSupabase = createServer((req, res) => {
  realCalls.push(`${req.method} ${req.url}`)
  req.resume()
  res.setHeader('content-type', 'application/json')
  res.end('[]')
})
await new Promise<void>(resolve => fakeSupabase.listen(0, '127.0.0.1', () => resolve()))
const fakeAddress = fakeSupabase.address() as { port: number }
afterAll(() => {
  fakeSupabase.close()
})

/** Recognisable, to be looked for in everything the server says. No request ever carries one further than the fake. */
const EVERY_SETTING = {
  NUXT_GROQ_API_KEY: 'fake-value-groq',
  NUXT_WORKERS_AI_ACCOUNT_ID: 'fake-value-account',
  NUXT_WORKERS_AI_API_TOKEN: 'fake-value-token',
  NUXT_SUPABASE_URL: `http://127.0.0.1:${fakeAddress.port}`,
  NUXT_SUPABASE_SERVICE_KEY: 'fake-value-service',
  NUXT_R2_ACCOUNT_ID: 'fake-value-r2-account',
  NUXT_R2_ACCESS_KEY_ID: 'fake-value-r2-key',
  NUXT_R2_SECRET_ACCESS_KEY: 'fake-value-r2-secret',
  NUXT_R2_BUCKET: 'fake-value-bucket',
}
const SETTING_NAMES = Object.keys(EVERY_SETTING)

const blank = (...names: string[]) => Object.fromEntries(names.map(name => [name, '']))
const GROQ = ['NUXT_GROQ_API_KEY']
const WORKERS_AI = ['NUXT_WORKERS_AI_ACCOUNT_ID', 'NUXT_WORKERS_AI_API_TOKEN']
const SUPABASE = ['NUXT_SUPABASE_URL', 'NUXT_SUPABASE_SERVICE_KEY']
const R2 = ['NUXT_R2_ACCOUNT_ID', 'NUXT_R2_ACCESS_KEY_ID', 'NUXT_R2_SECRET_ACCESS_KEY', 'NUXT_R2_BUCKET']

/**
 * This spec's own server is a production build with no opt-in, as a deployment is. Every
 * other spec asks for local drivers, and shows that the opt-in works by working.
 */
await setup({
  rootDir,
  build: false,
  nuxtConfig: { nitro: { output: { dir: join(rootDir, '.output') } } },
  env: {
    ...REAL_SETTINGS_ABSENT,
    NUXT_DATA_DIR: dataDir,
    NUXT_UPLOAD_TOKEN_SECRET: 'e2e-secret',
    NUXT_INVITE_CODE: INVITE_CODE,
    NUXT_ADMIN_TOKEN: ADMIN_TOKEN,
  },
})

const json = { 'content-type': 'application/json' }
const meetingBody = JSON.stringify({ title: 'Gate test', sourceFileName: 'gate.mp4', sourceBytes: 1_000_000, sourceMime: 'video/mp4', durationSec: 30, audioBytes: 4096 })

/** Every route that reaches a provider or store, walked against the directory below. */
const ROUTES: { route: string, path: string, method: string, headers?: Record<string, string>, body?: string }[] = [
  { route: 'POST /api/invite-check', path: '/api/invite-check', method: 'POST', headers: inviteHeaders },
  { route: 'POST /api/meetings', path: '/api/meetings', method: 'POST', headers: { ...inviteHeaders, ...json }, body: meetingBody },
  { route: 'GET /api/meetings/:id', path: `/api/meetings/${MEETING}`, method: 'GET' },
  { route: 'DELETE /api/meetings/:id', path: `/api/meetings/${MEETING}`, method: 'DELETE', headers: { authorization: `Bearer ${ADMIN_TOKEN}` } },
  { route: 'POST /api/meetings/:id/advance', path: `/api/meetings/${MEETING}/advance`, method: 'POST' },
  { route: 'POST /api/meetings/:id/ask', path: `/api/meetings/${MEETING}/ask`, method: 'POST', headers: json, body: JSON.stringify({ question: 'What was decided?' }) },
  { route: 'GET /api/meetings/:id/audio', path: `/api/meetings/${MEETING}/audio`, method: 'GET' },
  { route: 'POST /api/meetings/:id/complete', path: `/api/meetings/${MEETING}/complete`, method: 'POST' },
  { route: 'GET /api/meetings/:id/pipeline', path: `/api/meetings/${MEETING}/pipeline`, method: 'GET' },
  { route: 'GET /api/meetings/:id/search-index', path: `/api/meetings/${MEETING}/search-index`, method: 'GET' },
  { route: 'POST /api/meetings/:id/search-index', path: `/api/meetings/${MEETING}/search-index`, method: 'POST' },
  { route: 'POST /api/meetings/:id/summarize', path: `/api/meetings/${MEETING}/summarize`, method: 'POST' },
  { route: 'GET /api/meetings/:id/summary', path: `/api/meetings/${MEETING}/summary`, method: 'GET' },
  { route: 'POST /api/meetings/:id/transcribe', path: `/api/meetings/${MEETING}/transcribe`, method: 'POST' },
  { route: 'GET /api/meetings/:id/transcript', path: `/api/meetings/${MEETING}/transcript`, method: 'GET' },
  { route: 'PUT /api/uploads/:token', path: '/api/uploads/any-token-at-all', method: 'PUT', headers: { 'content-type': 'audio/ogg' }, body: 'x' },
]

const ask = (entry: typeof ROUTES[number]) => fetch(entry.path, { method: entry.method, headers: entry.headers, body: entry.body })
const page = (path: string) => fetch(path, { headers: { accept: 'text/html' } })

const logLines = () => getServerLogs().join('\n')
const refusalLines = () => getServerLogs().filter(line => line.includes('refusing requests'))

const NAMES_A_SERVICE = /NUXT_|fake-value|groq|workers|supabase|\br2\b|bucket/i

/** A test, not a `beforeAll`: the context these helpers need exists only inside a test. */
function restartWith(env: Record<string, string>) {
  it('restarts the server with these settings', async () => {
    realCalls.length = 0
    await startServer({ env })
  })
}

/**
 * A server that must change nothing. For every route: the one 503, which names nothing, no
 * request to the database and no file in the data directory, and in the log the names of
 * what is missing, once.
 */
function itRefusesEverything(names: string[]) {
  it.each(ROUTES.map(entry => [entry.route, entry] as const))('%s answers 503 with the one message', async (_route, entry) => {
    const res = await ask(entry)
    const text = await res.text()
    expect(res.status).toBe(503)
    expect(JSON.parse(text)).toMatchObject({ statusCode: 503, statusMessage: 'Service Unavailable', message: REFUSED })
    expect(text).not.toMatch(NAMES_A_SERVICE)
    expect(JSON.stringify([...res.headers])).not.toMatch(NAMES_A_SERVICE)
  })

  it('has touched nothing', async () => {
    expect(realCalls).toEqual([])
    expect(await readdir(dataDir)).toEqual([])
  })

  it('logs the names of what is missing once, with no value, however many were refused', async () => {
    await vi.waitFor(() => expect(refusalLines()).toHaveLength(1))
    for (const name of names) expect(refusalLines()[0]).toContain(name)
    expect(logLines()).not.toContain('fake-value')
    expect(logLines()).not.toContain(EVERY_SETTING.NUXT_SUPABASE_URL)
    // Not `[request error]` either: every refusal here is one the routes answered themselves.
    expect(logLines()).not.toContain('request error')
  })
}

describe('the route table', () => {
  it('covers every route under server/api but the health check', async () => {
    const apiDir = join(rootDir, 'server/api')
    const found: string[] = []
    for (const entry of await readdir(apiDir, { recursive: true, withFileTypes: true })) {
      if (!entry.isFile()) continue
      const named = /^(.+)\.(get|post|put|delete)\.ts$/.exec(entry.name)
      expect(named, `${entry.name} answers every method: add it here with what it does`).toBeTruthy()
      const segments = [...relative(apiDir, entry.parentPath).split('/'), named![1]!].filter(segment => segment && segment !== 'index')
      found.push(`${named![2]!.toUpperCase()} /api/${segments.map(segment => segment.replace(/^\[(.+)\]$/, ':$1')).join('/')}`)
    }
    expect(found.filter(route => route !== 'GET /api/health').sort()).toEqual(ROUTES.map(entry => entry.route).sort())
  })
})

describe('a production build with nothing set and no opt-in', () => {
  itRefusesEverything(SETTING_NAMES)

  it('stays up for the health check, which has no provider to refuse', async () => {
    expect((await fetch('/api/health')).status).toBe(200)
  })

  it.each([`/meetings/${MEETING}`, `/meetings/${MEETING}/progress`])('shows a plain failure at %s, not a stack trace or a blank', async (path) => {
    const res = await page(path)
    const html = await res.text()
    expect(res.status).toBe(503)
    expect(html).toContain('Could not load meeting')
    expect(html).not.toMatch(/\.mjs|\bat setup\b|node_modules/)
    for (const name of SETTING_NAMES) expect(html).not.toContain(name)
  })

  it.each(['/', '/meetings'])('still serves %s, which reads nothing', async (path) => {
    expect((await page(path)).status).toBe(200)
  })

  it('tells a wrong code only that it is wrong', async () => {
    const res = await fetch('/api/invite-check', { method: 'POST', headers: { authorization: 'Bearer not-the-code' } })
    expect(res.status).toBe(401)
    expect(await res.text()).not.toContain(REFUSED)
  })

  // A refused caller costs no parsing. Later selections would refuse too, after reading it.
  it('refuses registration before it reads the body', async () => {
    const res = await fetch('/api/meetings', { method: 'POST', headers: { ...inviteHeaders, ...json }, body: '{not json' })
    expect(res.status).toBe(503)
  })

  it('leaves the admin route refusing whoever has no token, before anything else', async () => {
    expect((await fetch(`/api/meetings/${MEETING}`, { method: 'DELETE' })).status).toBe(401)
  })
})

// The invite and demo rules stay as ADR-0015 has them, and come first.
describe('with the invite code absent too', () => {
  restartWith({ NUXT_INVITE_CODE: '' })

  it('says uploading is closed, as it did', async () => {
    const res = await fetch('/api/invite-check', { method: 'POST', headers: inviteHeaders })
    expect(res.status).toBe(503)
    expect(await res.json()).toMatchObject({ message: 'Uploading is closed at the moment, whatever code is entered.' })
  })
})

describe('with this meeting the public demo', () => {
  restartWith({ NUXT_PUBLIC_DEMO_MEETING_ID: MEETING })

  it('still answers 403 to moving it along, and the gate\'s 503 to reading it', async () => {
    expect((await fetch(`/api/meetings/${MEETING}/advance`, { method: 'POST' })).status).toBe(403)
    expect((await fetch(`/api/meetings/${MEETING}`)).status).toBe(503)
  })
})

describe('stub flags set with no opt-in', () => {
  restartWith(STUB_FLAGS)
  itRefusesEverything(SETTING_NAMES)
})

// Only what destr makes of `true` opens it.
describe.each(['1', 'yes', 'on', 'false', '0', '', '"true"'])('the opt-in set to %j', (value) => {
  restartWith({ NUXT_ALLOW_LOCAL_DRIVERS: value })

  it('does nothing', async () => {
    const res = await fetch(`/api/meetings/${MEETING}`)
    expect(res.status).toBe(503)
    expect(await res.json()).toMatchObject({ message: REFUSED })
    expect(await readdir(dataDir)).toEqual([])
  })
})

// One setting absent from a deployment, each in turn, with the rest real and no opt-in.
describe.each([
  ['Groq', GROQ],
  ['Workers AI', WORKERS_AI],
  ['Supabase', SUPABASE],
  ['R2', R2],
])('a deployment with %s absent', (_group, names) => {
  restartWith({ ...EVERY_SETTING, ...blank(...names) })
  itRefusesEverything(names)
})

// The exact shape of the hazard: a real database, a missing key and someone clicking index.
// The opt-in makes no difference to it.
describe.each([
  ['Groq', GROQ],
  ['Workers AI', WORKERS_AI],
  ['R2', R2],
  ['Supabase, beside a real bucket', SUPABASE],
])('with the opt-in, and %s absent while real stores are there', (_group, names) => {
  restartWith({ NUXT_ALLOW_LOCAL_DRIVERS: 'true', ...STUB_FLAGS, ...EVERY_SETTING, ...blank(...names) })
  itRefusesEverything(names)
})

describe.each([
  ['Supabase', ['NUXT_SUPABASE_URL'], ['NUXT_SUPABASE_SERVICE_KEY']],
  ['Workers AI', ['NUXT_WORKERS_AI_ACCOUNT_ID'], ['NUXT_WORKERS_AI_API_TOKEN']],
  ['R2', ['NUXT_R2_ACCOUNT_ID', 'NUXT_R2_BUCKET'], ['NUXT_R2_ACCESS_KEY_ID', 'NUXT_R2_SECRET_ACCESS_KEY']],
])('with the opt-in and half of %s', (_group, present, missing) => {
  restartWith({ NUXT_ALLOW_LOCAL_DRIVERS: 'true', ...Object.fromEntries(present.map(name => [name, EVERY_SETTING[name as keyof typeof EVERY_SETTING]])) })
  itRefusesEverything(missing)
})

describe('with every setting present and no opt-in', () => {
  restartWith({ ...EVERY_SETTING, ...STUB_FLAGS })

  // A route that gets past the gate reaches the database, which has no such meeting.
  it.each([
    `/api/meetings/${MEETING}`,
    `/api/meetings/${MEETING}/transcript`,
    `/api/meetings/${MEETING}/search-index`,
    `/api/meetings/${MEETING}/pipeline`,
  ])('GET %s reaches the real database', async (path) => {
    const before = realCalls.length
    expect((await fetch(path)).status).toBe(404)
    expect(realCalls.length).toBeGreaterThan(before)
  })

  it.each(['transcribe', 'summarize', 'search-index', 'advance'])('POST %s reaches the real database', async (route) => {
    const before = realCalls.length
    expect((await fetch(`/api/meetings/${MEETING}/${route}`, { method: 'POST' })).status).toBe(404)
    expect(realCalls.length).toBeGreaterThan(before)
  })

  it('accepts the invite code, because it could take the upload', async () => {
    expect((await fetch('/api/invite-check', { method: 'POST', headers: inviteHeaders })).status).toBe(204)
  })

  it('has refused nothing, stood nothing in, and written nothing of its own', async () => {
    expect(logLines()).not.toContain('refusing requests')
    expect(logLines()).not.toMatch(/stubs? \(set |local (JSON|filesystem)/)
    expect(await readdir(dataDir)).toEqual([])
  })
})

describe('with the opt-in and real providers on local stores', () => {
  restartWith({ ...LOCAL_DRIVERS, NUXT_GROQ_API_KEY: EVERY_SETTING.NUXT_GROQ_API_KEY, NUXT_WORKERS_AI_ACCOUNT_ID: EVERY_SETTING.NUXT_WORKERS_AI_ACCOUNT_ID, NUXT_WORKERS_AI_API_TOKEN: EVERY_SETTING.NUXT_WORKERS_AI_API_TOKEN })

  it('is allowed, and its row lands in the throwaway store', async () => {
    const res = await fetch('/api/meetings', { method: 'POST', headers: { ...inviteHeaders, ...json }, body: meetingBody })
    expect(res.status).toBe(201)
    expect(await readdir(dataDir)).not.toEqual([])
    expect(realCalls).toEqual([])
    expect(logLines()).not.toContain('refusing requests')
  })
})

describe('with the opt-in and nothing set', () => {
  restartWith(LOCAL_DRIVERS)

  it('runs on stand-ins, and says so', async () => {
    expect((await fetch(`/api/meetings/${MEETING}`)).status).toBe(404)
    await vi.waitFor(() => expect(logLines()).toContain('meetings: local JSON files'))
    expect(realCalls).toEqual([])
    expect(logLines()).not.toContain('refusing requests')
  })
})
