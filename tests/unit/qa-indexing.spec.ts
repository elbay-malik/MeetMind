import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createLocalTranscriptIndexRepository } from '../../server/utils/db/windows-local'
import {
  EmbeddingError,
  MAX_BATCH,
  MAX_BATCH_TOKENS,
  planEmbeddingBatches,
  type Embedder,
} from '../../server/utils/qa/embedder'
import { indexMeeting, indexStatus } from '../../server/utils/qa/indexing'
import { hashedTokenVector } from '../../server/utils/qa/stub'
import { planWindows } from '../../server/utils/qa/windows'
import { estimateTokens } from '../../server/utils/summary/plan'
import type { TranscriptSegment } from '../../shared/types/meeting'

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
    dimensions: 768,
    async embedDocuments(texts) {
      calls.push(texts)
      if (calls.length === options.failOnCall) throw new EmbeddingError('Embedding quota is exhausted for now.', 429, false)
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

const repo = () => createLocalTranscriptIndexRepository({ dataDir })

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

describe('indexMeeting', () => {
  it('embeds every planned window once and reports the index ready', async () => {
    const { embedder, embeddedTexts } = recordingEmbedder()
    const status = await indexMeeting({ meetingId: 'i1', segments: transcript(30), embedder, repo: repo() })
    const plan = await planWindows(transcript(30))
    expect(status).toEqual({ state: 'ready', windowCount: plan.length, indexedCount: plan.length, model: 'model-a' })
    expect(embeddedTexts()).toEqual(plan.map(w => w.text))
  })

  it('spends nothing on a second run over an unchanged transcript', async () => {
    const first = recordingEmbedder()
    await indexMeeting({ meetingId: 'i2', segments: transcript(30), embedder: first.embedder, repo: repo() })
    const second = recordingEmbedder()
    const status = await indexMeeting({ meetingId: 'i2', segments: transcript(30), embedder: second.embedder, repo: repo() })
    expect(second.calls).toHaveLength(0)
    expect(status.state).toBe('ready')
  })

  it('keeps what a quota failure interrupted, and resumes without re-embedding it', async () => {
    // Enough windows for three batches; the quota runs out on the second.
    const segments = transcript(MAX_BATCH * 3 * 8, 'long')
    const plan = await planWindows(segments)
    expect(plan.length).toBeGreaterThan(MAX_BATCH * 2)

    const interrupted = recordingEmbedder({ failOnCall: 2 })
    await expect(indexMeeting({ meetingId: 'i3', segments, embedder: interrupted.embedder, repo: repo() }))
      .rejects.toMatchObject({ statusCode: 429 })

    // The first batch was stored before the failure, not rolled back.
    const keys = await repo().listKeys('i3')
    expect(keys.map(k => k.idx)).toEqual(plan.slice(0, MAX_BATCH).map(w => w.idx))

    const resumed = recordingEmbedder()
    const status = await indexMeeting({ meetingId: 'i3', segments, embedder: resumed.embedder, repo: repo() })
    // Only what was not already paid for.
    expect(resumed.embeddedTexts()).toEqual(plan.slice(MAX_BATCH).map(w => w.text))
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
    expect(batches[0]!.length).toBeLessThan(MAX_BATCH)

    const interrupted = recordingEmbedder({ failOnCall: 3 })
    await expect(indexMeeting({ meetingId: 'i9', segments, embedder: interrupted.embedder, repo: repo() }))
      .rejects.toMatchObject({ statusCode: 429 })

    // One embedder call per request, each within the cap.
    expect(interrupted.calls.map(c => c.length)).toEqual(batches.slice(0, 3).map(b => b.length))
    for (const call of interrupted.calls) {
      expect(call.reduce((sum, t) => sum + estimateTokens(t), 0)).toBeLessThanOrEqual(MAX_BATCH_TOKENS)
    }
    const stored = batches.slice(0, 2).flat().map(w => w.idx)
    expect((await repo().listKeys('i9')).map(k => k.idx)).toEqual(stored)

    const resumed = recordingEmbedder()
    const status = await indexMeeting({ meetingId: 'i9', segments, embedder: resumed.embedder, repo: repo() })
    expect(resumed.embeddedTexts()).toEqual(batches.slice(2).flat().map(w => w.text))
    expect(status).toMatchObject({ state: 'ready', indexedCount: plan.length })
  })

  it('re-embeds only the windows a replaced transcript changed', async () => {
    const original = transcript(40)
    await indexMeeting({ meetingId: 'i4', segments: original, embedder: recordingEmbedder().embedder, repo: repo() })

    const edited = original.map(s => s.idx === 35 ? { ...s, text: 'a completely different sentence was said here' } : s)
    const before = await planWindows(original)
    const after = await planWindows(edited)
    const changed = after.filter((w, i) => w.contentHash !== before[i]!.contentHash)
    expect(changed.length).toBeGreaterThan(0)
    expect(changed.length).toBeLessThan(after.length)

    const rerun = recordingEmbedder()
    const status = await indexMeeting({ meetingId: 'i4', segments: edited, embedder: rerun.embedder, repo: repo() })
    expect(rerun.embeddedTexts()).toEqual(changed.map(w => w.text))
    expect(status.state).toBe('ready')
  })

  it('removes windows a shorter transcript no longer has', async () => {
    await indexMeeting({ meetingId: 'i5', segments: transcript(40), embedder: recordingEmbedder().embedder, repo: repo() })
    const shorter = transcript(5)
    const status = await indexMeeting({ meetingId: 'i5', segments: shorter, embedder: recordingEmbedder().embedder, repo: repo() })
    const plan = await planWindows(shorter)
    expect((await repo().listKeys('i5')).map(k => k.idx)).toEqual(plan.map(w => w.idx))
    expect(status.state).toBe('ready')
  })

  it('replaces an index built with a different model rather than mixing the two', async () => {
    await indexMeeting({ meetingId: 'i6', segments: transcript(30), embedder: recordingEmbedder({ model: 'model-old' }).embedder, repo: repo() })
    const newer = recordingEmbedder({ model: 'model-a' })
    const status = await indexMeeting({ meetingId: 'i6', segments: transcript(30), embedder: newer.embedder, repo: repo() })
    const plan = await planWindows(transcript(30))
    expect(newer.embeddedTexts()).toHaveLength(plan.length)
    expect(new Set((await repo().listKeys('i6')).map(k => k.model))).toEqual(new Set(['model-a']))
    expect(status.state).toBe('ready')
  })

  it('clears the index for a transcript with nothing in it', async () => {
    await indexMeeting({ meetingId: 'i7', segments: transcript(10), embedder: recordingEmbedder().embedder, repo: repo() })
    const empty = recordingEmbedder()
    const status = await indexMeeting({ meetingId: 'i7', segments: [], embedder: empty.embedder, repo: repo() })
    expect(empty.calls).toHaveLength(0)
    expect(await repo().listKeys('i7')).toEqual([])
    expect(status).toMatchObject({ state: 'ready', windowCount: 0 })
  })
})
