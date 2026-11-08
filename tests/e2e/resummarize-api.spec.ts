import { createHash } from 'node:crypto'
import { mkdtemp, readdir, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { createStorage } from 'unstorage'
import fsDriver from 'unstorage/drivers/fs'
import { $fetch, fetch, setup, startServer } from '@nuxt/test-utils/e2e'
import type { CreateMeetingResponse, ExtractionStepResponse, MeetingSummary, PublicMeeting, QuestionAnswer, TranscriptSegment } from '../../shared/types/meeting'
import { DEMO_READ_ONLY_MESSAGE } from '../../shared/utils/meeting'
import { advance, driveToDone } from './helpers/pipeline'
import { INVITE_CODE, inviteHeaders } from './helpers/invite'
import { LOCAL_DRIVERS } from './helpers/local-drivers'

const rootDir = fileURLToPath(new URL('../..', import.meta.url))
const dataDir = await mkdtemp(join(tmpdir(), 'meetmind-resummarize-'))
const ADMIN_TOKEN = 'e2e-admin-token-resummarize-0123456789'

/**
 * `POST /api/meetings/:id/resummarize` over a built server (ADR-0011's resummarize addendum): the
 * operator's token, the meetings it refuses, and a finished meeting taken back through extraction
 * by the ordinary step loop to a new summary, with its transcript and index as they were. That the
 * cron sweeper finishes it on the demo, where no page drives, is tests/unit/sweep.spec.ts.
 */
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
  },
})

const db = createStorage({ driver: fsDriver({ base: join(dataDir, 'db') }) })
const audio = new Uint8Array(120_000).map((_, i) => i % 251)
const OLD: MeetingSummary = { summary: 'An earlier summary of this meeting.', decisions: [], actionItems: [], provider: 'groq' }

async function uploadedMeeting(): Promise<string> {
  const { meeting, upload } = await $fetch<CreateMeetingResponse>('/api/meetings', {
    method: 'POST',
    headers: inviteHeaders,
    body: { title: 'Resummarize test', sourceFileName: 'meeting.mp4', sourceBytes: 1_000_000, sourceMime: 'video/mp4', durationSec: 60, audioBytes: audio.byteLength },
  })
  await fetch(upload.url, { method: 'PUT', headers: { 'content-type': 'audio/ogg' }, body: audio })
  await $fetch(`/api/meetings/${meeting.id}/complete`, { method: 'POST' })
  return meeting.id
}

/** A meeting driven to the end, with `OLD` stored as its summary, so a new one can be told from it. */
async function finishedMeeting(): Promise<string> {
  const id = await uploadedMeeting()
  expect((await driveToDone(id)).at(-1)).toMatchObject({ status: 'ready', next: 'done', index: { state: 'complete' } })
  await db.setItem(`summaries/${id}`, OLD)
  return id
}

const resummarize = (id: string, token: string | null = ADMIN_TOKEN) => fetch(`/api/meetings/${id}/resummarize`, {
  method: 'POST',
  headers: token === null ? {} : { authorization: `Bearer ${token}` },
})

const meetingOf = async (id: string) => (await $fetch<{ meeting: PublicMeeting }>(`/api/meetings/${id}`)).meeting
const summaryOf = async (id: string) => (await $fetch<{ summary: MeetingSummary | null }>(`/api/meetings/${id}/summary`)).summary
const transcriptOf = async (id: string) => (await $fetch<{ segments: TranscriptSegment[] }>(`/api/meetings/${id}/transcript`)).segments

/** Every stored byte but the shared provider ledger, for what a refusal must not touch. */
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

describe('POST /api/meetings/:id/resummarize', () => {
  it('makes a ready meeting\'s summary again through the step loop, and leaves its transcript and index as they were', async () => {
    const id = await finishedMeeting()
    const before = (await db.getItem<{ updatedAt: string }>(`meetings/${id}`))!
    const segments = await transcriptOf(id)
    const windows = await db.getItem(`windows/${id}`)
    expect(await summaryOf(id)).toEqual(OLD)

    const res = await resummarize(id)
    expect(res.status).toBe(202)
    const started = await res.json() as ExtractionStepResponse
    expect(started).toMatchObject({ meeting: { status: 'indexing' }, progress: { done: 0 }, next: 'continue' })
    expect(started.progress.total).toBeGreaterThan(0)
    // Stored until the new one replaces it, and not served meanwhile, as for any meeting being summarised.
    expect(await db.getItem(`summaries/${id}`)).toEqual(OLD)
    expect(await summaryOf(id)).toBeNull()

    const answers = await driveToDone(id)
    expect(answers.at(-1)).toMatchObject({ status: 'ready', next: 'done', index: { state: 'complete' } })

    const summary = await summaryOf(id)
    expect(summary).toMatchObject({ provider: 'stub' })
    expect(summary!.summary).not.toBe(OLD.summary)
    expect(summary!.decisions.length + summary!.actionItems.length).toBeGreaterThan(0)
    expect(Date.parse((await meetingOf(id)).updatedAt)).toBeGreaterThan(Date.parse(before.updatedAt))
    expect(await transcriptOf(id)).toEqual(segments)
    expect(await db.getItem(`windows/${id}`)).toEqual(windows)

    const asked = await $fetch<{ answer: QuestionAnswer }>(`/api/meetings/${id}/ask`, {
      method: 'POST',
      body: { question: 'What does the placeholder stand in for?' },
    })
    expect(asked.answer.found).toBe(true)
  })

  it('refuses without the admin token, before it looks at the meeting, and writes nothing', async () => {
    const id = await finishedMeeting()
    const before = await everythingStored()
    for (const token of [null, '', 'wrong', `${ADMIN_TOKEN}x`]) {
      const res = await resummarize(id, token)
      expect(res.status).toBe(401)
      expect(res.headers.get('www-authenticate')).toBe('Bearer')
    }
    expect((await resummarize('00000000-0000-4000-8000-000000000000', 'wrong')).status).toBe(401)
    expect(await everythingStored()).toEqual(before)
  })

  it('refuses a meeting that is not finished with 409, and writes nothing', async () => {
    const id = await uploadedMeeting()
    const before = await everythingStored()
    const res = await resummarize(id)
    expect(res.status).toBe(409)
    expect((await res.json() as { message: string }).message).toMatch(/^Meeting is uploaded; only a ready meeting/)
    expect(await everythingStored()).toEqual(before)
    expect((await resummarize('00000000-0000-4000-8000-000000000000')).status).toBe(404)
  })

  it('refuses a meeting already being summarised again, so a second request starts nothing', async () => {
    const id = await finishedMeeting()
    expect((await resummarize(id)).status).toBe(202)
    const before = await everythingStored()
    expect((await resummarize(id)).status).toBe(409)
    expect(await everythingStored()).toEqual(before)
    await driveToDone(id)
  })

  it('is open on the public demo, whose own step routes stay refused', async () => {
    const id = await finishedMeeting()
    await startServer({ env: { NUXT_PUBLIC_DEMO_MEETING_ID: id } })
    const segments = await transcriptOf(id)

    const res = await resummarize(id.toUpperCase())
    expect(res.status).toBe(202)
    expect(await meetingOf(id)).toMatchObject({ status: 'indexing' })
    // No page drives it: the cron sweeper does.
    const refused = await advance(id)
    expect(refused.status).toBe(403)
    expect((await refused.json() as { message: string }).message).toBe(DEMO_READ_ONLY_MESSAGE)
    expect(await transcriptOf(id)).toEqual(segments)
  })

  it('does not exist with no admin token configured', async () => {
    const id = await finishedMeeting()
    await startServer({ env: { NUXT_ADMIN_TOKEN: '' } })
    const before = await everythingStored()
    expect((await resummarize(id)).status).toBe(404)
    expect((await resummarize(id, null)).status).toBe(404)
    expect(await everythingStored()).toEqual(before)
  })
})
