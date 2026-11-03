import { INJECTED_FAILURE_TEXT, injectedFailure } from '../injected-failure'
import type { TranscribeInput, Transcriber } from './transcriber'
import { TranscriptionError } from './transcriber'

let quotaFailureUsed = false

export interface StubTranscriberOptions {
  /**
   * Test-only: throw a 429 exactly once (module-lifetime, not per-instance —
   * a fresh transcriber is built per request), the same shape a real Groq
   * quota exhaustion takes, so tests can prove the cooldown-gated retry path
   * over the real HTTP route without credentials. Never set outside tests.
   */
  failWithQuotaOnce?: boolean
  /** Test-only: audio holding this asks for a failure. See injected-failure.ts. */
  failureCanary?: string
}

/**
 * Stands in for a speech-to-text provider when no API key is configured, so
 * development, CI and the browser driver exercise the whole pipeline without
 * credentials — the same principle as the local storage and database drivers.
 *
 * Output is derived from the audio's length and bytes, so it is deterministic
 * for a given file and obviously not a real transcript to anyone reading it.
 */
export function createStubTranscriber(options: StubTranscriberOptions = {}): Transcriber {
  return {
    kind: 'stub',

    async transcribe(input: TranscribeInput): Promise<Uint8Array> {
      if (options.failWithQuotaOnce && !quotaFailureUsed) {
        quotaFailureUsed = true
        throw new TranscriptionError('Transcription quota is exhausted for now (stub-injected for testing).', 429, true)
      }

      const failure = options.failureCanary ? injectedFailure(options.failureCanary, 'transcribe', new TextDecoder().decode(input.bytes)) : null
      if (failure === 'internal') throw new Error(INJECTED_FAILURE_TEXT)
      if (failure === 'rate-limited') throw new TranscriptionError(INJECTED_FAILURE_TEXT, 429, true)
      if (failure) throw new TranscriptionError(INJECTED_FAILURE_TEXT, 502, failure === 'retryable')

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

      // The shape of Groq's verbose_json, so the same page reader handles both.
      return new TextEncoder().encode(JSON.stringify({
        task: 'transcribe',
        language: input.language ?? 'en',
        duration: durationSec,
        text: segments.map(s => s.text).join(' '),
        segments,
      }))
    },
  }
}
