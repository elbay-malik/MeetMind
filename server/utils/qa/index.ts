import type { H3Event } from 'h3'
import { selectDriver } from '../drivers'
import { useGroqChatPacer } from '../summary'
import type { Answerer } from './answerer'
import { createGroqAnswerer } from './groq-answerer'
import { createStubAnswerer } from './stub-answerer'
import type { Embedder } from './embedder'
import { createStubEmbedder } from './stub'
import { createWorkersAiEmbedder } from './workers-ai'

/**
 * Pick the embedder: Workers AI when its account and token are present, or a
 * deterministic stub where ADR-0016 allows that.
 */
export function useEmbedder(event: H3Event): Embedder {
  return pickEmbedder(event, {})
}

/**
 * The embedder for one indexing step (ADR-0012): exactly one provider request per
 * batch. A retry is the next step's attempt, recorded on the run, not a second
 * request inside this one.
 */
export function useStepEmbedder(event: H3Event): Embedder {
  return pickEmbedder(event, { maxAttempts: 1 })
}

function pickEmbedder(event: H3Event, options: { maxAttempts?: number }): Embedder {
  return selectDriver<Embedder>(event, 'workersAi', {
    real: config => createWorkersAiEmbedder({ accountId: config.workersAiAccountId, apiToken: config.workersAiApiToken, maxAttempts: options.maxAttempts }),
    local: config => createStubEmbedder({ quotaCanary: config.embedStubQuotaCanary, failureCanary: config.stubFailureCanary }),
  })
}

/**
 * Pick the answerer: Groq when its key is present, sharing extraction's slots
 * because both spend one per-account allowance, or a deterministic stub where
 * ADR-0016 allows that. A question waits only `askMaxSlotWaitMs` for its slot,
 * then is refused with when to try again (ADR-0012).
 */
export function useAnswerer(event: H3Event): Answerer {
  const pacer = () => useGroqChatPacer(event, { maxWaitMs: Number(useRuntimeConfig(event).askMaxSlotWaitMs) })
  return selectDriver<Answerer>(event, 'groq', {
    real: config => createGroqAnswerer({ apiKey: config.groqApiKey, pacer: pacer() }),
    // Truthy, not === true: destr parses '1' to the number 1, not a boolean.
    local: config => createStubAnswerer({ pacer: config.answerStubPaced ? pacer() : undefined, failureCanary: config.stubFailureCanary }),
  })
}
