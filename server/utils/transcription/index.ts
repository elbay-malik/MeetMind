import type { H3Event } from 'h3'
import { createGroqTranscriber } from './groq'
import { createStubTranscriber } from './stub'
import type { Transcriber } from './transcriber'
import { requireAllOrNone } from '../storage'

let announced = false
function announce(kind: Transcriber['kind']) {
  if (announced) return
  announced = true
  if (kind === 'stub') {
    console.info('[meetmind] transcription: stub (set NUXT_GROQ_API_KEY to use Groq Whisper)')
  }
}

/**
 * Pick the transcriber from runtime config: Groq when its key is present,
 * otherwise a deterministic stub so the pipeline runs without credentials.
 */
export function useTranscriber(event: H3Event): Transcriber {
  const config = useRuntimeConfig(event)
  const groqReady = requireAllOrNone('Groq', { NUXT_GROQ_API_KEY: config.groqApiKey })
  const transcriber = groqReady
    ? createGroqTranscriber({ apiKey: config.groqApiKey })
    : createStubTranscriber()
  announce(transcriber.kind)
  return transcriber
}
