import { describe, expect, it } from 'vitest'
import { concatTranscripts, containOutliers, normalizeSegments, spokenMs } from '../../server/utils/transcription/normalize'

const raw = (start: number, end: number, text: string) => ({ start, end, text })

describe('normalizeSegments', () => {
  it('converts float seconds to integer milliseconds', () => {
    expect(normalizeSegments([raw(43.92, 50.16, 'hello')])).toEqual([
      { idx: 0, startMs: 43920, endMs: 50160, text: 'hello' },
    ])
  })

  it('rounds rather than truncates, so a half-millisecond does not vanish', () => {
    expect(normalizeSegments([raw(0.0005, 0.0015, 'x')])[0]).toMatchObject({ startMs: 1, endMs: 2 })
  })

  it('numbers segments gaplessly from zero, whatever the model returned', () => {
    const out = normalizeSegments([raw(2, 3, 'second'), raw(0, 1, 'first'), raw(4, 5, 'third')])
    expect(out.map(s => s.idx)).toEqual([0, 1, 2])
    expect(out.map(s => s.text)).toEqual(['first', 'second', 'third'])
  })

  it('orders by start time', () => {
    const out = normalizeSegments([raw(10, 11, 'b'), raw(1, 2, 'a')])
    expect(out.map(s => s.startMs)).toEqual([1000, 10000])
  })

  it('keeps the model order when two segments start together', () => {
    const out = normalizeSegments([raw(1, 2, 'first'), raw(1, 3, 'second')])
    expect(out.map(s => s.text)).toEqual(['first', 'second'])
  })

  it('drops segments with no words in them', () => {
    const out = normalizeSegments([raw(0, 1, '  '), raw(1, 2, 'real'), raw(2, 3, '')])
    expect(out).toEqual([{ idx: 0, startMs: 1000, endMs: 2000, text: 'real' }])
  })

  it('trims surrounding whitespace, which Whisper emits on nearly every segment', () => {
    expect(normalizeSegments([raw(0, 1, '  padded  ')])[0]!.text).toBe('padded')
  })

  it('drops non-finite timings instead of writing NaN to the database', () => {
    const out = normalizeSegments([
      raw(Number.NaN, 1, 'nan'),
      raw(0, Number.POSITIVE_INFINITY, 'inf'),
      raw(1, 2, 'good'),
    ])
    expect(out.map(s => s.text)).toEqual(['good'])
  })

  it('clamps a segment that ends before it starts, keeping the span check satisfiable', () => {
    const out = normalizeSegments([raw(5, 4, 'backwards')])
    expect(out[0]).toMatchObject({ startMs: 5000, endMs: 5000 })
    expect(out[0]!.endMs).toBeGreaterThanOrEqual(out[0]!.startMs)
  })

  it('never emits a negative time', () => {
    expect(normalizeSegments([raw(-3, -1, 'before zero')])[0]).toMatchObject({ startMs: 0, endMs: 0 })
  })

  it('applies the offset exactly once, to both ends', () => {
    expect(normalizeSegments([raw(1, 2, 'x')], 60_000)[0]).toMatchObject({ startMs: 61_000, endMs: 62_000 })
  })

  it('is a no-op offset at zero, so a single slice needs no special case', () => {
    const segments = [raw(0, 1, 'a'), raw(1, 2, 'b')]
    expect(normalizeSegments(segments, 0)).toEqual(normalizeSegments(segments))
  })

  it('refuses a nonsensical offset rather than writing wrong timings', () => {
    expect(() => normalizeSegments([raw(0, 1, 'x')], -1)).toThrow(/non-negative/)
    expect(() => normalizeSegments([raw(0, 1, 'x')], Number.NaN)).toThrow(/non-negative/)
  })

  it('returns nothing for an empty transcript', () => {
    expect(normalizeSegments([])).toEqual([])
  })

  it('produces monotonically non-decreasing starts for arbitrary input', () => {
    // Property check over deliberately hostile input: reversed, duplicated,
    // zero-length and backwards segments together.
    const messy = [
      raw(9.99, 9.99, 'zero length'), raw(3, 2, 'backwards'), raw(0.4, 0.9, 'a'),
      raw(0.4, 0.5, 'b'), raw(100, 101, 'last'), raw(2.5, 2.6, 'c'),
    ]
    const out = normalizeSegments(messy)
    for (let i = 1; i < out.length; i++) {
      expect(out[i]!.startMs).toBeGreaterThanOrEqual(out[i - 1]!.startMs)
      expect(out[i]!.idx).toBe(out[i - 1]!.idx + 1)
      expect(out[i]!.endMs).toBeGreaterThanOrEqual(out[i]!.startMs)
    }
  })

  it('loses no spoken text', () => {
    const messy = [raw(5, 6, 'world'), raw(0, 1, 'hello'), raw(2, 3, '   ')]
    expect(normalizeSegments(messy).map(s => s.text)).toEqual(['hello', 'world'])
  })
})

describe('concatTranscripts', () => {
  it('renumbers across slices without gaps', () => {
    const first = normalizeSegments([raw(0, 1, 'a'), raw(1, 2, 'b')])
    const second = normalizeSegments([raw(0, 1, 'c')], 60_000)
    const joined = concatTranscripts([first, second])
    expect(joined.map(s => s.idx)).toEqual([0, 1, 2])
    expect(joined.map(s => s.text)).toEqual(['a', 'b', 'c'])
    expect(joined.at(-1)).toMatchObject({ startMs: 60_000, endMs: 61_000 })
  })

  it('is identity for a single already-normalized slice', () => {
    const only = normalizeSegments([raw(0, 1, 'a'), raw(2, 3, 'b')])
    expect(concatTranscripts([only])).toEqual(only)
  })

  it('interleaves correctly if slices are passed out of order', () => {
    const later = normalizeSegments([raw(0, 1, 'later')], 10_000)
    const earlier = normalizeSegments([raw(0, 1, 'earlier')])
    expect(concatTranscripts([later, earlier]).map(s => s.text)).toEqual(['earlier', 'later'])
  })

  it('handles no slices at all', () => {
    expect(concatTranscripts([])).toEqual([])
  })
})

describe('spokenMs', () => {
  it('sums segment spans, ignoring the silence between them', () => {
    expect(spokenMs(normalizeSegments([raw(0, 1, 'a'), raw(10, 12, 'b')]))).toBe(3000)
  })

  it('is zero for an empty transcript', () => {
    expect(spokenMs([])).toBe(0)
  })
})

describe('normalizeSegments, on text Postgres would refuse', () => {
  it('drops a NUL and replaces a lone surrogate, keeping a whole pair', () => {
    const texts = normalizeSegments([raw(0, 1, 'a\u0000b'), raw(1, 2, 'x\ud83dy'), raw(2, 3, '\ud83d\ude00')]).map(s => s.text)
    expect(texts).toEqual(['ab', 'x\ufffdy', '\ud83d\ude00'])
  })

  it('drops a line that held nothing else', () => {
    expect(normalizeSegments([raw(0, 1, ' \u0000 ')])).toEqual([])
  })
})

describe('containOutliers', () => {
  const at = (...starts: number[]) => starts.map(start => ({ start, end: start + 1, text: `at ${start}` }))
  const contain = (lines: ReturnType<typeof at>, audioEndSec: number | null = null, floorSec = 0) => containOutliers(lines, { floorSec, audioEndSec })

  it('changes nothing in a reply already in order, however far apart its lines', () => {
    const lines = at(0, 1, 1, 500, 3000)
    expect(contain(lines)).toEqual(lines)
  })

  it('brings a line ahead of those after it back to the one before it, as zero-length', () => {
    expect(contain(at(1, 2, 900, 3, 4)).map(s => [s.start, s.end])).toEqual([[1, 2], [2, 3], [2, 2], [3, 4], [4, 5]])
  })

  it('does the same for several in a row', () => {
    expect(contain(at(1, 900, 901, 2, 3, 4)).map(s => s.start)).toEqual([1, 1, 1, 2, 3, 4])
  })

  it('uses the floor for a first line ahead of the rest', () => {
    expect(contain(at(900, 11, 12, 13), null, 10).map(s => s.start)).toEqual([10, 11, 12, 13])
  })

  it('leaves a line behind the others to the sort and the floor, moving nothing else', () => {
    const lines = at(100, 101, 50, 102, 103)
    expect(contain(lines)).toEqual(lines)
    expect(contain(at(8, 10, 9, 11)).map(s => s.start)).toEqual([8, 10, 9, 11])
  })

  it('catches a last line past the end of the audio, and caps an end past it', () => {
    expect(contain(at(1, 2, 900), 50).map(s => s.start)).toEqual([1, 2, 2])
    expect(contain([{ start: 1, end: 900, text: 'long' }], 50)[0]).toMatchObject({ start: 1, end: 50 })
  })

  it('prefers the earlier of two lines that could each end the order, so an outlier cannot lift the floor', () => {
    expect(contain(at(5, 900, 6)).map(s => s.start)).toEqual([5, 5, 6])
  })
})
