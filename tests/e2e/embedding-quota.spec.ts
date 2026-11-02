import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeEach, describe, expect, it } from 'vitest'
import { createStorage } from 'unstorage'
import fsDriver from 'unstorage/drivers/fs'
import { $fetch, fetch, setup } from '@nuxt/test-utils/e2e'
import type { CreateMeetingResponse, Meeting, PipelineResponse, QuestionAnswer, SearchIndexStatus, TranscriptSegment } from '../../shared/types/meeting'
import { DAILY_RESET_MARGIN_MS } from '../../server/utils/qa/embedder'
import { indexUntilStopped } from './helpers/indexing'
import { driveTranscription } from './helpers/transcribe'
import { INVITE_CODE, inviteHeaders } from './helpers/invite'

// Isolated from search-index-api.spec.ts for its one setting: with this canary set,
// the stub embedder refuses any text holding it exactly as the real provider refuses
// once its daily allocation is spent (ADR-0014).
const rootDir = fileURLToPath(new URL('../..', import.meta.url))
const dataDir = await mkdtemp(join(tmpdir(), 'meetmind-embedding-quota-'))
const CANARY = 'QUOTACANARY'

await setup({
  rootDir,
  build: false,
  nuxtConfig: { nitro: { output: { dir: join(rootDir, '.output') } } },
  env: {
    NUXT_DATA_DIR: dataDir,
    NUXT_UPLOAD_TOKEN_SECRET: 'e2e-secret',
    NUXT_INVITE_CODE: INVITE_CODE,
    NUXT_EMBED_STUB_QUOTA_CANARY: CANARY,
    // These are about the limit, not the gap between requests.
    NUXT_EMBED_INTERVAL_MS: '0',
  },
})

const db = createStorage({ driver: fsDriver({ base: join(dataDir, 'db') }) })

/** The block one test's refusal leaves is the account's, and would hold off the next. */
beforeEach(() => db.removeItem('slots/workers-ai-embed'))

const audio = new Uint8Array(20_000).map((_, i) => i % 251)

async function transcribedMeeting(): Promise<Meeting> {
  const { meeting, upload } = await $fetch<CreateMeetingResponse>('/api/meetings', {
    method: 'POST',
    headers: inviteHeaders,
    body: {
      title: 'Quota test', sourceFileName: 'meeting.mp4', sourceBytes: 1_000_000,
      sourceMime: 'video/mp4', durationSec: 10, audioBytes: audio.byteLength,
    },
  })
  await fetch(upload.url, { method: 'PUT', headers: { 'content-type': 'audio/ogg' }, body: audio })
  await $fetch(`/api/meetings/${meeting.id}/complete`, { method: 'POST' })
  return (await driveTranscription(meeting.id)).meeting
}

async function setStoredTranscript(meetingId: string, segments: TranscriptSegment[]): Promise<void> {
  const storage = createStorage({ driver: fsDriver({ base: join(dataDir, 'db') }) })
  await storage.setItem(`transcripts/${meetingId}`, segments)
}

/** Long segments, so the windows fill several requests and a late one can fail. */
const wordy = (i: number) => Array.from({ length: 500 }, (_, k) => `word${i}x${k}`).join(' ')
const longTranscript = (last: string): TranscriptSegment[] => Array.from({ length: 40 }, (_, i) => ({
  idx: i, startMs: i * 5_000, endMs: i * 5_000 + 4_800, text: i === 39 ? last : wordy(i),
}))

const status = async (id: string) =>
  (await $fetch<{ index: SearchIndexStatus }>(`/api/meetings/${id}/search-index`)).index
const index = indexUntilStopped
const oneStep = (id: string) => fetch(`/api/meetings/${id}/search-index`, { method: 'POST' })

/** Past 00:00 UTC, as far as this meeting's run and the account's block can tell. */
async function theDayAfter(id: string): Promise<void> {
  await db.removeItem('slots/workers-ai-embed')
  const ledger = await db.getItem<{ runs: { search_index: { retryAt: number | null } } }>(`pipeline/${id}`)
  ledger!.runs.search_index.retryAt = Date.now() - 1_000
  await db.setItem(`pipeline/${id}`, ledger)
}
const ask = (id: string, question: string) => fetch(`/api/meetings/${id}/ask`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ question }),
})

interface Refusal { statusCode: number, message: string, data?: { retryAt: string, retryAfterSec: number } }

/** The next 00:00 UTC, the same way a visitor would work it out, unless this runs just after one. */
const nextReset = () => {
  const now = new Date()
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  return now.getTime() - today < DAILY_RESET_MARGIN_MS
    ? today + DAILY_RESET_MARGIN_MS
    : Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1)
}

function expectTheDailyLimit(response: Response, body: Refusal) {
  // Not a generic 502, and not a page: a plain sentence, and when.
  expect(response.status).toBe(429)
  expect(response.headers.get('content-type')).toMatch(/json/)
  expect(body.message).toMatch(/free daily limit.*reached.*resets at 00:00 UTC/)
  expect(Date.parse(body.data!.retryAt)).toBe(nextReset())
  const seconds = Number(response.headers.get('retry-after'))
  expect(seconds).toBeGreaterThan(0)
  expect(seconds).toBeLessThanOrEqual(24 * 60 * 60)
  expect(body.data!.retryAfterSec).toBe(seconds)
}

describe('the provider\'s daily limit', () => {
  it('stops indexing with a plain message, keeps what was stored, and indexing again resumes', async () => {
    const meeting = await transcribedMeeting()
    await setStoredTranscript(meeting.id, longTranscript(`the last line, holding ${CANARY}`))

    const refused = await index(meeting.id)
    const body = await refused.json() as Refusal
    expectTheDailyLimit(refused, body)
    expect(body.message).toMatch(/kept; indexing again resumes/)

    // The requests before the failing one are stored, and the status says how far.
    const partial = await status(meeting.id)
    expect(partial.state).toBe('incomplete')
    expect(partial.indexedCount).toBeGreaterThan(0)
    expect(partial.indexedCount).toBeLessThan(partial.windowCount)

    // The run is parked until then, not just refused: asked again, it says the same
    // and goes no further, and the meeting has not moved either way (ADR-0012 §5).
    const again = await oneStep(meeting.id)
    expectTheDailyLimit(again, await again.json() as Refusal)
    expect(await status(meeting.id)).toEqual(partial)
    expect((await $fetch<{ meeting: Meeting }>(`/api/meetings/${meeting.id}`)).meeting)
      .toMatchObject({ status: meeting.status, errorMessage: null })

    // The day after, as far as the provider is concerned.
    await setStoredTranscript(meeting.id, longTranscript('the last line, as it really was'))
    await theDayAfter(meeting.id)
    const resumed = await index(meeting.id)
    expect(resumed.status).toBe(200)
    expect((await resumed.json() as { index: SearchIndexStatus }).index)
      .toMatchObject({ state: 'ready', indexedCount: partial.windowCount })
  })

  it('reaches a question the same way, and does not break the page or the next question', async () => {
    const meeting = await transcribedMeeting()
    await setStoredTranscript(meeting.id, longTranscript('a line nobody minds'))
    expect((await index(meeting.id)).status).toBe(200)

    const refused = await ask(meeting.id, `What about ${CANARY}?`)
    expectTheDailyLimit(refused, await refused.json() as Refusal)

    expect((await fetch(`/meetings/${meeting.id}`)).status).toBe(200)
    expect((await fetch(`/meetings/${meeting.id}/progress`)).status).toBe(200)
    // Once the provider takes a text again, nothing here is holding on to the refusal.
    const answered = await ask(meeting.id, 'What about the line nobody minds?')
    expect(answered.status).toBe(200)
    expect((await answered.json() as { answer: QuestionAnswer }).answer).toHaveProperty('found')
  })
})

describe('POST .../advance at the daily limit', () => {
  it('finishes the meeting and answers done with when to come back, not failed, not hours of waiting', async () => {
    const meeting = await transcribedMeeting()
    await setStoredTranscript(meeting.id, longTranscript(`the last line, holding ${CANARY}`))
    const advance = () => fetch(`/api/meetings/${meeting.id}/advance`, { method: 'POST' })

    let answer: PipelineResponse | null = null
    for (let i = 0; i < 100 && answer?.next !== 'done' && answer?.next !== 'failed'; i++) {
      const res = await advance()
      expect(res.status).toBe(200)
      answer = await res.json() as PipelineResponse
      if (answer.next === 'wait') await new Promise(resolve => setTimeout(resolve, Math.min(answer!.retryAfterMs ?? 0, 2_000) + 20))
    }

    expect(answer).toMatchObject({ status: 'ready', next: 'done', index: { state: 'parked' } })
    expect(Date.parse(answer!.retryAt!)).toBe(nextReset())
    expect(answer!.index.retryAt).toBe(answer!.retryAt)
    // No sentence, and nothing else a provider or database said.
    expect(Object.keys(answer!).sort()).toEqual(['index', 'next', 'progress', 'retryAfterMs', 'retryAt', 'status'])

    const row = (await $fetch<{ meeting: Meeting }>(`/api/meetings/${meeting.id}`)).meeting
    expect(row).toMatchObject({ status: 'ready', errorMessage: null, failedStage: null })
    expect((await status(meeting.id)).state).toBe('incomplete')

    // A read says the same. Asked again, it stays so, with no block moved.
    expect(await $fetch<PipelineResponse>(`/api/meetings/${meeting.id}/pipeline`)).toMatchObject({ status: 'ready', next: 'done', retryAt: answer!.retryAt })
    const again = await advance()
    expect(again.status).toBe(200)
    expect(await again.json()).toMatchObject({ next: 'done', retryAt: answer!.retryAt })

    // The day after, whoever opens it next finishes the rest.
    await setStoredTranscript(meeting.id, longTranscript('the last line, as it really was'))
    await theDayAfter(meeting.id)
    for (let i = 0; i < 100; i++) {
      answer = await (await advance()).json() as PipelineResponse
      if (answer.next === 'done') break
      if (answer.next === 'wait') await new Promise(resolve => setTimeout(resolve, Math.min(answer!.retryAfterMs ?? 0, 2_000) + 20))
    }
    expect(answer).toMatchObject({ status: 'ready', next: 'done', retryAt: null, index: { state: 'complete' } })
  })
})

describe('a passage over the model\'s limit', () => {
  it('fails clearly, does not promise that trying again helps, and loses no text', async () => {
    const meeting = await transcribedMeeting()
    // A single segment, which is never split, of about 8,400 estimated tokens.
    const huge = Array.from({ length: 6_000 }, (_, i) => `word${i}`).join(' ')
    await setStoredTranscript(meeting.id, [{ idx: 0, startMs: 0, endMs: 60_000, text: huge }])

    const refused = await index(meeting.id)
    expect(refused.status).toBe(422)
    const body = await refused.json() as Refusal
    expect(body.message).toMatch(/too long to index for questions/)
    expect(body.message).toMatch(/transcript and summary are not affected/)
    expect(body.message).not.toMatch(/resumes/)
    expect(refused.headers.get('retry-after')).toBeNull()

    expect(await status(meeting.id)).toMatchObject({ state: 'none', indexedCount: 0, windowCount: 1 })
    // The transcript still holds every word.
    const { segments } = await $fetch<{ segments: TranscriptSegment[] }>(`/api/meetings/${meeting.id}/transcript`)
    expect(segments[0]!.text).toBe(huge)
  })
})
