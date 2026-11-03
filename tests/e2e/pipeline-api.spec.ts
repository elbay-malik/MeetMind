import { createHash } from 'node:crypto'
import { mkdtemp, readdir, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { createStorage } from 'unstorage'
import fsDriver from 'unstorage/drivers/fs'
import { $fetch, fetch, setup } from '@nuxt/test-utils/e2e'
import type { CreateMeetingResponse, Meeting, MeetingSummary, PipelineResponse, PublicMeeting, QuestionAnswer, SearchIndexStatus, TranscriptSegment } from '../../shared/types/meeting'
import { whisperReplyKey } from '../../shared/utils/meeting'
import { advance, driveToDone } from './helpers/pipeline'
import { indexUntilStopped } from './helpers/indexing'
import { INVITE_CODE, inviteHeaders } from './helpers/invite'
import { LOCAL_DRIVERS } from './helpers/local-drivers'

const rootDir = fileURLToPath(new URL('../..', import.meta.url))
const dataDir = await mkdtemp(join(tmpdir(), 'meetmind-pipeline-'))

await setup({
  rootDir,
  build: false,
  nuxtConfig: { nitro: { output: { dir: join(rootDir, '.output') } } },
  env: { ...LOCAL_DRIVERS, NUXT_DATA_DIR: dataDir, NUXT_UPLOAD_TOKEN_SECRET: 'e2e-secret', NUXT_INVITE_CODE: INVITE_CODE },
})

const db = createStorage({ driver: fsDriver({ base: join(dataDir, 'db') }) })

// A minute of audio at the rate the stub assumes, which it splits into its 12 lines at most.
const audio = new Uint8Array(120_000).map((_, i) => i % 251)

async function register(): Promise<CreateMeetingResponse> {
  return $fetch<CreateMeetingResponse>('/api/meetings', {
    method: 'POST',
    headers: inviteHeaders,
    body: { title: 'Pipeline test', sourceFileName: 'meeting.mp4', sourceBytes: 1_000_000, sourceMime: 'video/mp4', durationSec: 60, audioBytes: audio.byteLength },
  })
}

/** The fixture: its audio stored and confirmed, nothing else done. */
async function uploadedMeeting(): Promise<PublicMeeting> {
  const { meeting, upload } = await register()
  await fetch(upload.url, { method: 'PUT', headers: { 'content-type': 'audio/ogg' }, body: audio })
  return (await $fetch<{ meeting: PublicMeeting }>(`/api/meetings/${meeting.id}/complete`, { method: 'POST' })).meeting
}

const pipeline = (id: string) => $fetch<PipelineResponse>(`/api/meetings/${id}/pipeline`)
const meetingOf = async (id: string) => (await $fetch<{ meeting: PublicMeeting }>(`/api/meetings/${id}`)).meeting
const indexOf = async (id: string) => (await $fetch<{ index: SearchIndexStatus }>(`/api/meetings/${id}/search-index`)).index

/** Every stored byte, the provider ledger included, for what a read is not allowed to touch. */
async function everythingStored(): Promise<Record<string, string>> {
  const stored: Record<string, string> = {}
  for (const file of await readdir(dataDir, { recursive: true, withFileTypes: true })) {
    if (!file.isFile()) continue
    const path = join(file.parentPath, file.name)
    stored[relative(dataDir, path)] = createHash('sha256').update(await readFile(path)).digest('hex')
  }
  return stored
}

/** What is stored, by name. */
const storedKeys = async () => Object.keys(await everythingStored())

describe('driveToDone', () => {
  it('takes the fixture from uploaded to ready with the index complete, and no stage is skipped', async () => {
    const meeting = await uploadedMeeting()
    expect(meeting.status).toBe('uploaded')

    const answers = await driveToDone(meeting.id)

    // The stages, each seen working, in the order they come, and the end of the run.
    expect([...new Set(answers.map(a => a.progress.stage))]).toEqual(['transcription', 'summarization', 'search_index'])
    expect(answers.map(a => a.status)).toEqual(expect.arrayContaining(['transcribing', 'summarizing', 'indexing', 'ready']))
    expect(answers.at(-1)).toMatchObject({ status: 'ready', next: 'done', retryAt: null, retryAfterMs: null, index: { state: 'complete' } })
    expect(answers.slice(0, -1).every(a => a.next === 'continue' || a.next === 'wait')).toBe(true)

    // And what each stage leaves behind, read back over the routes a visitor uses: if a step
    // were skipped, or only said to have run, one of these would have nothing to show.
    expect(await meetingOf(meeting.id)).toMatchObject({ status: 'ready', failedStage: null })
    expect(await db.getItem<Meeting>(`meetings/${meeting.id}`)).toMatchObject({ errorMessage: null })

    const { segments } = await $fetch<{ segments: TranscriptSegment[] }>(`/api/meetings/${meeting.id}/transcript`)
    expect(segments).toHaveLength(12)
    expect(segments.map(s => s.idx)).toEqual(segments.map((_, i) => i))

    const { summary } = await $fetch<{ summary: MeetingSummary }>(`/api/meetings/${meeting.id}/summary`)
    expect(summary.provider).toBe('stub')
    expect(summary.summary).not.toBe('')
    expect(summary.decisions.length + summary.actionItems.length).toBeGreaterThan(0)

    const index = await indexOf(meeting.id)
    expect(index.state).toBe('ready')
    expect(index.windowCount).toBeGreaterThan(0)
    expect(index.indexedCount).toBe(index.windowCount)
    expect(answers.at(-1)!.progress).toEqual({ stage: 'search_index', done: index.windowCount, total: index.windowCount, etaSeconds: null })

    const asked = await $fetch<{ answer: QuestionAnswer }>(`/api/meetings/${meeting.id}/ask`, {
      method: 'POST',
      body: { question: 'What does the placeholder stand in for?' },
    })
    expect(asked.answer.found).toBe(true)

    // The reply Whisper left in storage has been read and removed.
    expect(await storedKeys()).not.toContainEqual(expect.stringContaining(whisperReplyKey(meeting.id)))

    // And nothing changes its mind afterwards.
    expect(await driveToDone(meeting.id)).toEqual([answers.at(-1)])
  })

  it('answers the shape the ADR gives, and nothing else, at every step', async () => {
    const meeting = await uploadedMeeting()
    await driveToDone(meeting.id, (answer) => {
      expect(Object.keys(answer).sort()).toEqual(['index', 'next', 'progress', 'retryAfterMs', 'retryAt', 'status'])
      expect(Object.keys(answer.progress).sort()).toEqual(['done', 'etaSeconds', 'stage', 'total'])
      expect(Object.keys(answer.index).sort()).toEqual(['done', 'retryAt', 'state', 'total'])
      expect(answer.progress.etaSeconds).toBeNull()
    })
  })

  it('reaches the same end from a meeting partly driven by the per-stage routes, which share its steps', async () => {
    const meeting = await uploadedMeeting()
    const step = (route: string) => fetch(`/api/meetings/${meeting.id}/${route}`, { method: 'POST' })

    // Whisper, by the stage's route. A page of its reply, by the driver. The last step, by the route.
    expect((await step('transcribe')).status).toBe(202)
    expect(await (await advance(meeting.id)).json()).toMatchObject({ status: 'transcribing', next: 'continue' })
    expect((await step('transcribe')).status).toBe(200)
    expect((await meetingOf(meeting.id)).status).toBe('summarizing')
    // Its one chunk, by the route, and everything after it by the driver.
    expect((await step('summarize')).status).toBe(202)

    expect((await driveToDone(meeting.id)).at(-1)).toMatchObject({ status: 'ready', next: 'done', index: { state: 'complete' } })
    expect((await step('search-index')).status).toBe(200)
    expect((await step('summarize')).status).toBe(200)
  })

  it('lets two drivers at once reach the same end', async () => {
    const meeting = await uploadedMeeting()
    const [one, other] = await Promise.all([driveToDone(meeting.id), driveToDone(meeting.id)])
    for (const answers of [one, other]) {
      expect(answers.at(-1)).toMatchObject({ status: 'ready', next: 'done', index: { state: 'complete' } })
      expect(answers.every(a => a.next !== 'failed')).toBe(true)
    }
  })
})

describe('GET .../pipeline', () => {
  it('writes nothing at any point of a drive, and says what the last POST said', async () => {
    const meeting = await uploadedMeeting()
    const looksBefore = await everythingStored()
    expect(await pipeline(meeting.id)).toMatchObject({ status: 'uploaded', next: 'continue', index: { state: 'unavailable' } })
    expect(await everythingStored()).toEqual(looksBefore)

    await driveToDone(meeting.id, async (answer) => {
      const before = await everythingStored()
      const looked = await pipeline(meeting.id)
      expect(await everythingStored()).toEqual(before)
      // Its wait is measured when it is asked, and that is all that may differ, if that.
      expect({ ...looked, retryAt: null, retryAfterMs: null, index: { ...looked.index, retryAt: null } })
        .toEqual({ ...answer, retryAt: null, retryAfterMs: null, index: { ...answer.index, retryAt: null } })
    })
  })

  it('moves nothing, however many times it is asked', async () => {
    const meeting = await uploadedMeeting()
    for (let i = 0; i < 5; i++) await pipeline(meeting.id)
    expect(await meetingOf(meeting.id)).toMatchObject({ status: 'uploaded', updatedAt: meeting.updatedAt })
  })
})

describe('what cannot be advanced', () => {
  const UNKNOWN = '00000000-0000-4000-8000-000000000000'

  it('answers an unknown meeting as the other routes do, on both', async () => {
    for (const res of [await advance(UNKNOWN), await fetch(`/api/meetings/${UNKNOWN}/pipeline`)]) {
      expect(res.status).toBe(404)
      expect((await res.json() as { message: string }).message).toBe('Meeting not found')
    }
    expect(await storedKeys()).not.toContainEqual(expect.stringContaining(UNKNOWN))
  })

  it('answers an id that is not one as the other routes do, on both', async () => {
    expect((await advance('not-a-uuid')).status).toBe(404)
    expect((await fetch('/api/meetings/not-a-uuid/pipeline')).status).toBe(404)
  })

  it('refuses a meeting still pending its upload, and a read says only that it is pending', async () => {
    const { meeting } = await register()
    const before = await everythingStored()
    const res = await advance(meeting.id)
    expect(res.status).toBe(409)
    expect((await res.json() as { message: string }).message).toMatch(/pending_upload/)
    expect(await everythingStored()).toEqual(before)
    expect(await pipeline(meeting.id)).toEqual({
      status: 'pending_upload',
      progress: { stage: 'upload', done: 0, total: null, etaSeconds: null },
      index: { state: 'unavailable', done: 0, total: null, retryAt: null },
      next: 'wait',
      retryAt: null,
      retryAfterMs: null,
    })
  })

  it('stops at a rejected upload, with nothing to come back for', async () => {
    const { meeting, upload } = await register()
    await fetch(upload.url, { method: 'PUT', headers: { 'content-type': 'audio/ogg' }, body: audio })
    const row = await db.getItem<Meeting>(`meetings/${meeting.id}`)
    await db.setItem(`meetings/${meeting.id}`, { ...row!, status: 'failed', failedStage: 'upload', errorMessage: 'rejected' })
    const answers = await driveToDone(meeting.id)
    expect(answers).toHaveLength(1)
    expect(answers[0]).toMatchObject({ status: 'failed', next: 'failed', retryAt: null, progress: { stage: 'upload' } })
  })
})

/**
 * With provider settings missing, the deployment's embedder is the stub, and any real
 * index reads as another model's (SEC-16). These servers run the stub, so a real one is
 * what is stored here: exactly the state a deployment that lost its settings would find.
 */
describe('an index of another model', () => {
  const ANOTHER_MODEL = '@cf/baai/bge-m3'

  async function readyWithAnotherModelsIndex(): Promise<string> {
    const meeting = await uploadedMeeting()
    await driveToDone(meeting.id)
    const windows = (await db.getItem<Array<Record<string, unknown>>>(`windows/${meeting.id}`))!
    await db.setItem(`windows/${meeting.id}`, windows.map(w => ({ ...w, model: ANOTHER_MODEL })))
    const ledger = (await db.getItem<{ indexMarker: Record<string, unknown> }>(`pipeline/${meeting.id}`))!
    await db.setItem(`pipeline/${meeting.id}`, { ...ledger, indexMarker: { ...ledger.indexMarker, model: ANOTHER_MODEL } })
    return meeting.id
  }

  it('stays as it is under POST .../advance, which answers done and writes nothing', async () => {
    const id = await readyWithAnotherModelsIndex()
    const before = await everythingStored()
    for (let i = 0; i < 3; i++) {
      const res = await advance(id)
      expect(res.status).toBe(200)
      expect(await res.json()).toMatchObject({ status: 'ready', next: 'done', retryAt: null, index: { state: 'held' } })
    }
    expect(await everythingStored()).toEqual(before)
    expect((await indexOf(id)).state).toBe('none')
  })

  it('stays as it is half replaced, where only the explicit route carries on', async () => {
    const id = await readyWithAnotherModelsIndex()
    // What one click on a longer meeting leaves: a pass of the current model, marked
    // incomplete, and the rest of the windows still the other model's.
    const windows = (await db.getItem<Array<Record<string, unknown>>>(`windows/${id}`))!
    expect(windows.length).toBeGreaterThan(1)
    await db.setItem(`windows/${id}`, windows.map((w, i) => (i === 0 ? { ...w, model: 'stub-hashed-tokens-v2' } : w)))
    const ledger = (await db.getItem<{ indexMarker: Record<string, unknown> }>(`pipeline/${id}`))!
    await db.setItem(`pipeline/${id}`, { ...ledger, indexMarker: { ...ledger.indexMarker, model: 'stub-hashed-tokens-v2', complete: false, windowCount: 0 } })

    const before = await everythingStored()
    expect(await (await advance(id)).json()).toMatchObject({ status: 'ready', next: 'done', index: { state: 'held' } })
    expect(await everythingStored()).toEqual(before)

    expect((await indexUntilStopped(id)).status).toBe(200)
    expect((await indexOf(id)).state).toBe('ready')
  })

  it('is replaced by the explicit route, and then the driver is done with it', async () => {
    const id = await readyWithAnotherModelsIndex()
    const res = await indexUntilStopped(id)
    expect(res.status).toBe(200)
    expect((await indexOf(id)).state).toBe('ready')
    expect(await (await advance(id)).json()).toMatchObject({ next: 'done', index: { state: 'complete' } })
  })
})

describe('the page that drives it, as the server renders it', () => {
  const page = (id: string) => fetch(`/meetings/${id}/progress`, { headers: { accept: 'text/html' } })

  it('moves nothing and stores nothing: a render is not a driver, and neither is a crawler', async () => {
    const meeting = await uploadedMeeting()
    const before = await everythingStored()
    const res = await page(meeting.id)
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('Audio uploaded')
    expect(await everythingStored()).toEqual(before)
    expect((await meetingOf(meeting.id)).status).toBe('uploaded')
  })

  it('says where a meeting stands, from the same answer the driver reads', async () => {
    const meeting = await uploadedMeeting()
    await driveToDone(meeting.id)
    const html = await (await page(meeting.id)).text()
    expect(html).toContain('Ready for questions')
    expect(html).toContain('Ask on the meeting page')
  })

  it('carries no stored error, not on the page and not in what it sends with it', async () => {
    const meeting = await uploadedMeeting()
    const raw = 'PGRST116 relation pipeline_runs does not exist'
    const row = await db.getItem<Meeting>(`meetings/${meeting.id}`)
    await db.setItem(`meetings/${meeting.id}`, { ...row!, status: 'failed', failedStage: 'transcription', errorMessage: raw })

    const html = await (await page(meeting.id)).text()
    expect(html).toContain('Transcription did not finish')
    // The server's payload travels in the page, so this is both, and it is what is being read.
    expect(html).toContain('__NUXT_DATA__')
    expect(html).not.toContain('PGRST116')
  })

  it.each<[string, Partial<Meeting>, RegExp]>([
    ['a rejected upload', { failedStage: 'upload', errorMessage: 'Uploaded object is text/html, expected audio/ogg; object deleted' }, /rejected and removed/],
    ['audio gone', { failedStage: 'transcription', errorMessage: 'The meeting audio is missing from storage' }, /missing or has changed/],
    ['too many chunks', { failedStage: 'summarization', errorMessage: 'This transcript would need 41 sequential requests, over the 40 limit.' }, /too long to extract/],
  ])('says %s is final, in its own words, from the real assessment', async (_name, failure, words) => {
    const meeting = await uploadedMeeting()
    const row = await db.getItem<Meeting>(`meetings/${meeting.id}`)
    await db.setItem(`meetings/${meeting.id}`, { ...row!, status: 'failed', ...failure })

    expect(await pipeline(meeting.id)).toMatchObject({ next: 'failed', retryAt: null })
    const html = await (await page(meeting.id)).text()
    expect(html).toMatch(words)
    expect(html).not.toContain(failure.errorMessage!)
  })

  // A Node server has no cron, so it must not say it does, and nothing here moves a meeting by itself.
  describe('with no cron, as on any server but a Worker', () => {
    it('says only an open page moves a meeting, in what the server renders and hands to the page', async () => {
      const meeting = await uploadedMeeting()
      const html = await (await fetch(`/meetings/${meeting.id}`, { headers: { accept: 'text/html' } })).text()
      expect(html).toContain('Open Pipeline and transcription starts by itself')
      expect(html).not.toContain('every 5 minutes')
      expect(html).toContain('deployment-facts')
    })

    // The browser cannot work these out, and a page reached by a link never asks the server
    // again, so whichever page a visit lands on has to bring them along for the next.
    it.each(['/', '/meetings', 'summary'])('hands the page the facts from %s, whichever page a visit lands on', async (path) => {
      const meeting = await uploadedMeeting()
      const target = path === 'summary' ? `/meetings/${meeting.id}/summary` : path
      const html = await (await fetch(target, { headers: { accept: 'text/html' } })).text()
      expect(html).toContain('deployment-facts')
    })

    it('never runs a tick: a meeting left alone stays where it is, and no rotation is stored', async () => {
      const meeting = await uploadedMeeting()
      await new Promise(resolve => setTimeout(resolve, 500))
      expect((await db.getItem<Meeting>(`meetings/${meeting.id}`))!.status).toBe('uploaded')
      expect(await db.getItem('sweep/state')).toBeNull()
    })

    it.each(['/__scheduled', '/_nitro/tasks', '/_nitro/tasks/sweep', '/api/sweep', '/api/cron'])('has no route at %s that could run one', async (path) => {
      for (const method of ['GET', 'POST']) {
        expect((await fetch(path, { method })).status, method).toBe(404)
      }
      expect(await db.getItem('sweep/state')).toBeNull()
    })
  })
})
