import type { TranscriptSegment } from '#shared/types/meeting'

/** A segment as the speech-to-text model returns it: float SECONDS. */
export interface RawSegment {
  start: number
  end: number
  text: string
}

/**
 * Turn model output into storable segments.
 *
 * Whisper returns float seconds and is not obliged to return them in order,
 * non-overlapping, or non-empty. This is the one place seconds become integer
 * milliseconds, and the one place an offset is applied, so rounding happens
 * exactly once and cannot be applied twice by a caller further down.
 *
 * @param segments raw model segments, in any order
 * @param offsetMs milliseconds to add, for audio that did not start at zero
 */
export function normalizeSegments(segments: RawSegment[], offsetMs = 0): TranscriptSegment[] {
  if (!Number.isFinite(offsetMs) || offsetMs < 0) {
    throw new Error(`offsetMs must be a non-negative finite number, got ${offsetMs}`)
  }

  return segments
    .filter(s => Number.isFinite(s.start) && Number.isFinite(s.end))
    // Whitespace-only segments carry no transcript and would only add empty
    // rows the UI has to skip.
    .filter(s => s.text.trim().length > 0)
    .map((s) => {
      const startMs = Math.max(0, Math.round(s.start * 1000)) + offsetMs
      const endMs = Math.max(0, Math.round(s.end * 1000)) + offsetMs
      return {
        startMs,
        // A model that reports end before start would otherwise violate the
        // database's span check; clamping keeps the row storable and honest
        // about being zero-length.
        endMs: Math.max(startMs, endMs),
        text: s.text.trim(),
      }
    })
    // Stable sort: equal starts keep the model's original ordering.
    .sort((a, b) => a.startMs - b.startMs)
    .map((s, idx) => ({ idx, ...s }))
}

/**
 * Keep a line with a wrong timestamp from taking others with it.
 *
 * Lines are stored in time order across pages, so a start only ever raises the
 * floor for what follows (see `continueFrom` in steps.ts). A single line ahead of
 * its neighbours would otherwise drag every later line up to it, however many
 * pages that takes. So such a line is found first, in the reply's own order, and
 * moved back to the line before it, as zero-length.
 *
 * "Ahead" means outside the longest run of lines in time order, and later than
 * the kept line before it, or past the end of the audio. A line BEHIND the others
 * is left as it is: the sort and the floor put it right, moving only that line.
 * A last line on a page has nothing after it to show it is wrong, so inside the
 * audio it still raises the floor until the real times catch up.
 *
 * @param floorSec where the last page left off
 * @param audioEndSec the end of the audio, when known
 */
export function containOutliers(segments: RawSegment[], { floorSec, audioEndSec }: { floorSec: number, audioEndSec: number | null }): RawSegment[] {
  const usable = (s: RawSegment) => s.start >= floorSec && (audioEndSec === null || s.start <= audioEndSec)
  const capped = (s: RawSegment) => (audioEndSec !== null && s.end > audioEndSec ? { ...s, end: audioEndSec } : s)

  // The longest run in order, by the plain O(n²) method: a page is 100 lines.
  const length = segments.map(() => 0)
  const before = segments.map(() => -1)
  let tip = -1
  segments.forEach((line, i) => {
    if (!usable(line)) return
    length[i] = 1
    for (let j = 0; j < i; j++) {
      if (length[j]! > 0 && segments[j]!.start <= line.start && length[j]! + 1 > length[i]!) {
        length[i] = length[j]! + 1
        before[i] = j
      }
    }
    // On a tie, the lower one, so that an outlier cannot be what ends the run.
    if (tip < 0 || length[i]! > length[tip]! || (length[i] === length[tip] && line.start < segments[tip]!.start)) tip = i
  })
  const kept = new Set<number>()
  for (let i = tip; i >= 0; i = before[i]!) kept.add(i)

  let last = floorSec
  return segments.map((line, i) => {
    if (kept.has(i)) {
      last = line.start
      return capped(line)
    }
    return line.start > last ? { ...line, start: last, end: last } : capped(line)
  })
}

/**
 * Concatenate transcripts of consecutive audio slices.
 *
 * Not used while every upload fits one request (see ADR-0004), but the offset
 * arithmetic is the part that is easy to get wrong and cheap to pin down, so it
 * lives here tested rather than being invented under pressure later.
 */
export function concatTranscripts(parts: TranscriptSegment[][]): TranscriptSegment[] {
  return parts.flat().sort((a, b) => a.startMs - b.startMs).map((s, idx) => ({ ...s, idx }))
}

/** Total spoken time in milliseconds, ignoring gaps between segments. */
export function spokenMs(segments: TranscriptSegment[]): number {
  return segments.reduce((total, s) => total + (s.endMs - s.startMs), 0)
}
