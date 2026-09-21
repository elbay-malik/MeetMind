import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { createStorage } from 'unstorage'
import fsDriver from 'unstorage/drivers/fs'
import { $fetch, fetch, setup } from '@nuxt/test-utils/e2e'
import { MAX_QUESTION_CHARS } from '../../shared/schemas/qa'
import type { CreateMeetingResponse, Meeting, MeetingSearchResult, TranscriptSegment } from '../../shared/types/meeting'

const rootDir = fileURLToPath(new URL('../..', import.meta.url))
const dataDir = await mkdtemp(join(tmpdir(), 'meetmind-search-'))

await setup({
  rootDir,
  build: false,
  nuxtConfig: { nitro: { output: { dir: join(rootDir, '.output') } } },
  env: { NUXT_DATA_DIR: dataDir, NUXT_UPLOAD_TOKEN_SECRET: 'e2e-secret' },
})

const audio = new Uint8Array(20_000).map((_, i) => i % 251)

async function indexedMeeting(title: string, segments: TranscriptSegment[]): Promise<Meeting> {
  const { meeting, upload } = await $fetch<CreateMeetingResponse>('/api/meetings', {
    method: 'POST',
    body: {
      title, sourceFileName: 'meeting.mp4', sourceBytes: 1_000_000,
      sourceMime: 'video/mp4', durationSec: 10, audioBytes: audio.byteLength,
    },
  })
  await fetch(upload.url, { method: 'PUT', headers: { 'content-type': 'audio/ogg' }, body: audio })
  await $fetch(`/api/meetings/${meeting.id}/complete`, { method: 'POST' })
  await $fetch(`/api/meetings/${meeting.id}/transcribe`, { method: 'POST' })

  // The stub transcriber's lines differ only by number, which gives
  // retrieval nothing to tell apart — replace with a distinctive transcript,
  // the same technique ask-api.spec.ts uses.
  const storage = createStorage({ driver: fsDriver({ base: join(dataDir, 'db') }) })
  await storage.setItem(`transcripts/${meeting.id}`, segments)

  await $fetch(`/api/meetings/${meeting.id}/search-index`, { method: 'POST' })
  return meeting
}

const filler = (tag: string) => Array.from({ length: 20 }, (_, i) => ({
  idx: i, startMs: i * 5_000, endMs: i * 5_000 + 4_800, text: `${tag} general update number ${i}`,
}))

const search = (q: string) => fetch(`/api/meetings/search?${new URLSearchParams({ q })}`)

describe('GET /api/meetings/search', () => {
  // First, deliberately: this is the one test in the file that needs a
  // genuinely empty corpus, which only holds before any other test in this
  // file has indexed a meeting into the shared dataDir. A query for a topic
  // this app has nothing indexed for, once other meetings exist, is a
  // different and much noisier question — the stub embedder's hashed-token
  // vectors are not a real relevance signal (its own doc comment says so),
  // so a handful of unrelated-vocabulary filler segments can still land a
  // stray positive cosine similarity by hash coincidence. That is exactly
  // what the similarity floor (ADR-0008 decision 6) is not trying to solve;
  // it is proven precisely, with a controlled vector, in
  // tests/unit/qa-search.spec.ts instead.
  it('returns an empty result list before anything has been indexed', async () => {
    const res = await search('anything at all')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ results: [] })
  })

  it('finds a passage in the right meeting and tags it with that meeting\'s title', async () => {
    const budget = await indexedMeeting('Budget review', [
      ...filler('budget'),
      { idx: 20, startMs: 100_000, endMs: 104_800, text: 'We agreed to cut the marketing budget by twenty percent.' },
    ])
    await indexedMeeting('Hiring roundup', [
      ...filler('hiring'),
      { idx: 20, startMs: 100_000, endMs: 104_800, text: 'Priya will interview two candidates for a design role.' },
    ])

    const res = await search('What did we decide about the marketing budget?')
    expect(res.status).toBe(200)
    const { results } = await res.json() as MeetingSearchResult

    const match = results.find(r => r.meetingId === budget.id)
    expect(match, 'the budget meeting should appear in the results').toBeDefined()
    expect(match!.meetingTitle).toBe('Budget review')
    expect(match!.quote).toContain('marketing budget')
    // The seek target is the retrieved WINDOW's own start (ADR-0008 decision
    // 5), which groups several segments — not necessarily segment 20 itself,
    // only at or before it.
    expect(match!.segmentIdx).toBeLessThanOrEqual(20)
    expect(match!.startMs).toBeLessThanOrEqual(100_000)
  })

  it('rejects malformed queries', async () => {
    for (const q of ['', '   ', '?!?', 'x'.repeat(MAX_QUESTION_CHARS + 1)]) {
      const res = await search(q)
      expect(res.status, `q=${JSON.stringify(q)}`).toBe(400)
    }
    // No q at all, and an unexpected extra param.
    expect((await fetch('/api/meetings/search')).status).toBe(400)
    expect((await fetch('/api/meetings/search?q=budget&extra=1')).status).toBe(400)
  })
})
