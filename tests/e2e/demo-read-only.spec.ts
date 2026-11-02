import { createHash } from 'node:crypto'
import { mkdtemp, readdir, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { createStorage } from 'unstorage'
import fsDriver from 'unstorage/drivers/fs'
import { $fetch, fetch, setup, startServer } from '@nuxt/test-utils/e2e'
import type { CreateMeetingResponse, ExtractionStepResponse, Meeting, QuestionAnswer, TranscriptSegment } from '../../shared/types/meeting'
import { INVITE_CODE, inviteHeaders } from './helpers/invite'
import { driveIndexing } from './helpers/indexing'
import { driveTranscription } from './helpers/transcribe'

const rootDir = fileURLToPath(new URL('../..', import.meta.url))
const dataDir = await mkdtemp(join(tmpdir(), 'meetmind-demo-'))
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
const audio = new Uint8Array(20_000).map((_, i) => i % 251)

const ANY_CHANGING_ROUTE = ['complete', 'transcribe', 'summarize', 'search-index'] as const

/** A distinctive line for retrieval to find, as in ask-api.spec.ts. */
const DISCUSSION: TranscriptSegment[] = Array.from({ length: 40 }, (_, i) => ({
  idx: i,
  startMs: i * 5_000,
  endMs: i * 5_000 + 4_800,
  text: i === 22
    ? 'We agreed to cut the marketing budget by twenty percent next quarter.'
    : `general update number ${i} with nothing notable`,
}))

async function registerAndUpload(title: string): Promise<string> {
  const { meeting, upload } = await $fetch<CreateMeetingResponse>('/api/meetings', {
    method: 'POST',
    headers: inviteHeaders,
    body: { title, sourceFileName: 'demo.mp4', sourceBytes: 1_000_000, sourceMime: 'video/mp4', durationSec: 10, audioBytes: audio.byteLength },
  })
  await fetch(upload.url, { method: 'PUT', headers: { 'content-type': 'audio/ogg' }, body: audio })
  await $fetch(`/api/meetings/${meeting.id}/complete`, { method: 'POST' })
  return meeting.id
}

async function driveExtraction(id: string): Promise<void> {
  for (let i = 0; i < 50; i++) {
    const res = await fetch(`/api/meetings/${id}/summarize`, { method: 'POST' })
    if (res.status === 200) return
    expect(res.status).toBe(202)
    const step = await res.json() as ExtractionStepResponse
    if (step.next === 'wait') await new Promise(resolve => setTimeout(resolve, Math.min(step.retryAfterMs ?? 0, 6000) + 20))
  }
  throw new Error(`extraction of ${id} did not finish in 50 steps`)
}

/** Every stored byte but the shared provider ledger, which a question is allowed to touch. */
async function everythingStored(): Promise<Record<string, string>> {
  const stored: Record<string, string> = {}
  for (const file of await readdir(dataDir, { recursive: true, withFileTypes: true })) {
    if (!file.isFile()) continue
    const path = join(file.parentPath, file.name)
    const key = relative(dataDir, path)
    if (key.startsWith(join('db', 'slots'))) continue
    stored[key] = createHash('sha256').update(await readFile(path)).digest('hex')
  }
  return stored
}

const post = (id: string, route: string) => fetch(`/api/meetings/${id}/${route}`, { method: 'POST' })

const ask = (id: string) => fetch(`/api/meetings/${id}/ask`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ question: 'What did we decide about the marketing budget?' }),
})

const READ_ONLY = 'The demo meeting is read-only: it can be read and asked questions, not changed.'

async function expectReadOnly(res: Response) {
  expect(res.status).toBe(403)
  expect((await res.json() as { message: string }).message).toBe(READ_ONLY)
}

/**
 * The demo's id is on the home page, so here the id proves nothing about who is asking.
 * These run in order and share one meeting, made the way ADR-0015 tells an operator to:
 * uploaded with the code, finished, indexed, and only then named as the demo.
 */
describe('the demo meeting', () => {
  let demoId = ''

  it('can be finished before it is public, like any other meeting', async () => {
    demoId = await registerAndUpload('Demo')
    await driveTranscription(demoId)
    await db.setItem(`transcripts/${demoId}`, DISCUSSION)
    await db.removeItem(`pipeline/${demoId}`)
    await driveExtraction(demoId)
    await driveIndexing(demoId)
    const { index } = await $fetch<{ index: { state: string } }>(`/api/meetings/${demoId}/search-index`)
    expect(index.state).toBe('ready')
    expect((await $fetch<{ meeting: Meeting }>(`/api/meetings/${demoId}`)).meeting.status).toBe('ready')

    await startServer({ env: { NUXT_PUBLIC_DEMO_MEETING_ID: demoId } })
    expect(await (await fetch('/')).text()).toContain(`href="/meetings/${demoId}"`)
  })

  it.each(ANY_CHANGING_ROUTE)('refuses POST .../%s to an anonymous visitor, and nothing is written', async (route) => {
    const before = await everythingStored()
    await expectReadOnly(await post(demoId, route))
    expect(await everythingStored()).toEqual(before)
  })

  it.each(ANY_CHANGING_ROUTE)('refuses POST .../%s for the same id in capitals, which Postgres would treat as the same row', async (route) => {
    const before = await everythingStored()
    await expectReadOnly(await post(demoId.toUpperCase(), route))
    expect(await everythingStored()).toEqual(before)
  })

  // The router decodes the path, so this reaches the route as the id itself.
  it.each(ANY_CHANGING_ROUTE)('refuses POST .../%s for the same id percent-encoded', async (route) => {
    const before = await everythingStored()
    const encoded = `%${demoId.charCodeAt(0).toString(16)}${demoId.slice(1)}`
    await expectReadOnly(await post(encoded, route))
    expect(await everythingStored()).toEqual(before)
  })

  it.each(ANY_CHANGING_ROUTE)('holding the invite code changes nothing about POST .../%s', async (route) => {
    const before = await everythingStored()
    await expectReadOnly(await fetch(`/api/meetings/${demoId}/${route}`, { method: 'POST', headers: inviteHeaders }))
    expect(await everythingStored()).toEqual(before)
  })

  // A finished demo was never the risk: these routes do nothing to one. These are the
  // states that did spend or change something for anyone who knew the id, each a real
  // way to get there: a redeploy with a new embedding model, a demo named before it
  // finished, a failed run. The row is put back after each.
  it.each<[string, (id: string, row: Meeting) => Promise<unknown>]>([
    ['ready, with its summary row gone', id => db.removeItem(`summaries/${id}`)],
    ['ready, with an incomplete index', async (id) => {
      await db.setItem(`windows/${id}`, (await db.getItem<unknown[]>(`windows/${id}`))!.slice(0, -1))
    }],
    ['ready, indexed by another model', async (id) => {
      const windows = await db.getItem<Record<string, unknown>[]>(`windows/${id}`)
      await db.setItem(`windows/${id}`, windows!.map(w => ({ ...w, model: 'an-older-model' })))
    }],
    ['still pending its upload', (id, row) => db.setItem(`meetings/${id}`, { ...row, status: 'pending_upload', uploadedAt: null })],
    ['uploaded and not transcribed', async (id, row) => {
      await db.setItem(`meetings/${id}`, { ...row, status: 'uploaded' })
      await db.removeItem(`pipeline/${id}`)
    }],
    ['failed in transcription, past its cooldown', (id, row) => db.setItem(`meetings/${id}`, {
      ...row, status: 'failed', failedStage: 'transcription', errorMessage: 'boom', updatedAt: new Date(Date.now() - 3_600_000).toISOString(),
    })],
    ['failed in extraction, past its cooldown', (id, row) => db.setItem(`meetings/${id}`, {
      ...row, status: 'failed', failedStage: 'summarization', errorMessage: 'boom', updatedAt: new Date(Date.now() - 3_600_000).toISOString(),
    })],
  ])('is not moved along when it is %s', async (_name, stage) => {
    const keys = ['meetings', 'summaries', 'windows', 'transcripts', 'pipeline'].map(table => `${table}/${demoId}`)
    const saved = await Promise.all(keys.map(key => db.getItem(key)))
    const row = saved[0] as Meeting
    await stage(demoId, row)
    const before = await everythingStored()
    for (const route of ANY_CHANGING_ROUTE) await expectReadOnly(await post(demoId, route))
    expect(await everythingStored()).toEqual(before)
    await Promise.all(keys.map((key, i) => db.setItem(key, saved[i] as never)))
  })

  it('still answers questions, the one thing a visitor may spend, and writes nothing about the meeting', async () => {
    const before = await everythingStored()
    const res = await ask(demoId)
    expect(res.status).toBe(200)
    const { answer } = await res.json() as { answer: QuestionAnswer }
    expect(answer.found).toBe(true)
    expect(answer.citations.length).toBeGreaterThan(0)
    expect(await everythingStored()).toEqual(before)
  })

  it.each(['', '/transcript', '/summary', '/search-index', '/audio'])('still serves GET /api/meetings/:id%s', async (path) => {
    expect((await fetch(`/api/meetings/${demoId}${path}`)).status).toBe(200)
  })

  it.each(['', '/progress'])('still renders /meetings/:id%s', async (path) => {
    expect((await fetch(`/meetings/${demoId}${path}`, { headers: { accept: 'text/html' } })).status).toBe(200)
  })

  it('leaves every other meeting on the server to whoever holds its link', async () => {
    const id = await registerAndUpload('Not the demo')
    await driveTranscription(id)
    await driveExtraction(id)
    expect((await post(id, 'search-index')).status).toBe(202)
    expect((await driveIndexing(id)).index.state).toBe('ready')
    expect((await $fetch<{ meeting: Meeting }>(`/api/meetings/${id}`)).meeting.status).toBe('ready')
  })

  it('cannot be overwritten by registering a meeting under its id', async () => {
    const before = await everythingStored()
    const body = JSON.stringify({ id: demoId, title: 'Overwrite', sourceFileName: 'a.mp4', sourceBytes: 1, sourceMime: null, durationSec: 1, audioBytes: 1 })
    const headers = { 'content-type': 'application/json' }
    expect((await fetch('/api/meetings', { method: 'POST', headers, body })).status).toBe(401)
    expect((await fetch('/api/meetings', { method: 'POST', headers: { ...headers, ...inviteHeaders }, body })).status).toBe(400)
    expect(await everythingStored()).toEqual(before)
  })

  it('takes its id in capitals from the operator too', async () => {
    await startServer({ env: { NUXT_PUBLIC_DEMO_MEETING_ID: demoId.toUpperCase() } })
    await expectReadOnly(await post(demoId, 'transcribe'))
    await startServer({ env: { NUXT_PUBLIC_DEMO_MEETING_ID: demoId } })
  })

  it('can still be deleted by an operator, and only by one', async () => {
    expect((await fetch(`/api/meetings/${demoId}`, { method: 'DELETE' })).status).toBe(401)
    const row = await db.getItem<Meeting>(`meetings/${demoId}`)
    const old = new Date(Date.now() - 3 * 3_600_000).toISOString()
    await db.setItem(`meetings/${demoId}`, { ...row!, createdAt: old, updatedAt: old, uploadedAt: old })
    const res = await fetch(`/api/meetings/${demoId}`, { method: 'DELETE', headers: { authorization: `Bearer ${ADMIN_TOKEN}` } })
    expect(res.status).toBe(204)
    expect((await ask(demoId)).status).toBe(404)
  })
})
