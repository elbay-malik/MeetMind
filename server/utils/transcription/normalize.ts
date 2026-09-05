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
