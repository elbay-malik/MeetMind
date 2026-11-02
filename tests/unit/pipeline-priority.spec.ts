import { describe, expect, it } from 'vitest'
import type { Meeting, MeetingStatus } from '../../shared/types/meeting'
import type { PipelineRun, PipelineStage } from '../../server/utils/db/pipeline'
import type { IndexState } from '../../server/utils/db/windows'
import { DAILY_RESET_MARGIN_MS } from '../../server/utils/qa/embedder'
import { assessPipeline, LONGEST_INDEX_WAIT_MS, toPipelineResponse, type PipelineSnapshot } from '../../server/utils/pipeline/assess'
import { RETRY_COOLDOWN_MS, tooManyChunksMessage } from '../../server/utils/summary/steps'

/**
 * ADR-0012's step priority, row by row, ties included, as what stored state decides. The
 * table is a pure function so that each row can be read here without driving a meeting to
 * it: tests/unit/pipeline-advance.spec.ts drives real ones.
 */

const NOW = Date.parse('2026-11-03T12:00:00.000Z')
const at = (offsetMs: number) => new Date(NOW + offsetMs)
const MODEL = 'model-a'
const HASH = 'a'.repeat(64)
const OTHER_HASH = 'b'.repeat(64)
const LONG_AGO = at(-3_600_000).toISOString()

function meeting(status: MeetingStatus, patch: Partial<Meeting> = {}): Meeting {
  return {
    id: 'm', createdAt: LONG_AGO, updatedAt: LONG_AGO, title: 't', status, sourceFileName: 'f', sourceBytes: 1, sourceMime: null,
    durationSec: null, audioKey: 'k', audioBytes: 1, audioMime: 'audio/ogg', uploadedAt: LONG_AGO, errorMessage: null, failedStage: null, ...patch,
  }
}

const failed = (failedStage: Meeting['failedStage'], patch: Partial<Meeting> = {}) =>
  meeting('failed', { failedStage, errorMessage: 'it broke', ...patch })

function run(stage: PipelineStage, patch: Partial<PipelineRun> = {}): PipelineRun {
  return { stage, runId: `run-${stage}`, cursor: {}, stepLeaseUntil: null, attempts: 0, lastError: null, retryAt: null, ...patch }
}

const parked = (stage: PipelineStage, offsetMs: number) => run(stage, { retryAt: at(offsetMs) })
const live = (stage: PipelineStage, offsetMs = 60_000) => run(stage, { stepLeaseUntil: at(offsetMs) })

const index = {
  /** Nothing built: windows are pending. */
  none: { marker: null, transcriptHash: HASH, segmentCount: 10, storedWindows: 0, storedForModel: 0 },
  partial: { marker: { textHash: HASH, model: MODEL, windowCount: 0, complete: false }, transcriptHash: HASH, segmentCount: 10, storedWindows: 2, storedForModel: 2 },
  complete: { marker: { textHash: HASH, model: MODEL, windowCount: 3, complete: true }, transcriptHash: HASH, segmentCount: 10, storedWindows: 3, storedForModel: 3 },
  otherModel: { marker: { textHash: HASH, model: 'model-b', windowCount: 3, complete: true }, transcriptHash: HASH, segmentCount: 10, storedWindows: 3, storedForModel: 0 },
} satisfies Record<string, IndexState>

const SOME_CHUNKS = { done: 2, total: 5 }
const ALL_CHUNKS = { done: 5, total: 5 }
const NO_CHUNKS = { done: 0, total: 0 }

function assess(snapshot: Partial<PipelineSnapshot> & { meeting: Meeting }) {
  return assessPipeline({ runs: [], chunks: NO_CHUNKS, index: null, ...snapshot }, { model: MODEL, now: NOW })
}

/** Cooldown over and under, against a failure that long ago. */
const COOLED = at(-RETRY_COOLDOWN_MS - 1).toISOString()
const COOLING = at(-1_000).toISOString()

describe('the step priority, first match wins', () => {
  describe('row 1: a cooled-down failed stage', () => {
    it('retries transcription', () => {
      expect(assess({ meeting: failed('transcription', { updatedAt: COOLED }) }).step).toBe('transcription')
    })

    it('retries extraction', () => {
      expect(assess({ meeting: failed('summarization', { updatedAt: COOLED }), chunks: SOME_CHUNKS, index: index.complete }).step).toBe('extraction')
    })

    it('comes before an index batch that could also go', () => {
      expect(assess({ meeting: failed('summarization', { updatedAt: COOLED }), chunks: SOME_CHUNKS, index: index.none }).step).toBe('extraction')
    })

    it('is not there the moment before the cooldown ends, and is the moment it does', () => {
      const cooldown = (offsetMs: number) => failed('transcription', { updatedAt: at(-RETRY_COOLDOWN_MS + offsetMs).toISOString() })
      expect(assess({ meeting: cooldown(1) }).step).toBeNull()
      expect(assess({ meeting: cooldown(0) }).step).toBe('transcription')
    })

    it('waits out a provider block longer than the cooldown', () => {
      const snapshot = { meeting: failed('summarization', { updatedAt: COOLED }), runs: [parked('summarization', 30_000)], chunks: SOME_CHUNKS, index: index.complete }
      const { step, answer } = assess(snapshot)
      expect(step).toBeNull()
      expect(answer).toMatchObject({ next: 'failed', retryAt: at(30_000) })
    })
  })

  describe('row 2: transcription', () => {
    it.each<[string, Meeting]>([
      ['from uploaded', meeting('uploaded')],
      ['from transcribing', meeting('transcribing')],
    ])('takes a step %s', (_name, m) => {
      const { step, answer } = assess({ meeting: m })
      expect(step).toBe('transcription')
      expect(answer.next).toBe('continue')
    })

    it.each<[string, PipelineRun, Date]>([
      ['parked', parked('transcription', 5_000), at(5_000)],
      // A step in flight is usually over long before its lease is up.
      ['with a step in flight', live('transcription'), at(2_000)],
    ])('waits while it is %s', (_name, r, until) => {
      const { step, answer } = assess({ meeting: meeting('transcribing'), runs: [r] })
      expect(step).toBeNull()
      expect(answer).toMatchObject({ next: 'wait', retryAt: until })
    })
  })

  describe('row 3: a chunk, if its slot is free', () => {
    it.each<[string, MeetingStatus]>([['summarizing', 'summarizing'], ['indexing', 'indexing']])('goes from %s before an index batch that could also go', (_name, status) => {
      expect(assess({ meeting: meeting(status), chunks: SOME_CHUNKS, index: index.none }).step).toBe('extraction')
    })

    it('goes before an index batch that has already begun', () => {
      expect(assess({ meeting: meeting('indexing'), chunks: SOME_CHUNKS, index: index.partial }).step).toBe('extraction')
    })

    it.each<[string, PipelineRun]>([
      ['parked for a moment', parked('search_index', 1_000)],
      ['parked until the daily limit resets', parked('search_index', 8 * 3_600_000)],
      ['in flight', live('search_index')],
    ])('is not held up by an index %s', (_name, r) => {
      expect(assess({ meeting: meeting('indexing'), runs: [r], chunks: SOME_CHUNKS, index: index.partial }).step).toBe('extraction')
    })

    it('plans before any chunk, and that needs no slot', () => {
      expect(assess({ meeting: meeting('summarizing'), chunks: NO_CHUNKS, index: index.none }).step).toBe('extraction')
    })
  })

  describe('row 4: an index batch, if windows are pending', () => {
    it.each<[string, PipelineRun]>([
      ['parked on its slot', parked('summarization', 40_000)],
      ['in flight', live('summarization', 180_000)],
    ])('runs during extraction\'s gaps: a chunk %s', (_name, r) => {
      const { step, answer } = assess({ meeting: meeting('indexing'), runs: [r], chunks: SOME_CHUNKS, index: index.none })
      expect(step).toBe('indexing')
      expect(answer.next).toBe('continue')
    })

    it('goes before finalize', () => {
      expect(assess({ meeting: meeting('indexing'), chunks: ALL_CHUNKS, index: index.none }).step).toBe('indexing')
    })

    it('goes on a ready meeting', () => {
      expect(assess({ meeting: meeting('ready'), index: index.none }).step).toBe('indexing')
    })

    it('goes while a failure cools down, and a permanent failure does not stop it either', () => {
      expect(assess({ meeting: failed('summarization', { updatedAt: COOLING }), chunks: SOME_CHUNKS, index: index.none }).step).toBe('indexing')
      const tooLong = failed('summarization', { updatedAt: COOLED, errorMessage: tooManyChunksMessage(41) })
      expect(assess({ meeting: tooLong, index: index.none }).step).toBe('indexing')
    })

    it('never goes before a transcript is finished', () => {
      expect(assess({ meeting: failed('transcription', { updatedAt: COOLING }) }).step).toBeNull()
      expect(assess({ meeting: meeting('transcribing'), runs: [parked('transcription', 5_000)] }).step).toBeNull()
    })
  })

  describe('row 5: finalize', () => {
    it.each<[string, Partial<PipelineSnapshot>]>([
      ['complete', { index: index.complete }],
      ['parked for a moment', { index: index.partial, runs: [parked('search_index', 1_000)] }],
      ['parked until the limit resets', { index: index.partial, runs: [parked('search_index', 8 * 3_600_000)] }],
      ['in flight', { index: index.partial, runs: [live('search_index')] }],
      ['holding another model\'s work', { index: index.otherModel }],
      ['stopped by a refusal', { index: index.partial, runs: [run('search_index', { lastError: 'too long' })] }],
    ])('goes once every chunk is done and the index is %s', (_name, rest) => {
      const { step, answer } = assess({ meeting: meeting('indexing'), chunks: ALL_CHUNKS, ...rest })
      expect(step).toBe('extraction')
      expect(answer.next).toBe('continue')
    })

    it('does not go while a chunk has no result', () => {
      const { step, answer } = assess({ meeting: meeting('indexing'), runs: [parked('summarization', 40_000)], chunks: SOME_CHUNKS, index: index.complete })
      expect(step).toBeNull()
      expect(answer.next).toBe('wait')
    })
  })

  describe('row 6: otherwise wait until the earliest', () => {
    it.each<[string, number, number, number]>([
      ['the chunk is first', 3_000, 5_000, 3_000],
      ['the index is first', 5_000, 3_000, 3_000],
      ['they tie', 4_000, 4_000, 4_000],
    ])('when %s', (_name, chunkAt, indexAt, expected) => {
      const { step, answer } = assess({
        meeting: meeting('indexing'),
        runs: [parked('summarization', chunkAt), parked('search_index', indexAt)],
        chunks: SOME_CHUNKS,
        index: index.partial,
      })
      expect(step).toBeNull()
      expect(answer).toMatchObject({ next: 'wait', retryAt: at(expected) })
    })

    it('with a chunk parked and the index done', () => {
      const { answer } = assess({ meeting: meeting('indexing'), runs: [parked('summarization', 40_000)], chunks: SOME_CHUNKS, index: index.complete })
      expect(answer).toMatchObject({ next: 'wait', retryAt: at(40_000) })
    })

    it('never for hours while extraction is the question, with the index parked until the limit resets', () => {
      const { answer } = assess({
        meeting: meeting('indexing'),
        runs: [parked('summarization', 40_000), parked('search_index', 8 * 3_600_000)],
        chunks: SOME_CHUNKS,
        index: index.partial,
      })
      expect(answer).toMatchObject({ next: 'wait', retryAt: at(40_000) })
    })

    it('reports a step in flight at the next look, not at its lease\'s end', () => {
      const { answer } = assess({ meeting: meeting('indexing'), runs: [live('summarization', 180_000)], chunks: SOME_CHUNKS, index: index.complete })
      expect(answer).toMatchObject({ next: 'wait', retryAt: at(2_000) })
    })
  })
})

describe('when no step is left', () => {
  it('a ready meeting with a complete index is done', () => {
    const { step, answer } = assess({ meeting: meeting('ready'), index: index.complete })
    expect(step).toBeNull()
    expect(answer).toMatchObject({ next: 'done', retryAt: null, index: { state: 'complete', done: 3, total: 3 } })
  })

  it('a silent recording is done, with nothing to index', () => {
    const silent = { marker: null, transcriptHash: HASH, segmentCount: 0, storedWindows: 0, storedForModel: 0 }
    expect(assess({ meeting: meeting('ready'), index: silent }).answer).toMatchObject({ next: 'done', retryAt: null, index: { state: 'complete', done: 0, total: 0 } })
  })

  describe('with the index parked and nothing else to do', () => {
    const answerAfter = (ms: number) => assess({ meeting: meeting('ready'), runs: [parked('search_index', ms)], index: index.partial }).answer

    it('is done until then rather than sleeping for hours, and says when', () => {
      expect(answerAfter(8 * 3_600_000)).toMatchObject({
        next: 'done', retryAt: at(8 * 3_600_000), status: 'ready', index: { state: 'parked', retryAt: at(8 * 3_600_000) },
      })
    })

    it('waits out a short park', () => {
      expect(answerAfter(5_000)).toMatchObject({ next: 'wait', retryAt: at(5_000), index: { state: 'building' } })
    })

    it('draws the line where the longest wait ends, which covers a refusal just after the limit resets', () => {
      expect(LONGEST_INDEX_WAIT_MS).toBeGreaterThanOrEqual(DAILY_RESET_MARGIN_MS)
      expect(answerAfter(LONGEST_INDEX_WAIT_MS).next).toBe('wait')
      expect(answerAfter(LONGEST_INDEX_WAIT_MS + 1).next).toBe('done')
    })
  })

  describe('with an index nothing here may replace', () => {
    it.each<[string, IndexState]>([
      ['a finished index of another model', index.otherModel],
      ['a half-built index of another model', { marker: { textHash: HASH, model: 'model-b', windowCount: 0, complete: false }, transcriptHash: HASH, segmentCount: 10, storedWindows: 2, storedForModel: 0 }],
      ['a pass of another model that has stored nothing', { marker: { textHash: HASH, model: 'model-b', windowCount: 0, complete: false }, transcriptHash: HASH, segmentCount: 10, storedWindows: 0, storedForModel: 0 }],
      ['another model\'s windows and no marker, from before there were markers', { marker: null, transcriptHash: HASH, segmentCount: 10, storedWindows: 3, storedForModel: 0 }],
      ['windows of two models under a pass of this one', { marker: { textHash: HASH, model: MODEL, windowCount: 0, complete: false }, transcriptHash: HASH, segmentCount: 10, storedWindows: 3, storedForModel: 1 }],
      ['a finished index of another transcript', { marker: { textHash: OTHER_HASH, model: MODEL, windowCount: 3, complete: true }, transcriptHash: HASH, segmentCount: 10, storedWindows: 3, storedForModel: 3 }],
    ])('takes no index step for %s, and the meeting is still done', (_name, state) => {
      const { step, answer } = assess({ meeting: meeting('ready'), index: state })
      expect(step).toBeNull()
      expect(answer).toMatchObject({ next: 'done', retryAt: null, index: { state: 'held', done: 0, total: null } })
    })

    it.each<[string, IndexState]>([
      ['nothing built', index.none],
      ['a pass of this model under way', index.partial],
      ['this model\'s windows and no marker, from before there were markers', { marker: null, transcriptHash: HASH, segmentCount: 10, storedWindows: 3, storedForModel: 3 }],
      ['a pass of this model for a transcript since replaced', { marker: { textHash: OTHER_HASH, model: MODEL, windowCount: 0, complete: false }, transcriptHash: HASH, segmentCount: 10, storedWindows: 2, storedForModel: 2 }],
      ['a finished index of this model with a window gone', { marker: { textHash: HASH, model: MODEL, windowCount: 3, complete: true }, transcriptHash: HASH, segmentCount: 10, storedWindows: 2, storedForModel: 2 }],
    ])('still builds %s', (_name, state) => {
      expect(assess({ meeting: meeting('ready'), index: state }).step).toBe('indexing')
    })
  })

  it('an index stopped by a refusal is not asked again, and is not a failure', () => {
    const { step, answer } = assess({ meeting: meeting('ready'), runs: [run('search_index', { lastError: 'A passage is too long' })], index: index.partial })
    expect(step).toBeNull()
    expect(answer).toMatchObject({ next: 'done', retryAt: null, status: 'ready', index: { state: 'stopped' } })
  })

  it('a run whose park has passed goes again, its reason notwithstanding', () => {
    const { step } = assess({ meeting: meeting('ready'), runs: [run('search_index', { lastError: 'it broke', retryAt: at(-1) })], index: index.partial })
    expect(step).toBe('indexing')
  })

  describe('a failure', () => {
    it.each<[string, Meeting, IndexState | null]>([
      ['of transcription, cooling down', failed('transcription', { updatedAt: COOLING }), null],
      ['of extraction, cooling down, with the index complete', failed('summarization', { updatedAt: COOLING }), index.complete],
    ])('%s answers failed, and when a retry is allowed', (_name, m, state) => {
      const { step, answer } = assess({ meeting: m, index: state })
      expect(step).toBeNull()
      expect(answer).toMatchObject({ next: 'failed', status: 'failed', retryAt: new Date(Date.parse(m.updatedAt) + RETRY_COOLDOWN_MS) })
    })

    it('with the index still building for a moment waits for that, then answers failed', () => {
      const m = failed('summarization', { updatedAt: COOLING })
      expect(assess({ meeting: m, runs: [parked('search_index', 2_000)], index: index.partial }).answer).toMatchObject({ next: 'wait', retryAt: at(2_000) })
    })

    it.each<[string, Partial<PipelineSnapshot>]>([
      ['parked for hours', { runs: [parked('search_index', 8 * 3_600_000)], index: index.partial }],
      ['held', { index: index.otherModel }],
    ])('with the index %s answers failed, not done', (_name, rest) => {
      expect(assess({ meeting: failed('summarization', { updatedAt: COOLING }), ...rest }).answer.next).toBe('failed')
    })

    it.each<[string, Meeting]>([
      ['a transcript over the chunk limit', failed('summarization', { errorMessage: tooManyChunksMessage(41) })],
      ['audio gone from storage', failed('transcription', { errorMessage: 'The meeting audio is missing from storage' })],
      ['audio replaced in storage', failed('transcription', { errorMessage: 'Stored audio is 9 bytes, expected 10' })],
      ['an upload that was rejected', failed('upload', { errorMessage: 'rejected' })],
      ['no stage at all', failed(null)],
    ])('is permanent for %s: no retry, no time to come back, however long ago', (_name, m) => {
      const { step, answer } = assess({ meeting: m, index: m.failedStage === 'summarization' ? index.complete : null })
      expect(step).toBeNull()
      expect(answer).toMatchObject({ next: 'failed', retryAt: null })
    })

    it('answers the same for a message that only looks like a permanent one', () => {
      const looksLike = failed('summarization', { updatedAt: COOLED, errorMessage: `Provider said: ${tooManyChunksMessage(41)}` })
      expect(assess({ meeting: looksLike, chunks: SOME_CHUNKS, index: index.complete }).step).toBe('extraction')
    })
  })

  it('a meeting still pending its upload has nothing for a driver to do, and nothing to come back for', () => {
    const { step, answer } = assess({ meeting: meeting('pending_upload') })
    expect(step).toBeNull()
    expect(answer).toMatchObject({ next: 'wait', retryAt: null, progress: { stage: 'upload', done: 0, total: null } })
  })
})

describe('what is reported', () => {
  const reply = { reply: { byteOffset: 64_000, size: 128_000 } }
  const pass = (nextWindow: number, planned = false) => ({ pass: { textHash: HASH, model: MODEL, nextWindow, nextSegment: 0, pageSegments: 256, planned } })

  it.each<[string, Partial<PipelineSnapshot> & { meeting: Meeting }, { stage: string, done: number, total: number | null }]>([
    ['upload, while it is pending', { meeting: meeting('pending_upload') }, { stage: 'upload', done: 0, total: null }],
    ['upload, once it was rejected', { meeting: failed('upload') }, { stage: 'upload', done: 0, total: null }],
    ['transcription, before Whisper has answered', { meeting: meeting('uploaded') }, { stage: 'transcription', done: 0, total: null }],
    ['transcription, by bytes of the reply', { meeting: meeting('transcribing'), runs: [run('transcription', { cursor: reply })] }, { stage: 'transcription', done: 64_000, total: 128_000 }],
    ['transcription, once failed', { meeting: failed('transcription', { updatedAt: COOLING }), runs: [run('transcription', { cursor: reply })] }, { stage: 'transcription', done: 64_000, total: 128_000 }],
    ['extraction, before a plan', { meeting: meeting('summarizing') }, { stage: 'summarization', done: 0, total: null }],
    ['extraction, by chunks', { meeting: meeting('indexing'), chunks: SOME_CHUNKS }, { stage: 'summarization', done: 2, total: 5 }],
    ['extraction, once failed', { meeting: failed('summarization', { updatedAt: COOLING }), chunks: SOME_CHUNKS }, { stage: 'summarization', done: 2, total: 5 }],
    ['extraction, even with an index batch next', { meeting: meeting('indexing'), runs: [parked('summarization', 9_000), run('search_index', { cursor: pass(16) })], chunks: SOME_CHUNKS, index: index.partial }, { stage: 'summarization', done: 2, total: 5 }],
    ['the index on a ready meeting, with no total before the plan\'s end', { meeting: meeting('ready'), runs: [run('search_index', { cursor: pass(16) })], index: index.partial }, { stage: 'search_index', done: 16, total: null }],
    ['the index on a ready meeting, at the plan\'s end', { meeting: meeting('ready'), runs: [run('search_index', { cursor: pass(20, true) })], index: index.partial }, { stage: 'search_index', done: 20, total: 20 }],
    ['the index when it is complete', { meeting: meeting('ready'), index: index.complete }, { stage: 'search_index', done: 3, total: 3 }],
    ['nothing of another transcript\'s pass', { meeting: meeting('ready'), runs: [run('search_index', { cursor: { pass: { ...pass(16).pass, textHash: OTHER_HASH } } })], index: index.partial }, { stage: 'search_index', done: 0, total: null }],
    ['nothing of another model\'s pass', { meeting: meeting('ready'), runs: [run('search_index', { cursor: { pass: { ...pass(16).pass, model: 'model-b' } } })], index: index.otherModel }, { stage: 'search_index', done: 0, total: null }],
  ])('%s', (_name, snapshot, figures) => {
    expect(assess(snapshot).answer.progress).toEqual({ ...figures, etaSeconds: null })
  })

  it('counts the index alongside while extraction is the stage', () => {
    const { answer } = assess({ meeting: meeting('indexing'), runs: [run('search_index', { cursor: pass(16) })], chunks: SOME_CHUNKS, index: index.partial })
    expect(answer.index).toEqual({ state: 'building', done: 16, total: null, retryAt: null })
  })

  it('has nothing to say of an index before the transcript is finished', () => {
    expect(assess({ meeting: meeting('uploaded') }).answer.index).toEqual({ state: 'unavailable', done: 0, total: null, retryAt: null })
  })

  it('goes over the wire as the shape the ADR gives and nothing else, with the wait measured on the server', () => {
    const assessed = assess({ meeting: meeting('indexing'), runs: [parked('summarization', 40_000)], chunks: SOME_CHUNKS, index: index.complete })
    expect(toPipelineResponse(assessed, NOW)).toEqual({
      status: 'indexing',
      progress: { stage: 'summarization', done: 2, total: 5, etaSeconds: null },
      index: { state: 'complete', done: 3, total: 3, retryAt: null },
      next: 'wait',
      retryAt: at(40_000).toISOString(),
      retryAfterMs: 40_000,
    })
  })

  it('never reports a negative wait, whatever the clock has done since', () => {
    const wire = toPipelineResponse(assess({ meeting: meeting('indexing'), runs: [parked('summarization', 40_000)], chunks: SOME_CHUNKS, index: index.complete }), NOW + 90_000)
    expect(wire.retryAfterMs).toBe(0)
  })

  it('reports no time at all when there is none', () => {
    const wire = toPipelineResponse(assess({ meeting: meeting('ready'), index: index.complete }), NOW)
    expect(wire).toMatchObject({ retryAt: null, retryAfterMs: null, next: 'done' })
  })
})
