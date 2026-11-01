import { describe, expect, it } from 'vitest'
import { closePlan, EMPTY_PLAN, estimateTokens, extendPlan, planChunks, type IncrementalPlan } from '../../server/utils/summary/plan'
import type { TranscriptSegment } from '../../shared/types/meeting'

const seg = (idx: number, words: number): TranscriptSegment => ({
  idx, startMs: idx * 5000, endMs: idx * 5000 + 4000, text: Array.from({ length: words }, () => 'word').join(' '),
})

describe('estimateTokens', () => {
  it('scales with word count', () => {
    expect(estimateTokens('one two three')).toBeGreaterThan(estimateTokens('one'))
  })

  it('over-estimates rather than under, so a chunk that fits the estimate fits the budget', () => {
    // English is roughly 1.35 tokens per word; anything below that risks a 429.
    const words = 100
    expect(estimateTokens(Array.from({ length: words }, () => 'word').join(' '))).toBeGreaterThan(words * 1.3)
  })

  it('costs empty and whitespace-only text nothing', () => {
    // Was `>= 0`, which only rules out NaN: deleting the empty-text guard made
    // this cost 4 tokens (the fixed overhead) and it still passed.
    expect(estimateTokens('')).toBe(0)
    expect(estimateTokens('   ')).toBe(0)
  })

  it('scales with character count for scripts with no whitespace between words', () => {
    // Japanese has no spaces between words. Splitting on whitespace alone
    // collapses a long utterance into a single "word" and costs it a
    // handful of tokens no matter how long it really is — a 200-character
    // sentence would price out at Math.ceil(1 * 1.4) + 4 = 6 tokens, the same
    // as a single character. A character-based estimate must scale instead.
    const long = 'あ'.repeat(200)
    expect(estimateTokens(long)).toBeGreaterThan(100)
  })

  it('does not let a long CJK segment cost the same as a short one', () => {
    expect(estimateTokens('あ'.repeat(200))).toBeGreaterThan(estimateTokens('あ') * 10)
  })

  it('detects Han characters outside the Basic Multilingual Plane, not just the common BMP range', () => {
    // U+20000 is a real (if uncommon) Han ideograph, a supplementary-plane
    // character a hand-rolled range copied from a BMP-only chart silently
    // excludes — collapsing right back to the ~6-token bug for exactly the
    // kind of character this detection exists to catch.
    const supplementaryHan = String.fromCodePoint(0x20000).repeat(200)
    expect(estimateTokens(supplementaryHan)).toBeGreaterThan(100)
  })

  it('prices EVERY no-space script per character, not just the CJK ones', () => {
    // The detector listed Han/Hiragana/Katakana/Thai only. Khmer, Lao,
    // Burmese and Tibetan are written without spaces between words too, and
    // Whisper transcribes all of them — so each collapsed to a single
    // whitespace-delimited "word" and priced at 6 tokens however long it was.
    // Measured before the fix: one hour of Thai planned to 9 chunks and the
    // same volume of Khmer to 1, carrying identical character counts.
    const perScript = {
      Thai: 'ก',
      Khmer: 'ក',
      Lao: 'ກ',
      Burmese: 'က',
      Tibetan: 'ཀ',
      Japanese: 'あ',
      Chinese: '中',
    }
    for (const [script, character] of Object.entries(perScript)) {
      const long = character.repeat(200)
      expect(estimateTokens(long), `${script} must be priced per character`).toBeGreaterThan(100)
    }
  })

  it('cannot under-price a long run of text that simply has no spaces in it', () => {
    // The general form of the bug above, and the safety net for the script
    // list being incomplete AGAIN: whitespace-delimited counting prices any
    // single unbroken run as one word, so 5,000 characters cost 6 tokens
    // whatever script they are in. A per-character floor makes an unlisted
    // script inaccurate rather than catastrophic.
    const runOn = 'x'.repeat(5000)
    expect(estimateTokens(runOn)).toBeGreaterThan(1000)
    expect(estimateTokens('x'.repeat(10_000))).toBeGreaterThan(estimateTokens(runOn))
  })

  it('still prices ordinary spaced prose by its words, not the floor', () => {
    // The floor must not quietly become the estimator for English, which
    // would over-chunk every ordinary meeting and multiply the request count
    // the chunk budget exists to hold down.
    const english = Array.from({ length: 100 }, () => 'word').join(' ')
    expect(estimateTokens(english)).toBe(Math.ceil(100 * 1.4) + 4)
  })
})

describe('planChunks', () => {
  it('keeps a short transcript in one chunk', () => {
    const chunks = planChunks([seg(0, 10), seg(1, 10)], 1000)
    expect(chunks).toHaveLength(1)
    expect(chunks[0]!.segments).toHaveLength(2)
  })

  it('splits when the budget is exceeded', () => {
    const chunks = planChunks(Array.from({ length: 20 }, (_, i) => seg(i, 50)), 200)
    expect(chunks.length).toBeGreaterThan(1)
  })

  it('never splits inside a segment', () => {
    const segments = Array.from({ length: 12 }, (_, i) => seg(i, 40))
    const chunks = planChunks(segments, 150)
    const seen = chunks.flatMap(c => c.segments.map(s => s.idx))
    expect(seen).toEqual(segments.map(s => s.idx))
  })

  it('loses no segment and duplicates none', () => {
    const segments = Array.from({ length: 57 }, (_, i) => seg(i, 30))
    const chunks = planChunks(segments, 120)
    const seen = chunks.flatMap(c => c.segments.map(s => s.idx))
    expect(seen).toEqual(segments.map(s => s.idx))
    expect(new Set(seen).size).toBe(segments.length)
  })

  it('keeps chunks in transcript order with contiguous spans', () => {
    const chunks = planChunks(Array.from({ length: 30 }, (_, i) => seg(i, 40)), 200)
    for (let i = 1; i < chunks.length; i++) {
      expect(chunks[i]!.startMs).toBeGreaterThan(chunks[i - 1]!.startMs)
      expect(chunks[i]!.segments[0]!.idx).toBe(chunks[i - 1]!.segments.at(-1)!.idx + 1)
    }
  })

  it('gives an over-budget segment its own chunk rather than dropping transcript', () => {
    const chunks = planChunks([seg(0, 5), seg(1, 5000), seg(2, 5)], 100)
    const seen = chunks.flatMap(c => c.segments.map(s => s.idx))
    expect(seen).toEqual([0, 1, 2])
    expect(chunks.find(c => c.segments.some(s => s.idx === 1))!.segments).toHaveLength(1)
  })

  it('reports a span covering its segments', () => {
    const chunks = planChunks([seg(0, 5), seg(1, 5)], 1000)
    expect(chunks[0]!.startMs).toBe(0)
    expect(chunks[0]!.endMs).toBe(9000)
  })

  it('returns nothing for an empty transcript', () => {
    expect(planChunks([], 1000)).toEqual([])
  })

  it('refuses a nonsensical budget instead of looping', () => {
    expect(() => planChunks([seg(0, 5)], 0)).toThrow(/positive/)
    expect(() => planChunks([seg(0, 5)], Number.NaN)).toThrow(/positive/)
  })

  it('splits a one-hour transcript, which is why this exists', () => {
    // About 8,400 words at 140 wpm — over the per-minute token allowance in a
    // single request, and reachable with the repository's own 1-hour fixture.
    const hour = Array.from({ length: 660 }, (_, i) => seg(i, 13))
    const chunks = planChunks(hour, 6000)
    expect(chunks.length).toBeGreaterThan(1)
    for (const chunk of chunks) expect(chunk.estimatedTokens).toBeLessThanOrEqual(6000)
  })

  it('splits a long CJK transcript instead of treating every segment as ~6 tokens', () => {
    // No spaces between words, so a whitespace-only estimator would cost every
    // segment here about 6 tokens flat and never split at all — silently
    // defeating the budget for exactly the languages this exists to cover.
    const segments = Array.from({ length: 50 }, (_, i) => ({
      idx: i, startMs: i * 5000, endMs: i * 5000 + 4000, text: 'あ'.repeat(100),
    }))
    const chunks = planChunks(segments, 500)
    expect(chunks.length).toBeGreaterThan(1)
  })
})

describe('the incremental plan (ADR-0012 §2)', () => {
  const BUDGET = 100

  /** A small deterministic generator, so a failure reproduces. */
  function random(seed: number) {
    let state = seed
    return (max: number) => {
      state = (state * 1103515245 + 12345) & 0x7FFFFFFF
      return state % max
    }
  }

  function transcript(seed: number, length: number): TranscriptSegment[] {
    const next = random(seed)
    return Array.from({ length }, (_, idx) => ({
      idx,
      startMs: idx * 1000,
      endMs: idx * 1000 + 900,
      // Mostly small lines, with the odd one at or over the budget on its own.
      text: Array.from({ length: next(10) === 0 ? 40 + next(120) : 1 + next(20) }, () => 'word').join(' '),
    }))
  }

  function asRanges(segments: TranscriptSegment[]) {
    return planChunks(segments, BUDGET).map(c => ({
      segFrom: c.segments[0]!.idx,
      segTo: c.segments.at(-1)!.idx,
      estTokens: c.estimatedTokens,
    }))
  }

  function incremental(segments: TranscriptSegment[], pageSizes: () => number) {
    let plan: IncrementalPlan = EMPTY_PLAN
    for (let at = 0; at < segments.length;) {
      const size = pageSizes()
      plan = extendPlan(plan, segments.slice(at, at + size), BUDGET, 1000)
      at += size
    }
    return closePlan(plan, 1000)
  }

  it('equals planChunks however the transcript is split into pages', () => {
    for (let seed = 1; seed <= 40; seed++) {
      const segments = transcript(seed, 300)
      const expected = asRanges(segments)
      expect(expected.length, 'the case has several chunks').toBeGreaterThan(3)
      const pages = random(seed * 7)
      for (const pageSizes of [() => 1, () => 100, () => 1 + pages(37), () => 1000]) {
        const { count, chunks } = incremental(segments, pageSizes)
        expect(chunks).toEqual(expected)
        expect(count).toBe(expected.length)
      }
    }
  })

  it('plans nothing for no segments, and tolerates pages with none', () => {
    expect(closePlan(EMPTY_PLAN, 40)).toEqual({ count: 0, chunks: [] })
    expect(closePlan(extendPlan(EMPTY_PLAN, [], BUDGET, 40), 40)).toEqual({ count: 0, chunks: [] })
  })

  it('gives a segment over budget a chunk of its own, as planChunks does', () => {
    const line = (idx: number, words: number) => ({ idx, startMs: idx, endMs: idx, text: Array.from({ length: words }, () => 'w').join(' ') })
    const segments = [line(0, 5), line(1, 500), line(2, 5)]
    expect(incremental(segments, () => 1).chunks).toEqual(asRanges(segments))
    expect(asRanges(segments)).toHaveLength(3)
  })

  it('stops retaining ranges past the limit, so the cursor does not grow with the meeting, and keeps counting', () => {
    const segments = transcript(3, 2000)
    const total = asRanges(segments).length
    expect(total).toBeGreaterThan(5)
    let plan = EMPTY_PLAN
    for (let at = 0; at < segments.length; at += 100) {
      plan = extendPlan(plan, segments.slice(at, at + 100), BUDGET, 5)
      expect(plan.chunks.length).toBeLessThanOrEqual(5)
    }
    expect(closePlan(plan, 5).count).toBe(total)
  })

  it('counts the open chunk when closing but does not retain it past the limit', () => {
    const range = (n: number) => ({ segFrom: n, segTo: n, estTokens: 1 })
    const atLimit = { count: 2, chunks: [range(0), range(1)], open: range(2) }
    expect(closePlan(atLimit, 2)).toEqual({ count: 3, chunks: [range(0), range(1)] })
    expect(closePlan(atLimit, 3)).toEqual({ count: 3, chunks: [range(0), range(1), range(2)] })
  })
})
