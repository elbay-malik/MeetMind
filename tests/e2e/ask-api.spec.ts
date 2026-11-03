import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { createStorage } from 'unstorage'
import fsDriver from 'unstorage/drivers/fs'
import { $fetch, fetch, setup } from '@nuxt/test-utils/e2e'
import { MAX_QUESTION_CHARS } from '../../shared/schemas/qa'
import type { CreateMeetingResponse, Meeting, PublicMeeting, QuestionAnswer, TranscriptSegment } from '../../shared/types/meeting'
import { driveIndexing } from './helpers/indexing'
import { driveTranscription } from './helpers/transcribe'
import { INVITE_CODE, inviteHeaders } from './helpers/invite'
import { LOCAL_DRIVERS } from './helpers/local-drivers'

const rootDir = fileURLToPath(new URL('../..', import.meta.url))
const dataDir = await mkdtemp(join(tmpdir(), 'meetmind-ask-'))

await setup({
  rootDir,
  build: false,
  nuxtConfig: { nitro: { output: { dir: join(rootDir, '.output') } } },
  // The gap between embedding requests would make a first step answer "wait" with
  // nothing stored, depending on what the test before it did.
  env: { ...LOCAL_DRIVERS, NUXT_DATA_DIR: dataDir, NUXT_UPLOAD_TOKEN_SECRET: 'e2e-secret', NUXT_INVITE_CODE: INVITE_CODE, NUXT_EMBED_INTERVAL_MS: '0' },
})

const audio = new Uint8Array(20_000).map((_, i) => i % 251)

async function uploadedMeeting(): Promise<PublicMeeting> {
  const { meeting, upload } = await $fetch<CreateMeetingResponse>('/api/meetings', {
    method: 'POST',
    headers: inviteHeaders,
    body: {
      title: 'Ask test', sourceFileName: 'meeting.mp4', sourceBytes: 1_000_000,
      sourceMime: 'video/mp4', durationSec: 10, audioBytes: audio.byteLength,
    },
  })
  await fetch(upload.url, { method: 'PUT', headers: { 'content-type': 'audio/ogg' }, body: audio })
  return (await $fetch<{ meeting: PublicMeeting }>(`/api/meetings/${meeting.id}/complete`, { method: 'POST' })).meeting
}

/**
 * The stub transcriber's lines differ only by number, which gives retrieval
 * nothing to tell apart. Replace the stored transcript with one that has a
 * distinctive exchange to find.
 */
const DISCUSSION: TranscriptSegment[] = Array.from({ length: 40 }, (_, i) => ({
  idx: i,
  startMs: i * 5_000,
  endMs: i * 5_000 + 4_800,
  text: i === 22
    ? 'We agreed to cut the marketing budget by twenty percent next quarter.'
    : `general update number ${i} with nothing notable`,
}))

async function setStoredTranscript(meetingId: string, segments: TranscriptSegment[]): Promise<void> {
  const storage = createStorage({ driver: fsDriver({ base: join(dataDir, 'db') }) })
  await storage.setItem(`transcripts/${meetingId}`, segments)
}

async function indexedMeeting(): Promise<Meeting> {
  const meeting = await uploadedMeeting()
  await driveTranscription(meeting.id)
  await setStoredTranscript(meeting.id, DISCUSSION)
  await driveIndexing(meeting.id)
  return meeting
}

const ask = (id: string, question: string) => fetch(`/api/meetings/${id}/ask`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ question }),
})

describe('POST /api/meetings/:id/ask', () => {
  it('answers with a citation that really is the meeting\'s line, at its real time', async () => {
    const meeting = await indexedMeeting()
    const res = await ask(meeting.id, 'What did we decide about the marketing budget?')
    expect(res.status).toBe(200)
    const { answer } = await res.json() as { answer: QuestionAnswer }

    expect(answer.found).toBe(true)
    if (!answer.found) return
    expect(answer.answer).not.toBe('')
    expect(answer.citations.length).toBeGreaterThan(0)
    // Every citation checked against what the transcript route itself serves.
    const { segments } = await $fetch<{ segments: TranscriptSegment[] }>(`/api/meetings/${meeting.id}/transcript`)
    for (const citation of answer.citations) {
      const line = segments.find(s => s.idx === citation.segmentIdx)
      expect(line, `cited line ${citation.segmentIdx} does not exist`).toBeDefined()
      expect(citation.startMs).toBe(line!.startMs)
      expect(line!.text).toContain(citation.quote)
    }
    expect(answer.citations.map(c => c.segmentIdx)).toContain(22)
  })

  it('reports not found, with no answer at all, when nothing retrieved supports one', async () => {
    const meeting = await indexedMeeting()
    const res = await ask(meeting.id, 'Which vendors bid for the office lease?')
    expect(res.status).toBe(200)
    expect((await res.json()).answer).toEqual({ found: false, answer: null, citations: [] })
  })

  it('asks for indexing first rather than failing, before a meeting is indexed', async () => {
    const meeting = await uploadedMeeting()
    await driveTranscription(meeting.id)
    const res = await ask(meeting.id, 'What about the budget?')
    expect(res.status).toBe(409)
    expect((await res.json()).message).toMatch(/not been indexed/)
  })

  it('refuses to answer from an index the transcript has since outgrown', async () => {
    const meeting = await indexedMeeting()
    await setStoredTranscript(meeting.id, DISCUSSION.map(s =>
      s.idx === 22 ? { ...s, text: 'We agreed to keep the marketing budget unchanged.' } : s))
    const res = await ask(meeting.id, 'What did we decide about the marketing budget?')
    expect(res.status).toBe(409)
    expect((await res.json()).message).toMatch(/Index it again/)
  })

  // ADR-0012 step 8: the marker decides, not what happens to be stored.
  it('refuses while the index is part-way, and answers once it is finished', async () => {
    const meeting = await uploadedMeeting()
    await driveTranscription(meeting.id)
    await setStoredTranscript(meeting.id, Array.from({ length: 300 }, (_, i) => ({
      idx: i,
      startMs: i * 5_000,
      endMs: i * 5_000 + 4_800,
      text: i === 22 ? 'We agreed to cut the marketing budget by twenty percent next quarter.' : `general update number ${i} with nothing notable`,
    })))
    const first = await fetch(`/api/meetings/${meeting.id}/search-index`, { method: 'POST' })
    expect(first.status).toBe(202)

    // The windows this question would find are stored by now. It is refused anyway.
    const refused = await ask(meeting.id, 'What did we decide about the marketing budget?')
    expect(refused.status).toBe(409)
    expect((await refused.json()).message).toMatch(/incomplete or out of date/)

    await driveIndexing(meeting.id)
    expect((await ask(meeting.id, 'What did we decide about the marketing budget?')).status).toBe(200)
  })

  it('refuses with every window stored, until the last step has said so', async () => {
    const meeting = await uploadedMeeting()
    await driveTranscription(meeting.id)
    await setStoredTranscript(meeting.id, DISCUSSION)
    // One batch holds all of this transcript's windows; the step after it finishes.
    const batch = await fetch(`/api/meetings/${meeting.id}/search-index`, { method: 'POST' })
    expect(batch.status).toBe(202)
    const { index: { windowCount } } = await $fetch<{ index: { windowCount: number } }>(`/api/meetings/${meeting.id}/search-index`)
    expect(((await batch.json()) as { progress: { done: number } }).progress.done).toBe(windowCount)

    expect((await ask(meeting.id, 'What did we decide about the marketing budget?')).status).toBe(409)
    const last = await fetch(`/api/meetings/${meeting.id}/search-index`, { method: 'POST' })
    expect(last.status).toBe(200)
    expect((await ask(meeting.id, 'What did we decide about the marketing budget?')).status).toBe(200)
  })

  it('refuses a meeting with no finished transcript', async () => {
    const meeting = await uploadedMeeting()
    const res = await ask(meeting.id, 'What about the budget?')
    expect(res.status).toBe(409)
    expect((await res.json()).message).toMatch(/no finished transcript/)
  })

  it('rejects malformed questions', async () => {
    const meeting = await indexedMeeting()
    for (const body of [
      {},
      { question: '' },
      { question: '   ' },
      { question: 'x'.repeat(MAX_QUESTION_CHARS + 1) },
      { question: 'What about the budget?', extra: true },
    ]) {
      const res = await fetch(`/api/meetings/${meeting.id}/ask`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      })
      expect(res.status, JSON.stringify(body).slice(0, 60)).toBe(400)
    }
    // Words, but none that embed: punctuation alone.
    expect((await ask(meeting.id, '?!?')).status).toBe(400)
  })

  it('refuses a body far larger than a question before reading it', async () => {
    const meeting = await indexedMeeting()
    const res = await fetch(`/api/meetings/${meeting.id}/ask`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ question: 'x'.repeat(10_000) }),
    })
    expect(res.status).toBe(413)
  })

  it('404s for unknown and malformed ids', async () => {
    expect((await ask('9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d', 'q?')).status).toBe(404)
    expect((await ask('not-a-uuid', 'q?')).status).toBe(404)
  })
})
