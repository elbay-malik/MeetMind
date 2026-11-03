import type { H3Event } from 'h3'
import { useSlotRepository } from '../db'
import { selectDriver } from '../drivers'
import { createGroqSummarizer, createSlotPacer, type RequestPacer } from './groq'
import { createStubSummarizer } from './stub'
import type { Summarizer } from './summarizer'

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
 * Pick the summarizer: Groq when its key is present, or a deterministic stub
 * where ADR-0016 allows that.
 */
export function useSummarizer(event: H3Event): Summarizer {
  return pickSummarizer(event, {})
}

/**
 * The summarizer for one extraction step (ADR-0012): exactly one provider
 * request per `summarizeChunk`, sent only if its slot is free now. A retry is
 * the next step's attempt, recorded on the chunk, not a second request inside
 * this one; a slot that is not free is a hold, which parks the chunk.
 */
export function useStepSummarizer(event: H3Event): Summarizer {
  return pickSummarizer(event, { maxAttempts: 1, maxSlotWaitMs: 0 })
}

function pickSummarizer(event: H3Event, options: { maxAttempts?: number, maxSlotWaitMs?: number }): Summarizer {
  return selectDriver<Summarizer>(event, 'groq', {
    real: config => createGroqSummarizer({
      apiKey: config.groqApiKey,
      maxAttempts: options.maxAttempts,
      pacer: useGroqChatPacer(event, { maxWaitMs: options.maxSlotWaitMs }),
    }),
    // Truthy, not === true: destr parses '1' to the number 1, not a boolean.
    local: config => createStubSummarizer({
      injectCanary: !!config.summaryStubCanary,
      failOnceRetryable: !!config.summaryStubFailOnceRetryable,
    }),
  })
}
