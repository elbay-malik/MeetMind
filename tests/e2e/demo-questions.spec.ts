import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeEach, describe, expect, it } from 'vitest'
import { createStorage } from 'unstorage'
import fsDriver from 'unstorage/drivers/fs'
import { $fetch, fetch, setup, startServer } from '@nuxt/test-utils/e2e'
import type { SlotState } from '../../server/utils/db/slots'
import type { CreateMeetingResponse, Meeting, QuestionAnswer, TranscriptSegment } from '../../shared/types/meeting'
import { DEMO_QUESTIONS_PAUSED_MESSAGE, DEMO_QUESTIONS_USED_MESSAGE } from '../../shared/utils/meeting'
import { tooManyChunksMessage } from '../../server/utils/summary/steps'
import { driveIndexing } from './helpers/indexing'
import { driveTranscription } from './helpers/transcribe'
import { INVITE_CODE, inviteHeaders } from './helpers/invite'
import { LOCAL_DRIVERS } from './helpers/local-drivers'

/**
 * ADR-0019, over the real HTTP route of a real build. Its own file for the slot ledger: a paced
 * stub, as in ask-busy-api.spec.ts, so a held slot can be staged by writing the ledger.
 */
const rootDir = fileURLToPath(new URL('../..', import.meta.url))
const dataDir = await mkdtemp(join(tmpdir(), 'meetmind-demo-questions-'))
const MAX_WAIT_MS = 500
const LIMIT = 2

await setup({
  rootDir,
  build: false,
  nuxtConfig: { nitro: { output: { dir: join(rootDir, '.output') } } },
  env: {
    ...LOCAL_DRIVERS,
    NUXT_DATA_DIR: dataDir,
    NUXT_UPLOAD_TOKEN_SECRET: 'e2e-secret',
    NUXT_INVITE_CODE: INVITE_CODE,
    NUXT_ANSWER_STUB_PACED: 'true',
    NUXT_GROQ_CHAT_INTERVAL_MS: '0',
    NUXT_ASK_MAX_SLOT_WAIT_MS: String(MAX_WAIT_MS),
    NUXT_DEMO_QUESTIONS_PER_DAY: String(LIMIT),
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

async function indexedMeeting(title: string): Promise<string> {
  const { meeting, upload } = await $fetch<CreateMeetingResponse>('/api/meetings', {
    method: 'POST',
    headers: inviteHeaders,
    body: { title, sourceFileName: 'meeting.mp4', sourceBytes: 1_000_000, sourceMime: 'video/mp4', durationSec: 10, audioBytes: audio.byteLength },
  })
  await fetch(upload.url, { method: 'PUT', headers: { 'content-type': 'audio/ogg' }, body: audio })
  await $fetch(`/api/meetings/${meeting.id}/complete`, { method: 'POST' })
  await driveTranscription(meeting.id)
  await db.setItem(`transcripts/${meeting.id}`, DISCUSSION)
  await driveIndexing(meeting.id)
  // Finished, as extraction would leave it: until then it counts as extraction pending.
  const row = await db.getItem<Meeting>(`meetings/${meeting.id}`)
  await db.setItem(`meetings/${meeting.id}`, { ...row!, status: 'ready' })
  return meeting.id
}

const ask = (id: string) => fetch(`/api/meetings/${id}/ask`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ question: 'What did we decide about the marketing budget?' }),
})

interface Refused { statusMessage: string, message: string, data: { retryAt: string, retryAfterSec: number } }

const today = () => new Date().toISOString().slice(0, 10)
const countToday = async () => (await db.getItem<number>(`demo-questions/${today()}`)) ?? 0
const nextMidnight = () => {
  const now = new Date()
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1))
}

async function expectUsed(res: Response) {
  expect(res.status).toBe(429)
  const body = await res.json() as Refused
  expect(body.message).toBe(DEMO_QUESTIONS_USED_MESSAGE)
  expect(body.statusMessage).toBe('Answering failed')
  expect(Date.parse(body.data.retryAt)).toBe(nextMidnight().getTime())
  expect(Number(res.headers.get('retry-after'))).toBe(body.data.retryAfterSec)
  expect(body.data.retryAfterSec).toBeGreaterThan(0)
  expect(body.data.retryAfterSec).toBeLessThanOrEqual(86_400)
}

async function expectPaused(res: Response) {
  expect(res.status).toBe(429)
  const body = await res.json() as Refused
  expect(body.message).toBe(DEMO_QUESTIONS_PAUSED_MESSAGE)
  expect(body.data.retryAfterSec).toBeGreaterThanOrEqual(59)
  expect(body.data.retryAfterSec).toBeLessThanOrEqual(60)
  expect(Number(res.headers.get('retry-after'))).toBe(body.data.retryAfterSec)
}

/** A meeting left in this state, and put back afterwards. */
async function withMeetingIn(id: string, state: Pick<Meeting, 'status' | 'failedStage'> & Partial<Pick<Meeting, 'errorMessage'>>, work: () => Promise<void>) {
  const row = await db.getItem<Meeting>(`meetings/${id}`)
  await db.setItem(`meetings/${id}`, { ...row!, ...state })
  try {
    await work()
  }
  finally {
    await db.setItem(`meetings/${id}`, row as never)
  }
}

describe('questions on the public demo', () => {
  let demoId = ''
  let otherId = ''

  /** A fresh day and a free slot before each. */
  beforeEach(async () => {
    if (!demoId) return
    await db.removeItem(`demo-questions/${today()}`)
    await db.setItem<SlotState>('slots/groq-chat', { nextAvailableAt: 0, blockedUntil: 0 })
  })

  it('counts nothing before it is named the demo, as every meeting is free of the cap', async () => {
    demoId = await indexedMeeting('The demo')
    otherId = await indexedMeeting('Someone else\'s')
    for (let i = 0; i < LIMIT + 1; i++) expect((await ask(demoId)).status).toBe(200)
    expect(await countToday()).toBe(0)
    await startServer({ env: { NUXT_PUBLIC_DEMO_MEETING_ID: demoId } })
  })

  it('answers up to the day\'s count, and then refuses until the next 00:00 UTC', async () => {
    for (let i = 0; i < LIMIT; i++) {
      const res = await ask(demoId)
      expect(res.status).toBe(200)
      expect((await res.json() as { answer: QuestionAnswer }).answer.found).toBe(true)
    }
    expect(await countToday()).toBe(LIMIT)
    await expectUsed(await ask(demoId))
    await expectUsed(await ask(demoId))
    expect(await countToday()).toBe(LIMIT)
  })

  it('takes the same count for its id in capitals, which reaches the same row', async () => {
    expect((await ask(demoId.toUpperCase())).status).toBe(200)
    expect(await countToday()).toBe(1)
    await db.setItem(`demo-questions/${today()}`, LIMIT)
    await expectUsed(await ask(demoId.toUpperCase()))
  })

  it('leaves every other meeting\'s questions as they were, over the count, and writes it nothing', async () => {
    await db.setItem(`demo-questions/${today()}`, LIMIT)
    for (let i = 0; i < LIMIT + 2; i++) expect((await ask(otherId)).status).toBe(200)
    expect(await countToday()).toBe(LIMIT)
  })

  it('refuses over the count without reserving a slot', async () => {
    await db.setItem(`demo-questions/${today()}`, LIMIT)
    const before = await db.getItem<SlotState>('slots/groq-chat')
    await db.setItem<SlotState>('slots/groq-chat', { ...before!, nextAvailableAt: 1 })
    await ask(demoId)
    expect((await db.getItem<SlotState>('slots/groq-chat'))!.nextAvailableAt).toBe(1)
  })

  it('leaves the day\'s count alone when a loop is refused its slot, and the question after it still answers', async () => {
    const heldUntil = Date.now() + 2_000
    await db.setItem<SlotState>('slots/groq-chat', { nextAvailableAt: heldUntil, blockedUntil: 0 })
    for (let i = 0; i < 12; i++) {
      const res = await ask(demoId)
      expect(res.status).toBe(429)
      expect((await res.json() as Refused).message).toMatch(/cannot take another question/)
    }
    expect(await countToday()).toBe(0)
    await db.setItem<SlotState>('slots/groq-chat', { nextAvailableAt: 0, blockedUntil: 0 })
    expect((await ask(demoId)).status).toBe(200)
    expect(await countToday()).toBe(1)
  })

  it('counts a question only once it has its slot, so waiting for one takes it after', async () => {
    const freeAt = Date.now() + 300
    await db.setItem<SlotState>('slots/groq-chat', { nextAvailableAt: freeAt, blockedUntil: 0 })
    const res = await ask(demoId)
    expect(res.status).toBe(200)
    expect(Date.now()).toBeGreaterThanOrEqual(freeAt)
    expect(await countToday()).toBe(1)
  })

  it.each<[string, Pick<Meeting, 'status' | 'failedStage'>]>([
    ['summarizing', { status: 'summarizing', failedStage: null }],
    ['indexing', { status: 'indexing', failedStage: null }],
    ['failed in extraction', { status: 'failed', failedStage: 'summarization' }],
  ])('refuses while another meeting is %s, for about a minute, reserving and counting nothing', async (_name, state) => {
    await withMeetingIn(otherId, state, async () => {
      await db.setItem<SlotState>('slots/groq-chat', { nextAvailableAt: 1, blockedUntil: 0 })
      await expectPaused(await ask(demoId))
      expect((await db.getItem<SlotState>('slots/groq-chat'))!.nextAvailableAt).toBe(1)
      expect(await countToday()).toBe(0)
    })
    expect((await ask(demoId)).status).toBe(200)
  })

  it.each<[string, Pick<Meeting, 'status' | 'failedStage'>]>([
    ['uploaded', { status: 'uploaded', failedStage: null }],
    ['transcribing', { status: 'transcribing', failedStage: null }],
    ['failed in transcription', { status: 'failed', failedStage: 'transcription' }],
  ])('goes on while another meeting is only %s, which is not extraction', async (_name, state) => {
    await withMeetingIn(otherId, state, async () => {
      expect((await ask(demoId)).status).toBe(200)
    })
  })

  // The limit ADR-0019 writes down: no retry gets this row anywhere, and it pauses the demo all the same.
  it('refuses for a meeting refused as too long as well, and goes on refusing however old it is', async () => {
    const stopped = { status: 'failed', failedStage: 'summarization', errorMessage: tooManyChunksMessage(41), updatedAt: new Date(Date.now() - 30 * 86_400_000).toISOString() } as Parameters<typeof withMeetingIn>[1]
    await withMeetingIn(otherId, stopped, async () => {
      await expectPaused(await ask(demoId))
    })
    expect((await ask(demoId)).status).toBe(200)
  })

  it('still asks another meeting while an extraction is pending on a third', async () => {
    const third = await indexedMeeting('Extracting')
    await withMeetingIn(third, { status: 'summarizing', failedStage: null }, async () => {
      expect((await ask(otherId)).status).toBe(200)
    })
  })

  it('does not hold itself up with its own row', async () => {
    await withMeetingIn(demoId, { status: 'failed', failedStage: 'summarization' }, async () => {
      expect((await ask(demoId)).status).toBe(200)
    })
  })

  it.each([['zero', '0'], ['blank', ''], ['a word', 'lots'], ['a fraction', '2.5'], ['less than nothing', '-1'], ['the word null', 'null'], ['the word undefined', 'undefined'], ['either word in capitals, with spaces', ' NULL ']])('refuses every demo question with the setting %s, and no other meeting\'s', async (_name, value) => {
    await startServer({ env: { NUXT_PUBLIC_DEMO_MEETING_ID: demoId, NUXT_DEMO_QUESTIONS_PER_DAY: value } })
    await expectUsed(await ask(demoId))
    expect(await countToday()).toBe(0)
    expect((await ask(otherId)).status).toBe(200)
  })

  it('has its default without the setting', async () => {
    await startServer({ env: { NUXT_PUBLIC_DEMO_MEETING_ID: demoId, NUXT_DEMO_QUESTIONS_PER_DAY: undefined as unknown as string } })
    expect((await ask(demoId)).status).toBe(200)
    await db.setItem(`demo-questions/${today()}`, 25)
    await expectUsed(await ask(demoId))
    await db.setItem(`demo-questions/${today()}`, 24)
    expect((await ask(demoId)).status).toBe(200)
  })
})
