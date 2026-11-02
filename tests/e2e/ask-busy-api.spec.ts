import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { createStorage } from 'unstorage'
import fsDriver from 'unstorage/drivers/fs'
import { $fetch, fetch, setup } from '@nuxt/test-utils/e2e'
import type { SlotState } from '../../server/utils/db/slots'
import type { CreateMeetingResponse, Meeting, QuestionAnswer, TranscriptSegment } from '../../shared/types/meeting'
import { driveTranscription } from './helpers/transcribe'
import { INVITE_CODE, inviteHeaders } from './helpers/invite'

// Isolated from ask-api.spec.ts: NUXT_ANSWER_STUB_PACED puts every question on
// the slot ledger, which the other file's tests have no reason to wait on.
// The wait is cut from 20 s to 1 s, and the interval to nothing, so a held slot
// is staged by writing the ledger rather than by a real extraction.
const rootDir = fileURLToPath(new URL('../..', import.meta.url))
const dataDir = await mkdtemp(join(tmpdir(), 'meetmind-ask-busy-'))
const MAX_WAIT_MS = 1000

await setup({
  rootDir,
  build: false,
  nuxtConfig: { nitro: { output: { dir: join(rootDir, '.output') } } },
  env: {
    NUXT_DATA_DIR: dataDir,
    NUXT_UPLOAD_TOKEN_SECRET: 'e2e-secret',
    NUXT_INVITE_CODE: INVITE_CODE,
    NUXT_ANSWER_STUB_PACED: 'true',
    NUXT_GROQ_CHAT_INTERVAL_MS: '0',
    NUXT_ASK_MAX_SLOT_WAIT_MS: String(MAX_WAIT_MS),
  },
})

const db = createStorage({ driver: fsDriver({ base: join(dataDir, 'db') }) })
const audio = new Uint8Array(20_000).map((_, i) => i % 251)

const DISCUSSION: TranscriptSegment[] = Array.from({ length: 40 }, (_, i) => ({
  idx: i,
  startMs: i * 5_000,
  endMs: i * 5_000 + 4_800,
  text: i === 22
    ? 'We agreed to cut the marketing budget by twenty percent next quarter.'
    : `general update number ${i} with nothing notable`,
}))

async function indexedMeeting(): Promise<Meeting> {
  const { meeting, upload } = await $fetch<CreateMeetingResponse>('/api/meetings', {
    method: 'POST',
    headers: inviteHeaders,
    body: {
      title: 'Busy ask test', sourceFileName: 'meeting.mp4', sourceBytes: 1_000_000,
      sourceMime: 'video/mp4', durationSec: 10, audioBytes: audio.byteLength,
    },
  })
  await fetch(upload.url, { method: 'PUT', headers: { 'content-type': 'audio/ogg' }, body: audio })
  await $fetch(`/api/meetings/${meeting.id}/complete`, { method: 'POST' })
  await driveTranscription(meeting.id)
  await db.setItem(`transcripts/${meeting.id}`, DISCUSSION)
  await $fetch(`/api/meetings/${meeting.id}/search-index`, { method: 'POST' })
  return meeting
}

/** Stage the shared Groq slot as another request (or a provider 429) left it. */
const holdSlot = (state: SlotState) => db.setItem<SlotState>('slots/groq-chat', state)

const ask = (id: string) => fetch(`/api/meetings/${id}/ask`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ question: 'What did we decide about the marketing budget?' }),
})

const sleepUntil = (at: number) => new Promise(resolve => setTimeout(resolve, Math.max(0, at - Date.now())))

describe('POST /api/meetings/:id/ask while the answering slot is held', () => {
  it('refuses with a 429 and Retry-After past its wait, then answers once that time comes', async () => {
    const meeting = await indexedMeeting()
    const freeAt = Date.now() + 3_000
    await holdSlot({ nextAvailableAt: freeAt, blockedUntil: 0 })

    const started = Date.now()
    const refused = await ask(meeting.id)
    expect(refused.status).toBe(429)
    // Refused at once: a slot past the wait is not waited for.
    expect(Date.now() - started).toBeLessThan(MAX_WAIT_MS)
    const seconds = Number(refused.headers.get('retry-after'))
    expect(seconds).toBeGreaterThanOrEqual(2)
    expect(seconds).toBeLessThanOrEqual(3)
    const body = await refused.json() as { message: string, data: { retryAt: string, retryAfterSec: number } }
    expect(Date.parse(body.data.retryAt)).toBe(freeAt)
    expect(body.data.retryAfterSec).toBe(seconds)
    expect(body.message).toMatch(/busy/)

    await sleepUntil(Date.parse(body.data.retryAt))
    const answered = await ask(meeting.id)
    expect(answered.status).toBe(200)
    const { answer } = await answered.json() as { answer: QuestionAnswer }
    expect(answer.found).toBe(true)
  })

  it('waits for a slot that frees inside its wait, and answers', async () => {
    const meeting = await indexedMeeting()
    const freeAt = Date.now() + 500
    await holdSlot({ nextAvailableAt: freeAt, blockedUntil: 0 })

    const res = await ask(meeting.id)
    expect(res.status).toBe(200)
    expect(Date.now()).toBeGreaterThanOrEqual(freeAt)
  })

  it('refuses while the provider\'s own Retry-After holds every caller off', async () => {
    const meeting = await indexedMeeting()
    const blockedUntil = Date.now() + 60_000
    await holdSlot({ nextAvailableAt: 0, blockedUntil })

    const res = await ask(meeting.id)
    expect(res.status).toBe(429)
    expect(Number(res.headers.get('retry-after'))).toBeGreaterThanOrEqual(59)
    const body = await res.json() as { data: { retryAt: string } }
    expect(Date.parse(body.data.retryAt)).toBe(blockedUntil)
  })
})
