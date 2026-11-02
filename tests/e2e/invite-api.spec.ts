import { randomUUID } from 'node:crypto'
import { mkdtemp, readdir, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { createStorage } from 'unstorage'
import fsDriver from 'unstorage/drivers/fs'
import { fetch, getServerLogs, setup } from '@nuxt/test-utils/e2e'
import { signToken } from '../../server/utils/signed-token'
import type { CreateMeetingResponse } from '../../shared/types/meeting'
import { INVITE_CODE, inviteHeaders } from './helpers/invite'

const rootDir = fileURLToPath(new URL('../..', import.meta.url))
const dataDir = await mkdtemp(join(tmpdir(), 'meetmind-invite-'))
const ADMIN_TOKEN = 'e2e-admin-token-0123456789abcdefghij'

await setup({
  rootDir,
  build: false,
  nuxtConfig: { nitro: { output: { dir: join(rootDir, '.output') } } },
  env: {
    NUXT_DATA_DIR: dataDir,
    NUXT_UPLOAD_TOKEN_SECRET: 'e2e-secret',
    NUXT_INVITE_CODE: INVITE_CODE,
    NUXT_ADMIN_TOKEN: ADMIN_TOKEN,
  },
})

const db = createStorage({ driver: fsDriver({ base: join(dataDir, 'db') }) })
const meetingRows = () => db.getKeys('meetings')

const body = JSON.stringify({
  title: 'Invite test',
  sourceFileName: 'invite.mp4',
  sourceBytes: 1_000_000,
  sourceMime: 'video/mp4',
  durationSec: 30,
  audioBytes: 4096,
})

const json = { 'content-type': 'application/json' }
const register = (headers: Record<string, string> = {}, path = '/api/meetings') =>
  fetch(path, { method: 'POST', headers: { ...json, ...headers }, body })
const check = (headers: Record<string, string> = {}) =>
  fetch('/api/invite-check', { method: 'POST', headers })

const bearer = (code: string) => ({ authorization: `Bearer ${code}` })

/** Every way of not having the code, the near misses among them. */
const REFUSED: [string, Record<string, string>][] = [
  ['no code', {}],
  ['a wrong code', bearer('not-the-code-not-the-code-not-the-code')],
  ['the code with its last character changed', bearer(`${INVITE_CODE.slice(0, -1)}X`)],
  ['the code cut short', bearer(INVITE_CODE.slice(0, -1))],
  ['the code with a character added', bearer(`${INVITE_CODE}x`)],
  ['the right code under another scheme', { authorization: `Basic ${INVITE_CODE}` }],
  ['the right code with no scheme', { authorization: INVITE_CODE }],
  ['an empty bearer', { authorization: 'Bearer ' }],
  ['the admin token, which is a different secret', bearer(ADMIN_TOKEN)],
]

describe('POST /api/meetings without the code', () => {
  it.each(REFUSED)('refuses %s, and stores nothing', async (_name, headers) => {
    const before = await meetingRows()
    const res = await register(headers)
    expect(res.status).toBe(401)
    expect(res.headers.get('www-authenticate')).toBe('Bearer')
    expect((await res.json() as { message: string }).message).toBe('Uploading needs a valid invite code.')
    expect(await meetingRows()).toEqual(before)
  })

  it('answers every refusal in the same words, so none is warmer than another', async () => {
    const bodies = new Set<string>()
    for (const [, headers] of REFUSED) bodies.add(await (await register(headers)).text())
    expect(bodies.size).toBe(1)
  })

  // In a URL or a body it would be in logs and history, which is why neither is read.
  it.each([
    ['the query string', `/api/meetings?code=${INVITE_CODE}&inviteCode=${INVITE_CODE}&invite=${INVITE_CODE}&authorization=${INVITE_CODE}`],
    ['a path suffix', `/api/meetings/${INVITE_CODE}`],
  ])('does not take the code from %s', async (_name, path) => {
    const before = await meetingRows()
    const res = await register({}, path)
    expect([401, 404, 405]).toContain(res.status)
    expect(await meetingRows()).toEqual(before)
  })

  it('does not take the code from the body', async () => {
    const res = await fetch('/api/meetings', {
      method: 'POST',
      headers: json,
      body: JSON.stringify({ ...JSON.parse(body), inviteCode: INVITE_CODE, code: INVITE_CODE }),
    })
    expect(res.status).toBe(401)
  })

  // Each of these would answer differently if anything ran before the gate.
  it('refuses before reading the body: an oversized one gets a 401, not a 413', async () => {
    const res = await fetch('/api/meetings', { method: 'POST', headers: json, body: 'x'.repeat(8192) })
    expect(res.status).toBe(401)
  })

  it('refuses before reading the body: an invalid one gets a 401, not a 400', async () => {
    const res = await fetch('/api/meetings', { method: 'POST', headers: json, body: '{"title":' })
    expect(res.status).toBe(401)
  })

  it('refuses before the length check: a streamed body gets a 401, not a 411', async () => {
    const res = await fetch('/api/meetings', {
      method: 'POST',
      headers: json,
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(body))
          controller.close()
        },
      }),
      duplex: 'half',
    } as RequestInit)
    expect(res.status).toBe(401)
  })
})

describe('POST /api/meetings with the code', () => {
  it('registers the meeting', async () => {
    const res = await register(inviteHeaders)
    expect(res.status).toBe(201)
    const { meeting, upload } = await res.json() as CreateMeetingResponse
    expect(meeting.status).toBe('pending_upload')
    expect(upload.url).toMatch(/^\/api\/uploads\//)
  })

  it('still validates what it is given', async () => {
    const res = await fetch('/api/meetings', { method: 'POST', headers: { ...json, ...inviteHeaders }, body: '{"title":""}' })
    expect(res.status).toBe(400)
  })
})

describe('POST /api/invite-check', () => {
  it('accepts the code, with nothing to read back', async () => {
    const res = await check(inviteHeaders)
    expect(res.status).toBe(204)
    expect(await res.text()).toBe('')
  })

  it.each(REFUSED)('refuses %s exactly as the real route does', async (_name, headers) => {
    const [real, probe] = await Promise.all([register(headers), check(headers)])
    expect(probe.status).toBe(real.status)
    expect(probe.headers.get('www-authenticate')).toBe(real.headers.get('www-authenticate'))
    const message = async (res: Response) => (await res.json() as { message: string }).message
    expect(await message(probe)).toBe(await message(real))
  })

  it('creates nothing, whatever it is given', async () => {
    const before = await meetingRows()
    await check(inviteHeaders)
    await check()
    expect(await meetingRows()).toEqual(before)
  })

  it('is not reachable by a GET, which a link or a prefetch could send', async () => {
    const res = await fetch('/api/invite-check', { headers: inviteHeaders })
    expect([404, 405]).toContain(res.status)
  })
})

describe('no other route stores anything without the code', () => {
  const unknownId = randomUUID()

  it.each([
    ['complete', ''],
    ['transcribe', ''],
    ['summarize', ''],
    ['search-index', ''],
    ['ask', JSON.stringify({ question: 'What was decided?' })],
  ])('POST .../%s on an id nobody registered creates no meeting', async (route, payload) => {
    const before = await meetingRows()
    const res = await fetch(`/api/meetings/${unknownId}/${route}`, {
      method: 'POST',
      headers: json,
      ...(payload ? { body: payload } : {}),
    })
    expect(res.status).toBe(404)
    expect(await meetingRows()).toEqual(before)
  })

  it.each(['POST', 'PUT', 'PATCH'])('%s /api/meetings/:id is not a route', async (method) => {
    const before = await meetingRows()
    const res = await fetch(`/api/meetings/${unknownId}`, { method, headers: json, body })
    expect([404, 405]).toContain(res.status)
    expect(await meetingRows()).toEqual(before)
  })

  const audioFiles = async () => (await readdir(join(dataDir, 'audio'), { recursive: true }).catch(() => [])).sort()

  it('PUT /api/uploads/:token refuses a token it did not sign', async () => {
    const before = await audioFiles()
    const forged = await signToken({
      v: 1,
      key: `meetings/${unknownId}/audio.ogg`,
      contentType: 'audio/ogg',
      contentLength: 4,
      exp: Math.floor(Date.now() / 1000) + 600,
    }, 'not-the-server-secret')
    for (const token of [forged, 'garbage', 'garbage.garbage']) {
      const res = await fetch(`/api/uploads/${token}`, {
        method: 'PUT',
        headers: { 'content-type': 'audio/ogg' },
        body: new Uint8Array(4),
      })
      expect(res.status).toBe(403)
    }
    expect(await audioFiles()).toEqual(before)
  })
})

describe('the code stays out of everything the server says or keeps', () => {
  it.each([
    ['accepted, as JSON', () => register(inviteHeaders)],
    ['accepted by the check', () => check(inviteHeaders)],
    ['refused, as JSON', () => register(bearer(`${INVITE_CODE}x`))],
    ['refused by the check', () => check(bearer(`${INVITE_CODE}x`))],
    ['refused, as an HTML error page', () => register({ ...bearer(`${INVITE_CODE}x`), accept: 'text/html' })],
    ['invalid, with the code', () => fetch('/api/meetings', { method: 'POST', headers: { ...json, ...inviteHeaders, accept: 'text/html' }, body: '{' })],
  ])('not in the response when %s', async (_name, send) => {
    const res = await send()
    const text = await res.text()
    expect(text).not.toContain(INVITE_CODE)
    expect(text).not.toContain(INVITE_CODE.slice(0, 20))
    expect(JSON.stringify([...res.headers.entries()])).not.toContain(INVITE_CODE.slice(0, 20))
  })

  it.each(['/', '/meetings'])('not in the page or payload of %s', async (path) => {
    const html = await (await fetch(path)).text()
    expect(html).not.toContain(INVITE_CODE)
    expect(html).not.toContain('inviteCode')
  })

  it('not on disk, after every request above', async () => {
    const files = await readdir(dataDir, { recursive: true, withFileTypes: true })
    const offenders: string[] = []
    for (const file of files.filter(f => f.isFile())) {
      const text = await readFile(join(file.parentPath, file.name), 'utf8').catch(() => '')
      if (text.includes(INVITE_CODE)) offenders.push(file.name)
    }
    expect(files.length).toBeGreaterThan(0)
    expect(offenders).toEqual([])
  })

  it('not in the server log, after every request above', () => {
    expect(getServerLogs().join('\n')).not.toContain(INVITE_CODE)
  })

  it('does not warn about the configuration when it is fine', () => {
    expect(getServerLogs().join('\n')).not.toContain('NUXT_INVITE_CODE')
  })
})
