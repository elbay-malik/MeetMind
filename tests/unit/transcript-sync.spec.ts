import { describe, expect, it } from 'vitest'
import { findActiveSegment, findFollowSegment } from '../../shared/utils/transcript-sync'
import type { TranscriptSegment } from '../../shared/types/meeting'

const seg = (idx: number, startMs: number, endMs: number): TranscriptSegment =>
  ({ idx, startMs, endMs, text: `segment ${idx}` })

// Deliberately gapped: 0-1s, 2-3s, 5-6s.
const segments = [seg(0, 0, 1000), seg(1, 2000, 3000), seg(2, 5000, 6000)]

describe('findActiveSegment', () => {
  it('finds the segment covering the time', () => {
    expect(findActiveSegment(segments, 500)).toBe(0)
    expect(findActiveSegment(segments, 2500)).toBe(1)
    expect(findActiveSegment(segments, 5500)).toBe(2)
  })

  it('includes both boundaries, so a seek to a start lands on that segment', () => {
    expect(findActiveSegment(segments, 0)).toBe(0)
    expect(findActiveSegment(segments, 1000)).toBe(0)
    expect(findActiveSegment(segments, 2000)).toBe(1)
    expect(findActiveSegment(segments, 3000)).toBe(1)
  })

  it('reports nothing active during a silent gap', () => {
    expect(findActiveSegment(segments, 1500)).toBe(-1)
    expect(findActiveSegment(segments, 4000)).toBe(-1)
  })

  it('reports nothing after the transcript ends', () => {
    expect(findActiveSegment(segments, 99_000)).toBe(-1)
  })

  it('handles an empty transcript and nonsensical times', () => {
    expect(findActiveSegment([], 100)).toBe(-1)
    expect(findActiveSegment(segments, -1)).toBe(-1)
    expect(findActiveSegment(segments, Number.NaN)).toBe(-1)
    expect(findActiveSegment(segments, Number.POSITIVE_INFINITY)).toBe(-1)
  })

  it('resolves segments sharing a start to the later one', () => {
    const overlapping = [seg(0, 1000, 2000), seg(1, 1000, 5000)]
    expect(findActiveSegment(overlapping, 1500)).toBe(1)
  })

  it('matches a zero-length segment only at its own instant', () => {
    const instant = [seg(0, 0, 1000), seg(1, 2000, 2000), seg(2, 3000, 4000)]
    expect(findActiveSegment(instant, 2000)).toBe(1)
    expect(findActiveSegment(instant, 2001)).toBe(-1)
  })

  it('agrees with a linear scan across a large transcript', () => {
    // The binary search is the risky part; check it against the obvious
    // implementation at every boundary and midpoint.
    const many = Array.from({ length: 2000 }, (_, i) => seg(i, i * 1000, i * 1000 + 800))
    const linear = (t: number) => {
      let found = -1
      for (const [i, s] of many.entries()) if (s.startMs <= t && t <= s.endMs) found = i
      return found
    }
    for (const t of [0, 799, 800, 801, 999, 1000, 999_999, 1_999_800, 1_999_801, 5_000_000]) {
      expect(findActiveSegment(many, t), `t=${t}`).toBe(linear(t))
    }
  })
})

describe('findFollowSegment', () => {
  it('follows the active segment when there is one', () => {
    expect(findFollowSegment(segments, 2500)).toBe(1)
  })

  it('looks ahead to the next line during silence, rather than freezing', () => {
    expect(findFollowSegment(segments, 1500)).toBe(1)
    expect(findFollowSegment(segments, 4000)).toBe(2)
  })

  it('stays on the last line once the transcript is over', () => {
    expect(findFollowSegment(segments, 99_000)).toBe(2)
  })

  it('returns -1 only for an empty transcript', () => {
    expect(findFollowSegment([], 0)).toBe(-1)
  })
})
