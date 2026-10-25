import type { H3Event } from 'h3'
import { useSlotRepository } from '../db'
import { createGroqSummarizer, createSlotPacer, type RequestPacer } from './groq'
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
 * The pacer for every Groq chat request -- extraction chunks and questions
 * alike, since both spend the same per-account allowance (ADR-0007 decision 7).
 * Its state lives in the slot ledger, not in this module: a module-level queue
 * is per isolate on Workers and paced nothing across them (ADR-0012).
 * `maxWaitMs` is how long this caller will wait for its slot; omitted, it is
 * extraction's long wait.
 */
export function useGroqChatPacer(event: H3Event, options: { maxWaitMs?: number } = {}): RequestPacer {
  return createSlotPacer({
    slots: useSlotRepository(event),
    provider: 'groq-chat',
    intervalMs: Number(useRuntimeConfig(event).groqChatIntervalMs),
    maxWaitMs: options.maxWaitMs,
  })
}

/**
 * Pick the summarizer from runtime config: Groq when its key is present,
 * otherwise a deterministic stub so the pipeline runs without credentials.
 */
export function useSummarizer(event: H3Event): Summarizer {
  const config = useRuntimeConfig(event)
  const groqReady = requireAllOrNone('Groq', { NUXT_GROQ_API_KEY: config.groqApiKey })
  const summarizer = groqReady
    ? createGroqSummarizer({ apiKey: config.groqApiKey, pacer: useGroqChatPacer(event) })
    // Truthy, not === true: destr parses '1' to the number 1, not a boolean.
    : createStubSummarizer({
        injectCanary: !!config.summaryStubCanary,
        failOnceRetryable: !!config.summaryStubFailOnceRetryable,
      })
  announce(summarizer.kind)
  return summarizer
}
