import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { createStorage } from 'unstorage'
import fsDriver from 'unstorage/drivers/fs'
import { fetch, getServerLogs, setup, startServer } from '@nuxt/test-utils/e2e'

const rootDir = fileURLToPath(new URL('../..', import.meta.url))
const dataDir = await mkdtemp(join(tmpdir(), 'meetmind-invite-closed-'))

/** One character short of the 32 the gate insists on. */
const SHORT_CODE = 'e2e-short-invite-code-012345678'
/** Exactly 32: where closed stops. */
const SHORTEST_CODE = 'e2e-short-invite-code-0123456789'

// Really absent, not just empty, even when the shell running the tests has one.
delete process.env.NUXT_INVITE_CODE

/**
 * Its own spec file because the code is process-wide, and these are misconfigured on
 * purpose. This is the one setting whose absence must not select a stub: a missing code
 * closes uploads, and a short one is refused even from a caller who presents it exactly.
 */
await setup({
  rootDir,
  build: false,
  nuxtConfig: { nitro: { output: { dir: join(rootDir, '.output') } } },
  env: { NUXT_DATA_DIR: dataDir, NUXT_UPLOAD_TOKEN_SECRET: 'e2e-secret' },
})

const db = createStorage({ driver: fsDriver({ base: join(dataDir, 'db') }) })

const body = JSON.stringify({
  title: 'Closed test',
  sourceFileName: 'closed.mp4',
  sourceBytes: 1_000_000,
  sourceMime: 'video/mp4',
  durationSec: 30,
  audioBytes: 4096,
})

const register = (headers: Record<string, string> = {}) =>
  fetch('/api/meetings', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body })
const check = (headers: Record<string, string> = {}) =>
  fetch('/api/invite-check', { method: 'POST', headers })
const bearer = (code: string) => ({ authorization: `Bearer ${code}` })

function itIsClosed(presented: Record<string, string>[], configured: string | null) {
  it.each(presented.map(headers => [headers.authorization ?? 'no code', headers] as const))('refuses %s with a plain message, and stores nothing', async (_name, headers) => {
    for (const res of [await register(headers), await check(headers)]) {
      expect(res.status).toBe(503)
      const text = await res.text()
      expect((JSON.parse(text) as { message: string }).message).toBe('Uploading is closed at the moment, whatever code is entered.')
      if (configured) expect(text).not.toContain(configured)
    }
    expect(await db.getKeys('meetings')).toEqual([])
  })

  it('warns the operator, naming the setting and not its value', async () => {
    await register(presented[0])
    const logs = getServerLogs().join('\n')
    expect(logs).toContain('NUXT_INVITE_CODE')
    expect(logs).toContain('uploads are closed')
    if (configured) expect(logs).not.toContain(configured)
  })

  it('still serves the home page, which says uploading is invite-only', async () => {
    const res = await fetch('/')
    expect(res.status).toBe(200)
    const html = (await res.text()).replace(/\s+/g, ' ')
    expect(html).toContain('Uploading is invite-only')
    expect(html).not.toContain('type="file"')
    if (configured) expect(html).not.toContain(configured)
  })
}

/** A test, not a `beforeAll`: the context these helpers need exists only inside a test. */
function restartWith(code: string) {
  it(`restarts the server with a ${code.length}-character NUXT_INVITE_CODE`, () => startServer({ env: { NUXT_INVITE_CODE: code } }))
}

describe('with NUXT_INVITE_CODE absent', () => {
  itIsClosed([{}, bearer('anything-at-all-anything-at-all-anything'), bearer('undefined'), bearer('null')], null)
})

describe('with NUXT_INVITE_CODE empty', () => {
  restartWith('')
  itIsClosed([{}, { authorization: 'Bearer ' }], null)
})

describe('with NUXT_INVITE_CODE too short', () => {
  restartWith(SHORT_CODE)
  it('guards its own fixture: at 32 this would test nothing', () => {
    expect(SHORT_CODE).toHaveLength(31)
  })
  itIsClosed([bearer(SHORT_CODE), {}], SHORT_CODE)
})

describe('with NUXT_INVITE_CODE nothing but whitespace', () => {
  restartWith(' '.repeat(40))
  itIsClosed([{}, bearer(' '.repeat(40))], null)
})

describe('with NUXT_INVITE_CODE exactly the minimum length', () => {
  restartWith(SHORTEST_CODE)

  it('is open to whoever presents it', async () => {
    expect(SHORTEST_CODE).toHaveLength(32)
    expect((await check(bearer(SHORTEST_CODE))).status).toBe(204)
    expect((await register(bearer(SHORTEST_CODE))).status).toBe(201)
    expect((await register()).status).toBe(401)
  })
})
