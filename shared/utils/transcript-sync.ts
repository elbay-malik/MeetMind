import type { TranscriptSegment } from '../types/meeting'

/**
 * Index of the segment covering `timeMs`, or -1 when none does.
 *
 * Binary search rather than a scan: this runs on every time update, and a long
 * meeting has thousands of segments.
 *
 * Segments are sorted by start and may have gaps between them, may share a
 * start, and may be zero-length. The rule chosen here is "the last segment that
 * has started, provided it has not ended": during a silent gap nothing is
 * active, which is what a reader expects when no one is speaking.
 */
export function findActiveSegment(segments: TranscriptSegment[], timeMs: number): number {
  if (segments.length === 0 || !Number.isFinite(timeMs) || timeMs < 0) return -1

  let low = 0
  let high = segments.length - 1
  let candidate = -1

  while (low <= high) {
    const mid = (low + high) >> 1
    if (segments[mid]!.startMs <= timeMs) {
      // Keep the LAST segment starting at or before the time, so equal starts
      // resolve to the later one rather than an arbitrary midpoint.
      candidate = mid
      low = mid + 1
    }
    else {
      high = mid - 1
    }
  }

  if (candidate === -1) return -1
  // A zero-length segment covers only its own instant; endMs is inclusive of it.
  return timeMs <= segments[candidate]!.endMs ? candidate : -1
}

/**
 * Index of the segment to scroll to for `timeMs`: the active one, or the next
 * one due when playback is inside a silent gap. Following the upcoming line
 * through silence reads better than the view freezing.
 */
export function findFollowSegment(segments: TranscriptSegment[], timeMs: number): number {
  const active = findActiveSegment(segments, timeMs)
  if (active !== -1) return active
  const next = segments.findIndex(s => s.startMs > timeMs)
  // Past the last segment, stay on the last one.
  return next === -1 ? segments.length - 1 : next
}
