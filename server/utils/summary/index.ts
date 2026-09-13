import type { H3Event } from 'h3'
import { createGroqSummarizer, createRequestPacer } from './groq'
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

// Module-level, not per-request: `useSummarizer` builds a fresh Summarizer
// every call, but Groq's rate limit is per ACCOUNT, not per meeting. Two
// concurrent extractions for different meetings pace only against their own
// requests without this — each individually paced, but together still able
// to exceed the aggregate limit neither alone would hit.
const sharedGroqPacer = createRequestPacer(60_000)

/**
 * Pick the summarizer from runtime config: Groq when its key is present,
 * otherwise a deterministic stub so the pipeline runs without credentials.
 */
export function useSummarizer(event: H3Event): Summarizer {
  const config = useRuntimeConfig(event)
  const groqReady = requireAllOrNone('Groq', { NUXT_GROQ_API_KEY: config.groqApiKey })
  const summarizer = groqReady
    ? createGroqSummarizer({ apiKey: config.groqApiKey, pacer: sharedGroqPacer })
    // Truthy, not === true: destr parses '1' to the number 1, not a boolean.
    : createStubSummarizer({
        injectCanary: !!config.summaryStubCanary,
        failOnceRetryable: !!config.summaryStubFailOnceRetryable,
      })
  announce(summarizer.kind)
  return summarizer
}
