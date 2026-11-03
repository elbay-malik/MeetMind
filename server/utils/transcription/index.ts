import type { H3Event } from 'h3'
import { selectDriver } from '../drivers'
import { createGroqTranscriber } from './groq'
import { createStubTranscriber } from './stub'
import type { Transcriber } from './transcriber'

/**
 * Pick the transcriber: Groq when its key is present, or a deterministic stub
 * where ADR-0016 allows that.
 */
export function useTranscriber(event: H3Event): Transcriber {
  return selectDriver<Transcriber>(event, 'groq', {
    real: config => createGroqTranscriber({ apiKey: config.groqApiKey }),
    // Truthy, not === true: destr parses '1' to the number 1, not a boolean.
    local: config => createStubTranscriber({ failWithQuotaOnce: !!config.transcribeStubQuotaFail }),
  })
}
