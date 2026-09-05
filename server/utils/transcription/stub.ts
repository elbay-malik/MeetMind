import type { TranscribeInput, TranscribeResult, Transcriber } from './transcriber'
import { normalizeSegments } from './normalize'

/**
 * Stands in for a speech-to-text provider when no API key is configured, so
 * development, CI and the browser driver exercise the whole pipeline without
 * credentials — the same principle as the local storage and database drivers.
 *
 * Output is derived from the audio's length and bytes, so it is deterministic
 * for a given file and obviously not a real transcript to anyone reading it.
 */
export function createStubTranscriber(): Transcriber {
  return {
    kind: 'stub',

    async transcribe(input: TranscribeInput): Promise<TranscribeResult> {
      // 16 kHz mono Opus at 16 kbps, the format Phase 3 produces: 2 kB ≈ 1 s.
      const durationSec = Math.max(1, Math.round(input.bytes.byteLength / 2000))
      const segmentCount = Math.min(12, Math.max(1, Math.round(durationSec / 5)))
      const spanSec = durationSec / segmentCount

      const segments = Array.from({ length: segmentCount }, (_, i) => ({
        start: i * spanSec,
        end: (i + 1) * spanSec,
        text: `[stub transcript ${i + 1} of ${segmentCount}] No transcription provider is configured, `
          + `so this placeholder stands in for ${spanSec.toFixed(1)} seconds of speech.`,
      }))

      return {
        segments: normalizeSegments(segments),
        durationSec,
        language: input.language ?? 'en',
      }
    },
  }
}
