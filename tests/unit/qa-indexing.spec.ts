import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  dailyLimitReached,
  EMBEDDING_DIMENSIONS,
  MAX_BATCH_TOKENS,
  planEmbeddingBatches,
  type Embedder,
} from '../../server/utils/qa/embedder'
import { indexStatus } from '../../server/utils/qa/indexing'
import { INDEX_BATCH, type IndexingOutcome } from '../../server/utils/qa/steps'
import { hashedTokenVector, STUB_EMBEDDING_MODEL } from '../../server/utils/qa/stub'
import { planWindows } from '../../server/utils/qa/windows'
import { estimateTokens } from '../../server/utils/summary/plan'
import type { SearchIndexStatus, TranscriptSegment } from '../../shared/types/meeting'
import { indexingHarness } from './helpers/indexing'

/** `count` five-second segments with distinct words, so windows differ. */
const transcript = (count: number, tag = 't'): TranscriptSegment[] =>
  Array.from({ length: count }, (_, i) => ({
    idx: i, startMs: i * 5_000, endMs: i * 5_000 + 4_800, text: `${tag} segment ${i} discusses topic ${i}`,
  }))

/**
 * An embedder that records every text it is asked to embed, and can be told to
 * fail on a given call — the shape a quota running out partway takes.
 */
function recordingEmbedder(options: { model?: string, failOnCall?: number } = {}) {
  const calls: string[][] = []
  const embedder: Embedder = {
    kind: 'stub',
    model: options.model ?? 'model-a',
    dimensions: EMBEDDING_DIMENSIONS,
    async embedDocuments(texts) {
      calls.push(texts)
      if (calls.length === options.failOnCall) throw dailyLimitReached()
      return texts.map(t => hashedTokenVector(t))
    },
    async embedQuery(text) {
      return hashedTokenVector(text)
    },
  }
  return { embedder, calls, embeddedTexts: () => calls.flat() }
}

let dataDir: string
beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'meetmind-indexing-'))
})
afterAll(() => rm(dataDir, { recursive: true, force: true }))

const harness = indexingHarness(() => dataDir)
const repo = () => harness.repos().index
beforeEach(() => harness.resetClock())

/**
 * The whole index, step by step: a transcript the meeting holds, driven until it stops.
 * A refusal rejects with its status, as the route's would. What `indexMeeting` used to
 * do in one call, and these specs are its specs, moved onto the steps.
 */
async function indexTranscript(meetingId: string, segments: TranscriptSegment[], embedder: Embedder): Promise<SearchIndexStatus> {
  const { meetings, transcripts } = harness.repos()
  if (await meetings.get(meetingId)) await transcripts.replaceForMeeting(meetingId, segments)
  else await harness.meetingWith(meetingId, segments)
  const outcome = (await harness.drive(meetingId, harness.depsWith(embedder))).at(-1) as IndexingOutcome
  if (outcome.kind !== 'done') throw Object.assign(new Error(JSON.stringify(outcome)), outcome)
  return outcome.index
}

describe('indexStatus', () => {
  it('is none when nothing is stored', async () => {
    const plan = await planWindows(transcript(30))
    expect(indexStatus(plan, [], 'model-a')).toMatchObject({ state: 'none', indexedCount: 0, windowCount: plan.length })
  })

  it('is ready when every planned window is stored with its hash and model', async () => {
    const plan = await planWindows(transcript(30))
    const keys = plan.map(w => ({ idx: w.idx, contentHash: w.contentHash, model: 'model-a' }))
    expect(indexStatus(plan, keys, 'model-a')).toMatchObject({ state: 'ready', indexedCount: plan.length })
  })

  it('is incomplete when some windows are missing', async () => {
    const plan = await planWindows(transcript(30))
    const keys = plan.slice(0, 1).map(w => ({ idx: w.idx, contentHash: w.contentHash, model: 'model-a' }))
    expect(indexStatus(plan, keys, 'model-a')).toMatchObject({ state: 'incomplete', indexedCount: 1 })
  })

  it('is incomplete, not ready, when a stored hash no longer matches the transcript', async () => {
    const plan = await planWindows(transcript(30))
    const keys = plan.map(w => ({ idx: w.idx, contentHash: 'f'.repeat(64), model: 'model-a' }))
    expect(indexStatus(plan, keys, 'model-a')).toMatchObject({ state: 'incomplete', indexedCount: 0 })
  })

  it('reads an index from the 768-dimension stub as another model\'s, not as ready', async () => {
    // Its vectors cannot be compared with these: reading it as current would fail
    // the first question on the sizes, instead of offering to index again.
    const plan = await planWindows(transcript(30))
    const keys = plan.map(w => ({ idx: w.idx, contentHash: w.contentHash, model: 'stub-hashed-tokens-v1' }))
    expect(indexStatus(plan, keys, STUB_EMBEDDING_MODEL)).toMatchObject({ state: 'none', indexedCount: 0 })
  })

  it('does not count windows embedded by a different model', async () => {
    const plan = await planWindows(transcript(30))
    const keys = plan.map(w => ({ idx: w.idx, contentHash: w.contentHash, model: 'model-old' }))
    expect(indexStatus(plan, keys, 'model-a')).toMatchObject({ state: 'none', indexedCount: 0 })
  })

  it('is not ready while windows beyond a shorter transcript are still stored', async () => {
    // Search would still return them until indexing removes them.
    const plan = await planWindows(transcript(3))
    const keys = [
      ...plan.map(w => ({ idx: w.idx, contentHash: w.contentHash, model: 'model-a' })),
      { idx: 7, contentHash: 'e'.repeat(64), model: 'model-a' },
    ]
    expect(indexStatus(plan, keys, 'model-a').state).toBe('incomplete')
  })

  it('is ready, with zero windows, for a transcript with nothing in it', () => {
    expect(indexStatus([], [], 'model-a')).toEqual({ state: 'ready', windowCount: 0, indexedCount: 0, model: 'model-a' })
  })
})

describe('indexing a meeting, step by step', () => {
  it('embeds every planned window once and reports the index ready', async () => {
    const { embedder, embeddedTexts } = recordingEmbedder()
    const status = await indexTranscript('i1', transcript(30), embedder)
    const plan = await planWindows(transcript(30))
    expect(status).toEqual({ state: 'ready', windowCount: plan.length, indexedCount: plan.length, model: 'model-a' })
    expect(embeddedTexts()).toEqual(plan.map(w => w.text))
  })

  it('stores each window with its own vector, not a neighbour\'s', async () => {
    const { embedder } = recordingEmbedder()
    const store = repo()
    await indexTranscript('i-pairing', transcript(30), embedder)
    const plan = await planWindows(transcript(30))
    expect(plan.length).toBeGreaterThan(1)
    for (const window of plan) {
      const [nearest] = await store.search('i-pairing', hashedTokenVector(window.text), { model: 'model-a', limit: 1 })
      expect(nearest!.idx).toBe(window.idx)
    }
  })

  it('spends nothing on a second run over an unchanged transcript', async () => {
    const first = recordingEmbedder()
    await indexTranscript('i2', transcript(30), first.embedder)
    const second = recordingEmbedder()
    const status = await indexTranscript('i2', transcript(30), second.embedder)
    expect(second.calls).toHaveLength(0)
    expect(status.state).toBe('ready')
  })

  it('keeps what a quota failure interrupted, and resumes without re-embedding it', async () => {
    // Enough windows for three batches; the quota runs out on the second.
    const segments = transcript(INDEX_BATCH * 3 * 8, 'long')
    const plan = await planWindows(segments)
    expect(plan.length).toBeGreaterThan(INDEX_BATCH * 2)

    const interrupted = recordingEmbedder({ failOnCall: 2 })
    await expect(indexTranscript('i3', segments, interrupted.embedder))
      .rejects.toMatchObject({ statusCode: 429 })

    // The first batch was stored before the failure, not rolled back.
    const keys = await repo().listKeys('i3')
    expect(keys.map(k => k.idx)).toEqual(plan.slice(0, INDEX_BATCH).map(w => w.idx))

    harness.advanceClock(25 * 60 * 60 * 1000)
    await harness.db().removeItem('slots/workers-ai-embed')
    const resumed = recordingEmbedder()
    const status = await indexTranscript('i3', segments, resumed.embedder)
    // Only what was not already paid for.
    expect(resumed.embeddedTexts()).toEqual(plan.slice(INDEX_BATCH).map(w => w.text))
    expect(status).toMatchObject({ state: 'ready', indexedCount: plan.length })
  })

  it('stores a batch per request, bounded by tokens, and resumes from a failure there too', async () => {
    // Windows near the budget, where the token cap binds long before the count.
    const wordy = (i: number) => Array.from({ length: 500 }, (_, k) => `word${i}x${k}`).join(' ')
    const segments: TranscriptSegment[] = Array.from({ length: 30 }, (_, i) => ({
      idx: i, startMs: i * 5_000, endMs: i * 5_000 + 4_800, text: wordy(i),
    }))
    const plan = await planWindows(segments)
    const batches = planEmbeddingBatches(plan, w => w.text)
    expect(batches.length).toBeGreaterThan(2)
    expect(batches[0]!.length).toBeLessThan(INDEX_BATCH)

    const interrupted = recordingEmbedder({ failOnCall: 3 })
    await expect(indexTranscript('i9', segments, interrupted.embedder))
      .rejects.toMatchObject({ statusCode: 429 })

    // One embedder call per request, each within the cap.
    expect(interrupted.calls.map(c => c.length)).toEqual(batches.slice(0, 3).map(b => b.length))
    for (const call of interrupted.calls) {
      expect(call.reduce((sum, t) => sum + estimateTokens(t), 0)).toBeLessThanOrEqual(MAX_BATCH_TOKENS)
    }
    const stored = batches.slice(0, 2).flat().map(w => w.idx)
    expect((await repo().listKeys('i9')).map(k => k.idx)).toEqual(stored)

    harness.advanceClock(25 * 60 * 60 * 1000)
    await harness.db().removeItem('slots/workers-ai-embed')
    const resumed = recordingEmbedder()
    const status = await indexTranscript('i9', segments, resumed.embedder)
    expect(resumed.embeddedTexts()).toEqual(batches.slice(2).flat().map(w => w.text))
    expect(status).toMatchObject({ state: 'ready', indexedCount: plan.length })
  })

  it('re-embeds only the windows a replaced transcript changed', async () => {
    const original = transcript(40)
    await indexTranscript('i4', original, recordingEmbedder().embedder)

    const edited = original.map(s => s.idx === 35 ? { ...s, text: 'a completely different sentence was said here' } : s)
    const before = await planWindows(original)
    const after = await planWindows(edited)
    const changed = after.filter((w, i) => w.contentHash !== before[i]!.contentHash)
    expect(changed.length).toBeGreaterThan(0)
    expect(changed.length).toBeLessThan(after.length)

    const rerun = recordingEmbedder()
    const status = await indexTranscript('i4', edited, rerun.embedder)
    expect(rerun.embeddedTexts()).toEqual(changed.map(w => w.text))
    expect(status.state).toBe('ready')
  })

  it('removes windows a shorter transcript no longer has', async () => {
    await indexTranscript('i5', transcript(40), recordingEmbedder().embedder)
    const shorter = transcript(5)
    const status = await indexTranscript('i5', shorter, recordingEmbedder().embedder)
    const plan = await planWindows(shorter)
    expect((await repo().listKeys('i5')).map(k => k.idx)).toEqual(plan.map(w => w.idx))
    expect(status.state).toBe('ready')
  })

  it('replaces an index built with a different model rather than mixing the two', async () => {
    await indexTranscript('i6', transcript(30), recordingEmbedder({ model: 'model-old' }).embedder)
    const newer = recordingEmbedder({ model: 'model-a' })
    const status = await indexTranscript('i6', transcript(30), newer.embedder)
    const plan = await planWindows(transcript(30))
    expect(newer.embeddedTexts()).toHaveLength(plan.length)
    expect(new Set((await repo().listKeys('i6')).map(k => k.model))).toEqual(new Set(['model-a']))
    expect(status.state).toBe('ready')
  })

  it('clears the index for a transcript with nothing in it', async () => {
    await indexTranscript('i7', transcript(10), recordingEmbedder().embedder)
    const empty = recordingEmbedder()
    const status = await indexTranscript('i7', [], empty.embedder)
    expect(empty.calls).toHaveLength(0)
    expect(await repo().listKeys('i7')).toEqual([])
    expect(status).toMatchObject({ state: 'ready', windowCount: 0 })
  })
})
