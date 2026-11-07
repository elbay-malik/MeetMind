import { mkdir, mkdtemp, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeEach, describe, expect, it } from 'vitest'
import { createStorage } from 'unstorage'
import fsDriver from 'unstorage/drivers/fs'
import { $fetch, fetch, setup } from '@nuxt/test-utils/e2e'
import type { CreateMeetingResponse, Meeting, PipelineResponse, PublicMeeting, TranscriptSegment } from '../../shared/types/meeting'
import { INJECTED_FAILURE_TEXT } from '../../server/utils/injected-failure'
import { fixedSentence } from '../../server/utils/public-errors'
import { DAILY_LIMIT_MESSAGE } from '../../server/utils/qa/embedder'
import { advance, driveToDone, STEP_BOUND } from './helpers/pipeline'
import { INVITE_CODE, inviteHeaders } from './helpers/invite'
import { LOCAL_DRIVERS } from './helpers/local-drivers'
import { driveTranscription } from './helpers/transcribe'

/**
 * SEC-15, held whole: no text from a provider, a database or a store reaches a browser,
 * from any route that takes a meeting's id, or from a page, whatever is stored and whatever
 * was thrown. Its own file for the setting that lets a stub fail with such text.
 */
const rootDir = fileURLToPath(new URL('../..', import.meta.url))
const dataDir = await mkdtemp(join(tmpdir(), 'meetmind-raw-errors-'))
const CANARY = 'RAWERRORCANARY'
const ADMIN_TOKEN = 'e2e-admin-token-0123456789-abcdefghijklmnop'

await setup({
  rootDir,
  build: false,
  nuxtConfig: { nitro: { output: { dir: join(rootDir, '.output') } } },
  env: {
    ...LOCAL_DRIVERS,
    NUXT_DATA_DIR: dataDir,
    NUXT_UPLOAD_TOKEN_SECRET: 'e2e-secret',
    NUXT_INVITE_CODE: INVITE_CODE,
    NUXT_ADMIN_TOKEN: ADMIN_TOKEN,
    NUXT_STUB_FAILURE_CANARY: CANARY,
    NUXT_EMBED_INTERVAL_MS: '0',
  },
})

const db = createStorage({ driver: fsDriver({ base: join(dataDir, 'db') }) })

/** What `INJECTED_FAILURE_TEXT` holds, piece by piece, and the two fields that carried it. */
const FORBIDDEN = [
  'PGRST-SENTINEL',
  'meetings_sentinel_check',
  'meetings/sentinel-object',
  'provider-sentinel-body',
  'org_sentinel',
  'Supabase read failed',
  'errorMessage',
  'lastError',
]

function expectClean(where: string, text: string): void {
  for (const word of FORBIDDEN) expect(text, `${where} says ${word}`).not.toContain(word)
}

interface Route {
  name: string
  url: (id: string) => string
  init?: RequestInit
}

const post = (name: string, init: RequestInit = {}): Route => ({
  name: `POST /${name}`,
  url: id => `/api/meetings/${id}/${name}`,
  init: { method: 'POST', ...init },
})
const get = (name: string): Route => ({ name: `GET /${name}`, url: id => `/api/meetings/${id}/${name}` })

/** Every route that takes a meeting's id, in the order a sweep goes through them. The reads first, and the delete last. */
const ROUTES: Route[] = [
  { name: 'GET /', url: id => `/api/meetings/${id}` },
  get('audio'),
  get('pipeline'),
  get('search-index'),
  get('summary'),
  get('transcript'),
  post('complete'),
  post('ask', { headers: { 'content-type': 'application/json' }, body: JSON.stringify({ question: 'What does the placeholder stand in for?' }) }),
  post('search-index'),
  post('summarize'),
  post('transcribe'),
  post('advance'),
  { name: 'DELETE /', url: id => `/api/meetings/${id}`, init: { method: 'DELETE', headers: { authorization: `Bearer ${ADMIN_TOKEN}` } } },
]

/** Every page that reads the meeting, so each has the row in it to leak. */
const PAGES = (id: string) => [`/meetings/${id}`, `/meetings/${id}/progress`]

const TITLE = 'Raw errors'

/**
 * That a page came out and had the row to leak, or being clean of the text says nothing. Not by
 * `__NUXT_DATA__`, which an error page has too, nor by the status alone: a row that cannot be
 * read can still render a 200 with nothing of the meeting in it.
 */
function expectRendered(where: string, status: number, html: string): void {
  expect(status, where).toBe(200)
  // The server's payload travels in the page, so what is read here is both.
  expect(html, where).toContain('__NUXT_DATA__')
  expect(html, where).toContain(TITLE)
}

/** Every page and every route, each with its headers and body held to {@link FORBIDDEN}. What each answered, by route. */
async function sweep(id: string, where: string): Promise<Record<string, number>> {
  for (const path of PAGES(id)) {
    const res = await fetch(path, { headers: { accept: 'text/html' } })
    const html = await res.text()
    expectRendered(`${where}: ${path}`, res.status, html)
    expectClean(`${where}: ${path}`, html)
  }
  const answered: Record<string, number> = {}
  for (const route of ROUTES) {
    const res = await fetch(route.url(id), route.init)
    answered[route.name] = res.status
    expectClean(`${where}: ${route.name}`, JSON.stringify([...res.headers]) + await res.text())
  }
  return answered
}

const audio = new Uint8Array(20_000).map((_, i) => i % 251)

async function register(bytes: Uint8Array): Promise<CreateMeetingResponse> {
  // This file registers more meetings than the app's day allows (ADR-0020), which is not what it is about.
  await db.removeItem(`meeting-registrations/${new Date().toISOString().slice(0, 10)}`)
  const created = await $fetch<CreateMeetingResponse>('/api/meetings', {
    method: 'POST',
    headers: inviteHeaders,
    body: { title: TITLE, sourceFileName: 'meeting.mp4', sourceBytes: 1_000_000, sourceMime: 'video/mp4', durationSec: 10, audioBytes: bytes.byteLength },
  })
  expect(created.meeting).not.toHaveProperty('errorMessage')
  return created
}

async function uploaded(bytes: Uint8Array = audio): Promise<PublicMeeting> {
  const { meeting, upload } = await register(bytes)
  await fetch(upload.url, { method: 'PUT', headers: { 'content-type': 'audio/ogg' }, body: bytes })
  return (await $fetch<{ meeting: PublicMeeting }>(`/api/meetings/${meeting.id}/complete`, { method: 'POST' })).meeting
}

const transcribed = async () => (await driveTranscription((await uploaded()).id)).meeting

interface Ledger {
  runs: Record<string, { lastError: string | null, retryAt: number | null, [key: string]: unknown }>
  chunks: unknown[]
}

const storedRow = async (id: string) => (await db.getItem<Meeting>(`meetings/${id}`))!
const storedRun = async (id: string, stage: string) => (await db.getItem<Ledger>(`pipeline/${id}`))!.runs[stage]!

async function patchRow(id: string, patch: Partial<Meeting>): Promise<void> {
  await db.setItem(`meetings/${id}`, { ...await storedRow(id), ...patch })
}

const NEW_RUN = { runId: '00000000-0000-4000-8000-00000000abcd', cursor: {}, stepToken: null, stepLeaseUntil: null, stepChunkNo: null, attempts: 1 }

/** A run that is resting until a minute from now, with `lastError` on it. */
async function restRun(id: string, stage: string, lastError: string): Promise<void> {
  const ledger = await db.getItem<Ledger>(`pipeline/${id}`) ?? { runs: {}, chunks: [] }
  ledger.runs[stage] = { ...NEW_RUN, ...ledger.runs[stage], lastError, retryAt: Date.now() + 60_000 }
  await db.setItem(`pipeline/${id}`, ledger)
}

/** Lines holding `marker`, which a stub reads as the failure to give, and which nobody but the marker's test would say. */
async function markTranscript(id: string, marker: string): Promise<void> {
  const segments = await db.getItem<TranscriptSegment[]>(`transcripts/${id}`)
  await db.setItem(`transcripts/${id}`, segments!.map((s, i) => i === 0 ? { ...s, text: `${s.text} ${marker}` } : s))
}

interface ErrorBody { statusCode: number, statusMessage: string, message: string, data?: { retryAt?: string, retryAfterSec?: number } }

// The block a rate limit leaves is the account's, and would hold off the next test's request.
beforeEach(() => db.removeItem('slots/workers-ai-embed'))

describe('the test itself', () => {
  it('goes through every route that takes a meeting\'s id, so a new one has to be added here', async () => {
    const root = fileURLToPath(new URL('../../server/api/meetings/', import.meta.url))
    const method = (file: string) => /\.(get|post|delete)\.ts$/.exec(file)![1]!.toUpperCase()
    const onDisk = [
      ...(await readdir(root)).filter(file => file.startsWith('[id].')).map(file => `${method(file)} /`),
      ...(await readdir(join(root, '[id]'))).map(file => `${method(file)} /${file.replace(/\.\w+\.ts$/, '')}`),
    ]
    expect(ROUTES.map(route => route.name).sort()).toEqual(onDisk.sort())
  })

  it('looks for what really goes wrong: the text a stub fails with holds every one of the words', () => {
    for (const word of FORBIDDEN.slice(0, 6)) expect(INJECTED_FAILURE_TEXT).toContain(word)
    expect(() => expectClean('this', INJECTED_FAILURE_TEXT)).toThrow()
  })

  describe('takes only a page that rendered, with its row, for one it can hold clean', () => {
    const read = async (path: string) => {
      const res = await fetch(path, { headers: { accept: 'text/html' } })
      return { status: res.status, html: await res.text() }
    }

    it.each(PAGES('00000000-0000-4000-8000-000000000000'))('not the error page of %s, which has the payload too', async (path) => {
      const { status, html } = await read(path)
      expect(status).toBe(404)
      expect(html).toContain('__NUXT_DATA__')
      expect(() => expectRendered(path, status, html)).toThrow()
    })

    it('not a page whose row could not be read', async () => {
      const { meeting } = await register(audio)
      await db.setItem(`meetings/${meeting.id}`, 'not a row')
      for (const path of PAGES(meeting.id)) {
        const { status, html } = await read(path)
        expect(() => expectRendered(path, status, html)).toThrow()
      }
    })

    it('and one that did', async () => {
      const { meeting } = await register(audio)
      for (const path of PAGES(meeting.id)) {
        const { status, html } = await read(path)
        expectRendered(path, status, html)
      }
    })
  })
})

describe('what is stored stays stored, and goes nowhere', () => {
  it('a transcription that failed, in its cooldown: the refused branch', async () => {
    const { id } = await uploaded()
    await patchRow(id, { status: 'failed', failedStage: 'transcription', errorMessage: INJECTED_FAILURE_TEXT, updatedAt: new Date().toISOString() })
    await restRun(id, 'transcription', INJECTED_FAILURE_TEXT)

    const body = await (await fetch(`/api/meetings/${id}/transcribe`, { method: 'POST' })).json() as ErrorBody
    expect(body).toMatchObject({ statusCode: 409, statusMessage: 'Conflict' })
    expect(body.message).toMatch(/^The last transcription attempt failed recently; wait \d+s before retrying$/)

    const row = await $fetch<{ meeting: PublicMeeting }>(`/api/meetings/${id}`)
    expect(row.meeting).toMatchObject({ status: 'failed', failedStage: 'transcription' })
    expect(row.meeting).not.toHaveProperty('errorMessage')

    // The delete refused too, for the upload URL a meeting this new may still have out.
    expect(await sweep(id, 'failed transcription')).toMatchObject({ 'GET /': 200, 'POST /transcribe': 409, 'POST /advance': 200, 'DELETE /': 409 })
  })

  it('an extraction that failed, in its cooldown: the refused branch', async () => {
    const { id } = await transcribed()
    await patchRow(id, { status: 'failed', failedStage: 'summarization', errorMessage: INJECTED_FAILURE_TEXT, updatedAt: new Date().toISOString() })
    await restRun(id, 'summarization', INJECTED_FAILURE_TEXT)

    const body = await (await fetch(`/api/meetings/${id}/summarize`, { method: 'POST' })).json() as ErrorBody
    expect(body.message).toMatch(/^The last extraction failed recently; wait \d+s before retrying$/)
    expect((await storedRow(id)).errorMessage).toBe(INJECTED_FAILURE_TEXT)
    expect((await storedRun(id, 'summarization')).lastError).toBe(INJECTED_FAILURE_TEXT)

    expect(await sweep(id, 'failed extraction')).toMatchObject({ 'GET /': 200, 'POST /summarize': 409, 'POST /transcribe': 409 })
  })

  it('an upload that was refused: no retry for any route to offer', async () => {
    const { id } = await uploaded()
    await patchRow(id, { status: 'failed', failedStage: 'upload', errorMessage: INJECTED_FAILURE_TEXT })
    expect(await sweep(id, 'refused upload')).toMatchObject({ 'GET /': 200, 'POST /complete': 409, 'POST /transcribe': 409, 'POST /summarize': 409 })
  })

  it('a transcription resting with a last error: the progress branch', async () => {
    const { id } = await uploaded()
    await patchRow(id, { status: 'transcribing', errorMessage: INJECTED_FAILURE_TEXT })
    await restRun(id, 'transcription', INJECTED_FAILURE_TEXT)

    const res = await fetch(`/api/meetings/${id}/transcribe`, { method: 'POST' })
    expect(res.status).toBe(202)
    const body = await res.json()
    expect(body).toMatchObject({ next: 'wait', progress: { done: 0, segments: 0 } })
    expect(body.progress).not.toHaveProperty('lastError')
    expect(body.meeting).not.toHaveProperty('errorMessage')
    expect(body.retryAfterMs).toBeGreaterThan(0)
    expect(res.headers.get('retry-after')).not.toBeNull()

    expect(await sweep(id, 'transcription at rest')).toMatchObject({ 'POST /transcribe': 202 })
  })

  it('an extraction resting with a last error: the progress branch', async () => {
    const { id } = await transcribed()
    await patchRow(id, { status: 'indexing', errorMessage: INJECTED_FAILURE_TEXT })
    await restRun(id, 'summarization', INJECTED_FAILURE_TEXT)

    const res = await fetch(`/api/meetings/${id}/summarize`, { method: 'POST' })
    expect(res.status).toBe(202)
    const body = await res.json()
    expect(body).toMatchObject({ next: 'wait' })
    expect(body.progress).not.toHaveProperty('lastError')
    expect(body.meeting).not.toHaveProperty('errorMessage')

    expect(await sweep(id, 'extraction at rest')).toMatchObject({ 'POST /summarize': 202 })
  })

  it('an index resting with a last error: the progress branch', async () => {
    const { id } = await transcribed()
    await restRun(id, 'search_index', INJECTED_FAILURE_TEXT)

    const res = await fetch(`/api/meetings/${id}/search-index`, { method: 'POST' })
    expect(res.status).toBe(202)
    const body = await res.json()
    expect(body).toMatchObject({ next: 'wait' })
    expect(body.progress).not.toHaveProperty('lastError')

    expect(await sweep(id, 'index at rest')).toMatchObject({ 'POST /search-index': 202 })
  })

  it('an index resting at the daily limit, which is the one stored sentence a caller is told', async () => {
    const { id } = await transcribed()
    await restRun(id, 'search_index', DAILY_LIMIT_MESSAGE)

    const res = await fetch(`/api/meetings/${id}/search-index`, { method: 'POST' })
    expect(res.status).toBe(429)
    const body = await res.json() as ErrorBody
    expect(body.message).toBe(`${DAILY_LIMIT_MESSAGE} Passages indexed so far are kept; indexing again resumes from there.`)
    expect(body.data?.retryAt).toBeTruthy()
  })

  it('a finished meeting with an error left on it: the done branches', async () => {
    const { id } = await uploaded()
    await driveToDone(id)
    // Old enough that nothing holds off the delete at the end of the sweep.
    await patchRow(id, { errorMessage: INJECTED_FAILURE_TEXT, createdAt: new Date(Date.now() - 86_400_000).toISOString() })

    for (const step of ['transcribe', 'summarize']) {
      const res = await fetch(`/api/meetings/${id}/${step}`, { method: 'POST' })
      expect(res.status, step).toBe(200)
      expect((await res.json()).meeting, step).not.toHaveProperty('errorMessage')
    }
    expect(await sweep(id, 'finished')).toMatchObject({ 'GET /': 200, 'POST /ask': 200, 'POST /search-index': 200, 'POST /summarize': 200, 'POST /transcribe': 200, 'DELETE /': 204 })
  })

  it('an uploaded meeting with an error left on it: completing it again answers with the row', async () => {
    const { id } = await uploaded()
    await patchRow(id, { errorMessage: INJECTED_FAILURE_TEXT })
    const res = await fetch(`/api/meetings/${id}/complete`, { method: 'POST' })
    expect(res.status).toBe(200)
    expect((await res.json()).meeting).not.toHaveProperty('errorMessage')
    expect(await sweep(id, 'uploaded')).toMatchObject({ 'POST /complete': 200 })
  })
})

describe('what a provider throws', () => {
  describe('in transcription', () => {
    const stuck = async (kind: string) => {
      const marked = audio.slice()
      marked.set(new TextEncoder().encode(`${CANARY}:transcribe:${kind}`), 100)
      const { id } = await uploaded(marked)
      return { id, res: await fetch(`/api/meetings/${id}/transcribe`, { method: 'POST' }) }
    }

    it('a refusal: the failed branch, in a fixed sentence, with the raw text stored', async () => {
      const { id, res } = await stuck('refused')
      expect(res.status).toBe(502)
      expect(await res.json()).toMatchObject({ statusCode: 502, statusMessage: 'Transcription failed', message: fixedSentence('transcription', 502) })
      expect(await storedRow(id)).toMatchObject({ status: 'failed', failedStage: 'transcription', errorMessage: INJECTED_FAILURE_TEXT })
      expect((await storedRun(id, 'transcription')).lastError).toBe(INJECTED_FAILURE_TEXT)
      await sweep(id, 'refused transcription')
    })

    it('a 429: the failed branch, in the rate limit\'s own fixed sentence', async () => {
      const { id, res } = await stuck('rate-limited')
      expect(res.status).toBe(429)
      expect(await res.json()).toMatchObject({ statusMessage: 'Transcription failed', message: fixedSentence('transcription', 429) })
      expect((await storedRow(id)).errorMessage).toBe(INJECTED_FAILURE_TEXT)
      await sweep(id, 'rate limited transcription')
    })

    it.each(['retryable', 'internal'])('failing as %s: the progress branch, with the raw text on the run', async (kind) => {
      const { id, res } = await stuck(kind)
      expect(res.status).toBe(202)
      const body = await res.json()
      expect(body).toMatchObject({ next: 'wait' })
      expect(body.progress).not.toHaveProperty('lastError')
      expect((await storedRun(id, 'transcription')).lastError).toBe(INJECTED_FAILURE_TEXT)
      await sweep(id, `${kind} transcription`)
    })
  })

  describe('in extraction', () => {
    const stuck = async (kind: string) => {
      const { id } = await transcribed()
      await markTranscript(id, `${CANARY}:summarize:${kind}`)
      return { id, res: await fetch(`/api/meetings/${id}/summarize`, { method: 'POST' }) }
    }

    it('a refusal: the failed branch, in a fixed sentence, with the raw text stored', async () => {
      const { id, res } = await stuck('refused')
      expect(res.status).toBe(502)
      expect(await res.json()).toMatchObject({ statusMessage: 'Summarisation failed', message: fixedSentence('extraction', 502) })
      expect(await storedRow(id)).toMatchObject({ status: 'failed', failedStage: 'summarization', errorMessage: INJECTED_FAILURE_TEXT })
      await sweep(id, 'refused extraction')
    })

    it.each(['retryable', 'rate-limited', 'internal'])('failing as %s: the progress branch, with the raw text on the run', async (kind) => {
      const { id, res } = await stuck(kind)
      expect(res.status).toBe(202)
      const body = await res.json()
      expect(body).toMatchObject({ next: 'wait' })
      expect(body.progress).not.toHaveProperty('lastError')
      expect((await storedRun(id, 'summarization')).lastError).toBe(INJECTED_FAILURE_TEXT)
      await sweep(id, `${kind} extraction`)
    })
  })

  describe('in indexing', () => {
    const stuck = async (kind: string) => {
      const { id } = await transcribed()
      await markTranscript(id, `${CANARY}:embed:${kind}`)
      return { id, res: await fetch(`/api/meetings/${id}/search-index`, { method: 'POST' }) }
    }
    const RESUMES = 'Passages indexed so far are kept; indexing again resumes from there.'

    it('a refusal: the failed branch, which still says it resumes', async () => {
      const { id, res } = await stuck('refused')
      expect(res.status).toBe(502)
      const body = await res.json() as ErrorBody
      expect(body).toMatchObject({ statusMessage: 'Indexing failed', message: `${fixedSentence('indexing', 502)} ${RESUMES}` })
      expect((await storedRun(id, 'search_index')).lastError).toBe(INJECTED_FAILURE_TEXT)
      await sweep(id, 'refused index')
    })

    it('a 429: the failed branch, with when to come back', async () => {
      const { id, res } = await stuck('rate-limited')
      expect(res.status).toBe(429)
      expect(res.headers.get('retry-after')).not.toBeNull()
      const body = await res.json() as ErrorBody
      expect(body).toMatchObject({ statusMessage: 'Indexing failed', message: `${fixedSentence('indexing', 429)} ${RESUMES}` })
      expect(body.data?.retryAt).toBeTruthy()
      expect(body.data?.retryAfterSec).toBeGreaterThan(0)
      expect((await storedRun(id, 'search_index')).lastError).toBe(INJECTED_FAILURE_TEXT)
      await sweep(id, 'rate limited index')
    })

    it('a retryable failure: the progress branch, with the raw text on the run', async () => {
      const { id, res } = await stuck('retryable')
      expect(res.status).toBe(202)
      const body = await res.json()
      expect(body).toMatchObject({ next: 'wait' })
      expect(body.progress).not.toHaveProperty('lastError')
      expect((await storedRun(id, 'search_index')).lastError).toBe(INJECTED_FAILURE_TEXT)
      await sweep(id, 'retryable index')
    })

    it('an internal failure: the progress branch, with our own words on the run', async () => {
      const { id, res } = await stuck('internal')
      expect(res.status).toBe(202)
      expect((await storedRun(id, 'search_index')).lastError).toBe('Indexing hit a problem on the server.')
      await sweep(id, 'internal index')
    })
  })

  describe('to a question', () => {
    const asked = async (marker: string) => {
      const { id } = await uploaded()
      await driveToDone(id)
      const res = await fetch(`/api/meetings/${id}/ask`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ question: `What does the placeholder stand in for? ${CANARY}:${marker}` }),
      })
      return { id, res, text: await res.text() }
    }

    it.each(['embed', 'answer'])('a refusal while it was at %s: a fixed sentence, stored nowhere', async (stage) => {
      const { id, res, text } = await asked(`${stage}:refused`)
      expect(res.status).toBe(502)
      expect(JSON.parse(text)).toMatchObject({ statusMessage: 'Answering failed', message: fixedSentence('answering', 502) })
      expectClean(stage, text)
      await sweep(id, `refused at ${stage}`)
    })

    it.each(['embed', 'answer'])('a retryable failure while it was at %s: a fixed sentence', async (stage) => {
      const { res, text } = await asked(`${stage}:retryable`)
      expect(res.status).toBe(502)
      expect(JSON.parse(text)).toMatchObject({ message: fixedSentence('answering', 502) })
      expectClean(stage, text)
    })

    it.each(['embed', 'answer'])('a 429 while it was at %s: the fixed sentence, and when to ask again', async (stage) => {
      const { res, text } = await asked(`${stage}:rate-limited`)
      expect(res.status).toBe(429)
      expect(res.headers.get('retry-after')).not.toBeNull()
      const body = JSON.parse(text) as ErrorBody
      expect(body).toMatchObject({ statusMessage: 'Answering failed', message: fixedSentence('answering', 429) })
      expect(body.data?.retryAt).toBeTruthy()
      expectClean(stage, text)
    })

    it.each(['embed', 'answer'])('an error that is no provider\'s while it was at %s: Nitro keeps it from the caller', async (stage) => {
      const { res, text } = await asked(`${stage}:internal`)
      expect(res.status).toBe(500)
      expectClean(stage, text)
    })
  })
})

/**
 * `/advance` runs the same steps as the routes above and answers from a second read, so what
 * goes wrong during a step must not reach that answer. Asked first, while nothing is resting,
 * since the sweeps above only reach it once the run is parked or on a step with no marker.
 */
describe('what a provider throws during /advance', () => {
  /**
   * Asks until the failure is stored, as a step that plans first or a stage that comes later
   * takes more than one, which is what shows the failing step was reached. Every answer on the
   * way is held, the one the step failed in most of all.
   */
  async function advanceUntilStored(id: string, stage: string, where: string, stored = INJECTED_FAILURE_TEXT): Promise<void> {
    for (let i = 0; i < STEP_BOUND; i++) {
      const res = await advance(id)
      const text = await res.text()
      expect(res.status, where).toBe(200)
      expectClean(`${where}: request ${i + 1}`, JSON.stringify([...res.headers]) + text)
      if ((await db.getItem<Ledger>(`pipeline/${id}`))?.runs[stage]?.lastError === stored) return
      const answer = JSON.parse(text) as PipelineResponse
      expect(answer.next, `${where}: stopped at request ${i + 1} without failing`).not.toMatch(/^(?:done|failed)$/)
      if (answer.next === 'wait') await new Promise(resolve => setTimeout(resolve, Math.min(answer.retryAfterMs ?? 0, 6000) + 20))
    }
    throw new Error(`${where}: the failure was not stored in ${STEP_BOUND} requests`)
  }

  it.each(['refused', 'retryable', 'rate-limited', 'internal'])('in transcription, failing as %s', async (kind) => {
    const marked = audio.slice()
    marked.set(new TextEncoder().encode(`${CANARY}:transcribe:${kind}`), 100)
    const { id } = await uploaded(marked)
    await advanceUntilStored(id, 'transcription', `${kind} transcription`)
    await sweep(id, `${kind} transcription after /advance`)
  })

  it.each(['refused', 'retryable', 'rate-limited', 'internal'])('in extraction, failing as %s', async (kind) => {
    const { id } = await transcribed()
    await markTranscript(id, `${CANARY}:summarize:${kind}`)
    await advanceUntilStored(id, 'summarization', `${kind} extraction`)
    await sweep(id, `${kind} extraction after /advance`)
  })

  it.each(['refused', 'retryable', 'rate-limited'])('in indexing, failing as %s', async (kind) => {
    const { id } = await transcribed()
    await markTranscript(id, `${CANARY}:embed:${kind}`)
    await advanceUntilStored(id, 'search_index', `${kind} index`)
    await sweep(id, `${kind} index after /advance`)
  })

  it('in indexing, failing as no provider\'s error, with our own words on the run', async () => {
    const { id } = await transcribed()
    await markTranscript(id, `${CANARY}:embed:internal`)
    await advanceUntilStored(id, 'search_index', 'internal index', 'Indexing hit a problem on the server.')
    await sweep(id, 'internal index after /advance')
  })
})

describe('what a store says', () => {
  /** A stored object that is not what was declared, so completing it refuses it. */
  async function planted(contentType: string, size = audio.byteLength): Promise<{ id: string, path: string }> {
    const { meeting } = await register(audio)
    const path = join(dataDir, 'audio', ...meeting.audioKey.split('/'))
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, new Uint8Array(size))
    await writeFile(`${path}.meta`, JSON.stringify({ contentType, size }))
    return { id: meeting.id, path }
  }
  const complete = (id: string) => fetch(`/api/meetings/${id}/complete`, { method: 'POST' })

  // A delete that fails, whose error names the object's key, is in tests/unit/complete-route.spec.ts:
  // the local store's driver swallows every error of a removal, so no file here can make one.
  it('says a refused upload\'s size and nothing of the delete', async () => {
    const { id } = await planted('audio/ogg', audio.byteLength + 1)
    const res = await complete(id)
    expect(res.status).toBe(409)
    const text = await res.text()
    expect(JSON.parse(text).message).toBe(`Uploaded audio was ${audio.byteLength + 1} bytes, expected ${audio.byteLength}`)
    expect(text).not.toMatch(/object deleted|audio\.ogg/)
    expect(await storedRow(id)).toMatchObject({ status: 'failed', failedStage: 'upload', errorMessage: `Uploaded audio was ${audio.byteLength + 1} bytes, expected ${audio.byteLength}; object deleted` })
    await sweep(id, 'refused size')
  })

  it('says a refused upload\'s object was not the type, and not what the uploader said it was', async () => {
    const { id } = await planted('text/sentinel-content-type')
    const res = await complete(id)
    expect(res.status).toBe(409)
    const text = await res.text()
    expect(JSON.parse(text).message).toBe('The uploaded object is not audio/ogg.')
    expect(text).not.toContain('sentinel-content-type')
    expect((await storedRow(id)).errorMessage).toMatch(/^Uploaded object is text\/sentinel-content-type, expected audio\/ogg; object deleted$/)
  })

  it('says a fixed sentence of a type that is no type at all', async () => {
    const { id } = await planted('text/PGRST-SENTINEL-116 violates "meetings_sentinel_check"')
    const res = await complete(id)
    expect(res.status).toBe(409)
    const text = await res.text()
    expect(JSON.parse(text).message).toBe(fixedSentence('upload', 409))
    expectClean('POST /complete', text)
  })
})
