import type { H3Event } from 'h3'
import { requireAllOrNone } from '../storage'
import { useGroqChatPacer } from '../summary'
import type { Answerer } from './answerer'
import { createGroqAnswerer } from './groq-answerer'
import { createStubAnswerer } from './stub-answerer'
import type { Embedder } from './embedder'
import { createGeminiEmbedder } from './gemini'
import { createStubEmbedder } from './stub'

let announced = false
function announce(kind: Embedder['kind']) {
  if (announced) return
  announced = true
  if (kind === 'stub') {
    console.info('[meetmind] embeddings: stub (set NUXT_GEMINI_API_KEY to use Gemini)')
  }
}

/**
 * Pick the embedder from runtime config: Gemini when its key is present,
 * otherwise a deterministic stub so indexing and questions run without
 * credentials.
 */
export function useEmbedder(event: H3Event): Embedder {
  const config = useRuntimeConfig(event)
  const geminiReady = requireAllOrNone('Gemini', { NUXT_GEMINI_API_KEY: config.geminiApiKey })
  const embedder = geminiReady
    ? createGeminiEmbedder({ apiKey: config.geminiApiKey })
    : createStubEmbedder()
  announce(embedder.kind)
  return embedder
}

let answererAnnounced = false

/**
 * Pick the answerer: Groq when its key is present, sharing extraction's slots
 * because both spend one per-account allowance; otherwise a deterministic stub.
 * A question waits only `askMaxSlotWaitMs` for its slot, then is refused with
 * when to try again (ADR-0012).
 */
export function useAnswerer(event: H3Event): Answerer {
  const config = useRuntimeConfig(event)
  const groqReady = requireAllOrNone('Groq', { NUXT_GROQ_API_KEY: config.groqApiKey })
  const pacer = () => useGroqChatPacer(event, { maxWaitMs: Number(config.askMaxSlotWaitMs) })
  const answerer = groqReady
    ? createGroqAnswerer({ apiKey: config.groqApiKey, pacer: pacer() })
    // Truthy, not === true: destr parses '1' to the number 1, not a boolean.
    : createStubAnswerer({ pacer: config.answerStubPaced ? pacer() : undefined })
  if (!answererAnnounced && answerer.kind === 'stub') {
    answererAnnounced = true
    console.info('[meetmind] answers: stub (set NUXT_GROQ_API_KEY to use Groq)')
  }
  return answerer
}
