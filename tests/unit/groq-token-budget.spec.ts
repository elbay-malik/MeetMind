import { afterEach, describe, expect, it, vi } from 'vitest'
import { ANSWER_MAX_COMPLETION_TOKENS, createGroqAnswerer } from '../../server/utils/qa/groq-answerer'
import { TOP_K } from '../../server/utils/qa/ask'
import { WINDOW_TOKEN_BUDGET } from '../../server/utils/qa/windows'
import {
  CHUNK_BUDGET_TOKENS,
  createGroqSummarizer,
  SUMMARY_MAX_COMPLETION_TOKENS,
  TOKENS_PER_MINUTE,
} from '../../server/utils/summary/groq'

/**
 * Every Groq request has to fit the free tier's per-minute token allowance on
 * its own: prompt and reply both count, and the provider can refuse a request
 * up front (413) when the prompt plus its `max_completion_tokens` exceeds it.
 * The summarizer's old 5,000-token chunks did not fit -- measured at ~9,800
 * tokens a request -- and summarising a dense meeting failed outright.
 *
 * These hold the sums. The fixed part of each request (instructions, JSON
 * schema, message framing) is taken from the request the code really sends,
 * priced at three characters a token: English runs near four, so this
 * overstates it, which is the safe direction for a ceiling.
 */
const CHARS_PER_TOKEN = 3

const segment = { idx: 0, startMs: 0, endMs: 1000, text: 'x' }
const ok = (content: unknown) => Response.json({ choices: [{ message: { content: JSON.stringify(content) } }] })

async function fixedOverheadTokens(send: () => Promise<unknown>, reply: unknown): Promise<number> {
  let body = ''
  vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
    body = String(init.body)
    return ok(reply)
  })
  await send()
  return Math.ceil(body.length / CHARS_PER_TOKEN)
}

afterEach(() => vi.unstubAllGlobals())

describe('per-request token budget', () => {
  it('fits a full summary chunk and its whole output budget inside one minute\'s allowance', async () => {
    const summarizer = createGroqSummarizer({ apiKey: 'k', pacer: { wait: async () => {}, rateLimited: async () => {} } })
    const overhead = await fixedOverheadTokens(
      () => summarizer.summarize({ segments: [segment] }),
      { summary: '', decisions: [], actionItems: [] },
    )
    expect(CHUNK_BUDGET_TOKENS + overhead + SUMMARY_MAX_COMPLETION_TOKENS).toBeLessThanOrEqual(TOKENS_PER_MINUTE)
  })

  it('fits the largest possible question context and its whole output budget inside one minute\'s allowance', async () => {
    const answerer = createGroqAnswerer({ apiKey: 'k', pacer: { wait: async () => {}, rateLimited: async () => {} } })
    const overhead = await fixedOverheadTokens(
      () => answerer.answer({ question: 'q', segments: [segment] }),
      { citations: [], answer: '' },
    )
    expect(TOP_K * WINDOW_TOKEN_BUDGET + overhead + ANSWER_MAX_COMPLETION_TOKENS).toBeLessThanOrEqual(TOKENS_PER_MINUTE)
  })
})
