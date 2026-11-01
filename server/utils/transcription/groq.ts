import { retryAfterMs } from '../summary/groq'
import {
  TranscriptionError,
  type TranscribeInput,
  type Transcriber,
} from './transcriber'

const ENDPOINT = 'https://api.groq.com/openai/v1/audio/transcriptions'

/** Turbo is 216x real time and a third the price; we do not need translation. */
const MODEL = 'whisper-large-v3-turbo'

export interface GroqOptions {
  apiKey: string
  /** Overridable so tests can point at a local server. */
  endpoint?: string
  /** Generous: 3 hours of audio is ~50 s of inference plus upload time. */
  timeoutMs?: number
}

export function createGroqTranscriber(options: GroqOptions): Transcriber {
  const endpoint = options.endpoint ?? ENDPOINT
  const timeoutMs = options.timeoutMs ?? 5 * 60_000

  return {
    kind: 'groq',

    async transcribe(input: TranscribeInput): Promise<Uint8Array> {
      const form = new FormData()
      // The filename's extension is how the API infers the container.
      form.append('file', new Blob([input.bytes as BlobPart], { type: input.contentType }), 'audio.ogg')
      form.append('model', MODEL)
      // Only verbose_json carries timestamps; segment granularity is its default.
      form.append('response_format', 'verbose_json')
      if (input.language) form.append('language', input.language)

      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { authorization: `Bearer ${options.apiKey}` },
        body: form,
        signal: AbortSignal.timeout(timeoutMs),
      }).catch((err: unknown) => {
        const detail = err instanceof Error ? err.message : String(err)
        throw new TranscriptionError(`Could not reach the transcription service: ${detail}`, 502, true)
      })

      if (!response.ok) throw await describeFailure(response)

      // A native copy with no parse: what the reply says is only read later, a
      // page at a time. A connection lost here is a provider fault that retrying
      // can fix; letting it throw would surface as a 500.
      const body = await response.arrayBuffer().catch((err: unknown) => {
        const detail = err instanceof Error ? err.message : String(err)
        throw new TranscriptionError(
          `Transcription service returned a body we could not read: ${detail}`,
          502,
          true,
        )
      })
      return new Uint8Array(body)
    },
  }
}

async function describeFailure(response: Response): Promise<TranscriptionError> {
  const body = await response.text().catch(() => '')
  const detail = body.slice(0, 300)

  if (response.status === 429) {
    // The free tier allows 7,200 audio-seconds per rolling hour, so a long
    // meeting can exhaust the budget on its own. Say that rather than "429".
    const retryAfter = response.headers.get('retry-after')
    const when = retryAfter ? ` Try again in ${retryAfter}s.` : ''
    return new TranscriptionError(
      `Transcription quota is exhausted for now.${when}`,
      429,
      true,
      retryAfterMs(retryAfter),
    )
  }
  if (response.status === 401 || response.status === 403) {
    return new TranscriptionError('The transcription service rejected our credentials.', 502, false)
  }
  if (response.status === 413) {
    return new TranscriptionError('The audio is larger than the transcription service accepts.', 413, false)
  }
  if (response.status >= 500) {
    return new TranscriptionError(`Transcription service is unavailable (HTTP ${response.status}).`, 502, true)
  }
  return new TranscriptionError(
    `Transcription service refused the request (HTTP ${response.status}): ${detail}`,
    502,
    false,
  )
}
