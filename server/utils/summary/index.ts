import type { H3Event } from 'h3'
import { createGroqSummarizer } from './groq'
import { createStubSummarizer } from './stub'
import type { Summarizer } from './summarizer'
import { requireAllOrNone } from '../storage'

let announced = false
function announce(kind: Summarizer['kind']) {
  if (announced) return
  announced = true
  if (kind === 'stub') {
    console.info('[meetmind] summaries: stub (set NUXT_GROQ_API_KEY to use Groq)')
  }
}

/**
 * Pick the summarizer from runtime config: Groq when its key is present,
 * otherwise a deterministic stub so the pipeline runs without credentials.
 */
export function useSummarizer(event: H3Event): Summarizer {
  const config = useRuntimeConfig(event)
  const groqReady = requireAllOrNone('Groq', { NUXT_GROQ_API_KEY: config.groqApiKey })
  const summarizer = groqReady
    ? createGroqSummarizer({ apiKey: config.groqApiKey })
    : createStubSummarizer()
  announce(summarizer.kind)
  return summarizer
}
