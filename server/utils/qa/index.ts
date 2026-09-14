import type { H3Event } from 'h3'
import { requireAllOrNone } from '../storage'
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
