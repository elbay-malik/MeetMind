import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  dailyLimitReached,
  EMBEDDING_DIMENSIONS,
  EmbeddingError,
  EmbeddingInputTooLongError,
  MAX_BATCH,
  MAX_BATCH_TOKENS,
  planEmbeddingBatches,
} from '../../server/utils/qa/embedder'
import { createWorkersAiEmbedder, WORKERS_AI_EMBEDDING_MODEL } from '../../server/utils/qa/workers-ai'
import { estimateTokens } from '../../server/utils/summary/plan'

const ACCOUNT = 'acct0123456789abcdef'
const TOKEN = 'token-do-not-leak-0123456789'
const embedder = createWorkersAiEmbedder({ accountId: ACCOUNT, apiToken: TOKEN })

const vector = (seed: number, length = EMBEDDING_DIMENSIONS) =>
  Array.from({ length }, (_, i) => (seed + i) / 10_000)

interface Sent { url: string, headers: Headers, body: { text: string[] } & Record<string, unknown> }

/** Reply to each request with `respond`, recording what was sent. */
function stubWorkersAi(respond: (sent: Sent, call: number) => Response | Promise<Response>) {
  const calls: Sent[] = []
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    const sent = { url, headers: new Headers(init.headers), body: JSON.parse(String(init.body)) }
    calls.push(sent)
    return respond(sent, calls.length)
  })
  return calls
}

/** The reply as measured against the real API (ADR-0014). */
const replyWith = (data: unknown[], shape: unknown = [data.length, EMBEDDING_DIMENSIONS]) => Response.json({
  result: {
    data,
    shape,
    pooling: 'cls',
    response: null,
    meta: { cost_metric_name_1: 'input_tokens', cost_metric_value_1: 38, neurons: 0.04 },
  },
  success: true,
  errors: [],
  messages: [],
})

/** A well-formed reply with one vector per requested text. */
const embeddingsFor = (sent: Sent, offset = 0) => replyWith(sent.body.text.map((_, i) => vector(offset + i)))

/** The failure as measured: `success: false`, and the reason in `errors`. */
const refusal = (status: number, code: number, message: string) =>
  Response.json({ errors: [{ message, code }], success: false }, { status })

afterEach(() => vi.unstubAllGlobals())

describe('request', () => {
  it('posts to the model\'s run URL with the token in a header, never the URL', async () => {
    const calls = stubWorkersAi(sent => embeddingsFor(sent))
    await embedder.embedDocuments(['hello'])

    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/ai/run/@cf/baai/bge-m3`)
    expect(WORKERS_AI_EMBEDDING_MODEL).toBe('@cf/baai/bge-m3')
    // A key in the query string ends up in access logs and error reports.
    expect(calls[0]!.url).not.toContain(TOKEN)
    expect(calls[0]!.headers.get('authorization')).toBe(`Bearer ${TOKEN}`)
    expect(calls[0]!.headers.get('content-type')).toBe('application/json')
  })

  it('sends a window as it is, in `text` and nothing else', async () => {
    // `query` and `contexts` would ask this model for reranking instead.
    const calls = stubWorkersAi(sent => embeddingsFor(sent))
    await embedder.embedDocuments(['We agreed to ship on Friday.'])
    expect(calls[0]!.body).toEqual({ text: ['We agreed to ship on Friday.'] })
  })

  it('sends a question as it is too, with no prefix', async () => {
    const calls = stubWorkersAi(sent => embeddingsFor(sent))
    await embedder.embedQuery('What did we decide about the budget?')
    expect(calls[0]!.body).toEqual({ text: ['What did we decide about the budget?'] })
  })

  it('sends nothing for an empty list', async () => {
    const calls = stubWorkersAi(sent => embeddingsFor(sent))
    expect(await embedder.embedDocuments([])).toEqual([])
    expect(calls).toHaveLength(0)
  })

  it(`splits more than ${MAX_BATCH} texts into sequential batches and keeps every vector with its text`, async () => {
    let offset = 0
    const calls = stubWorkersAi((sent) => {
      const reply = embeddingsFor(sent, offset)
      offset += sent.body.text.length
      return reply
    })
    const texts = Array.from({ length: MAX_BATCH * 2 + 5 }, (_, i) => `text ${i}`)
    const vectors = await embedder.embedDocuments(texts)

    expect(calls.map(c => c.body.text.length)).toEqual([MAX_BATCH, MAX_BATCH, 5])
    expect(calls.flatMap(c => c.body.text)).toEqual(texts)
    expect(vectors).toHaveLength(texts.length)
    // The Nth vector belongs to the Nth text across batch boundaries.
    for (const i of [0, MAX_BATCH - 1, MAX_BATCH, texts.length - 1]) {
      expect(vectors[i]![0]).toBe(i / 10_000)
    }
  })

  it('splits long texts by estimated tokens, well before the count limit', async () => {
    // 40 windows at the full budget is what the real API refused (ADR-0014).
    const window = (i: number) => Array.from({ length: 1_070 }, (_, k) => `w${i}x${k}`).join(' ')
    const texts = Array.from({ length: 40 }, (_, i) => window(i))
    expect(estimateTokens(texts[0]!)).toBeGreaterThan(1_400)

    const calls = stubWorkersAi(sent => embeddingsFor(sent))
    const vectors = await embedder.embedDocuments(texts)

    expect(vectors).toHaveLength(40)
    expect(calls.length).toBeGreaterThan(1)
    for (const call of calls) {
      expect(call.body.text.reduce((sum, t) => sum + estimateTokens(t), 0)).toBeLessThanOrEqual(MAX_BATCH_TOKENS)
    }
    expect(calls.flatMap(c => c.body.text)).toEqual(texts)
  })
})

describe('planEmbeddingBatches', () => {
  const words = (n: number, tag: string) => Array.from({ length: n }, (_, i) => `${tag}${i}`).join(' ')
  const plan = (texts: string[]) => planEmbeddingBatches(texts, t => t)

  it('has nothing to do for nothing', () => {
    expect(plan([])).toEqual([])
  })

  it('stays in order and loses nothing', () => {
    const texts = Array.from({ length: 250 }, (_, i) => words(i % 400, `t${i}x`))
    expect(plan(texts).flat()).toEqual(texts)
  })

  it('closes a batch at the count limit', () => {
    const batches = plan(Array.from({ length: MAX_BATCH + 1 }, (_, i) => `text ${i}`))
    expect(batches.map(b => b.length)).toEqual([MAX_BATCH, 1])
  })

  it('never exceeds the token cap by adding to a batch', () => {
    const texts = Array.from({ length: 30 }, (_, i) => words(1_000, `t${i}x`))
    const batches = plan(texts)
    expect(batches.length).toBeGreaterThan(1)
    for (const batch of batches) {
      expect(batch.reduce((sum, t) => sum + estimateTokens(t), 0)).toBeLessThanOrEqual(MAX_BATCH_TOKENS)
    }
  })

  it('puts a text over the cap alone, so the refusal can only be about it', () => {
    const huge = words(10_000, 'h')
    expect(estimateTokens(huge)).toBeGreaterThan(MAX_BATCH_TOKENS)
    expect(plan(['before', huge, 'after'])).toEqual([['before'], [huge], ['after']])
  })

  it('keeps the cap under the real limit at the worst ratio measured', () => {
    // ADR-0014: 3.94 real tokens per estimated, on text with one token per character.
    expect(MAX_BATCH_TOKENS * 3.94).toBeLessThan(60_000 * 0.8)
  })
})

describe('response validation', () => {
  it('refuses a vector of the wrong size instead of storing it, without retrying', async () => {
    // What a model changed under its name looks like: the size the column used to hold.
    const calls = stubWorkersAi(() => replyWith([vector(0, 768)], [1, 768]))
    await expect(embedder.embedDocuments(['x'])).rejects.toThrow(/shaped 1 by 1024, got \[1,768\]/)
    expect(calls).toHaveLength(1)
  })

  it('checks the vector itself, not only what the reply says about its shape', async () => {
    const calls = stubWorkersAi(() => replyWith([vector(0, 768)]))
    await expect(embedder.embedDocuments(['x'])).rejects.toThrow(/1024-dimension embedding, got 768/)
    expect(calls).toHaveLength(1)
  })

  it('refuses a reply with a different number of vectors than texts sent', async () => {
    // Pairing by position would put every later vector on the wrong window.
    const calls = stubWorkersAi(() => replyWith([vector(0)]))
    await expect(embedder.embedDocuments(['a', 'b'])).rejects.toThrow(/Expected 2 embeddings, got 1/)
    expect(calls).toHaveLength(1)
  })

  it('refuses a vector containing a non-finite value', async () => {
    const bad = vector(0)
    bad[10] = Number.NaN
    // JSON has no NaN; a null in the payload is how it would arrive.
    stubWorkersAi(() => new Response(JSON.stringify({ success: true, result: { data: [bad], shape: [1, EMBEDDING_DIMENSIONS] } })))
    await expect(embedder.embedDocuments(['x'])).rejects.toThrow(/non-numeric or non-finite/)
  })

  it('refuses a vector containing something that is not a number', async () => {
    const bad: unknown[] = vector(0)
    bad[3] = '0.1'
    stubWorkersAi(() => replyWith([bad]))
    await expect(embedder.embedDocuments(['x'])).rejects.toThrow(/non-numeric or non-finite/)
  })

  it.each([
    ['success: false on a 200', { success: false, errors: [{ code: 1000, message: 'no' }], result: { data: [vector(0)] } }, /code 1000/],
    ['no success field at all', { result: { data: [vector(0)], shape: [1, EMBEDDING_DIMENSIONS] } }, /refused/],
    ['success as a string', { success: 'true', result: { data: [vector(0)], shape: [1, EMBEDDING_DIMENSIONS] } }, /refused/],
  ])('refuses %s, even with usable vectors beside it', async (_name, reply, message) => {
    const calls = stubWorkersAi(() => Response.json(reply))
    const failure = await embedder.embedDocuments(['x']).catch(e => e)
    expect(failure).toBeInstanceOf(EmbeddingError)
    expect(failure.retryable).toBe(false)
    expect(failure.message).toMatch(message)
    expect(calls).toHaveLength(1)
  })

  it.each([
    ['no result', { success: true }],
    ['a null result', { success: true, result: null }],
    ['a result with no data', { success: true, result: { shape: [1, EMBEDDING_DIMENSIONS], response: 'text' } }],
    ['data that is not a list', { success: true, result: { data: 'x', shape: [1, EMBEDDING_DIMENSIONS] } }],
  ])('refuses %s', async (_name, reply) => {
    stubWorkersAi(() => Response.json(reply))
    await expect(embedder.embedDocuments(['x'])).rejects.toThrow(/Expected 1 embeddings, got no/)
  })

  it.each([
    ['of another size', [1, 768]],
    ['of another count', [2, EMBEDDING_DIMENSIONS]],
    ['that is not a list', 'wide'],
  ])('refuses a stated shape %s, even with vectors that look right', async (_name, shape) => {
    stubWorkersAi(() => replyWith([vector(0)], shape))
    await expect(embedder.embedDocuments(['x'])).rejects.toThrow(/result shaped 1 by 1024/)
  })
})

describe('the daily limit', () => {
  const TOMORROW = /free daily limit.*resets at 00:00 UTC/

  it.each([
    ['a 429 with the wording alone', () => refusal(429, 1234, 'you have used up your daily free allocation of 10,000 neurons')],
    ['a 429 with code 3036', () => refusal(429, 3036, 'Account limited')],
    ['a 429 with code 4006', () => refusal(429, 4006, 'whatever it says')],
    ['a bare 429', () => new Response('nope', { status: 429 })],
    ['code 4006 on another status', () => refusal(400, 4006, 'whatever it says')],
    ['code 3036 on a 200', () => refusal(200, 3036, 'whatever it says')],
    ['the wording on a 403', () => refusal(403, 1, 'Your daily free allocation is used up')],
  ])('reads %s as the limit, says so plainly, and does not retry into it', async (_name, reply) => {
    const calls = stubWorkersAi(() => reply())
    const failure = await embedder.embedDocuments(['x']).catch(e => e)
    expect(failure).toBeInstanceOf(EmbeddingError)
    expect(failure).toMatchObject({ statusCode: 429, retryable: false })
    expect(failure.message).toMatch(TOMORROW)
    expect(failure.retryAt.getTime()).toBeGreaterThan(Date.now())
    expect(calls).toHaveLength(1)
  })

  it.each([
    ['the middle of a day', '2026-11-02T13:45:00Z', '2026-11-03T00:00:00.000Z'],
    ['one second before the reset', '2026-11-02T23:59:59Z', '2026-11-03T00:00:00.000Z'],
    ['the reset itself', '2026-11-03T00:00:00Z', '2026-11-04T00:00:00.000Z'],
    ['the last day of a month', '2026-11-30T10:00:00Z', '2026-12-01T00:00:00.000Z'],
    ['the last day of a year', '2026-12-31T10:00:00Z', '2027-01-01T00:00:00.000Z'],
  ])('gives the next 00:00 UTC from %s', (_name, now, reset) => {
    expect(dailyLimitReached(new Date(now)).retryAt?.toISOString()).toBe(reset)
  })

  it('does not call a short capacity shortage the daily limit', async () => {
    // Also a 429, and documented as temporary. Saying "until midnight" would be false.
    const calls = stubWorkersAi(() => refusal(429, 3040, 'Capacity temporarily exceeded, please try again.'))
    const failure = await embedder.embedQuery('x').catch(e => e)
    expect(failure).toBeInstanceOf(EmbeddingError)
    expect(failure).toMatchObject({ statusCode: 503, retryable: false })
    expect(failure.retryAt).toBeUndefined()
    expect(failure.message).not.toMatch(/daily/)
    expect(failure.message).toMatch(/Try again shortly/)
    expect(calls).toHaveLength(1)
  })
})

describe('an input over the limit', () => {
  it('fails clearly, with the model\'s own count, and is final', async () => {
    const calls = stubWorkersAi(() => refusal(400, 8007, 'AiError: AiError: Sequence too long: 9613 > 8192 (d4c1)'))
    const failure = await embedder.embedDocuments(['a', 'b', 'c']).catch(e => e)
    expect(failure).toBeInstanceOf(EmbeddingInputTooLongError)
    expect(failure).toBeInstanceOf(EmbeddingError)
    expect(failure).toMatchObject({ statusCode: 422, retryable: false })
    expect(failure.message).toMatch(/too long to index for questions \(9,613 tokens; the limit is 8,192 tokens\)/)
    expect(calls).toHaveLength(1)
  })

  it.each([
    ['refused by the guess from its length', () => refusal(413, 5021, 'AiError: Ai: The estimated number of input and maximum output tokens (60238) exceeded this model context window limit (60000). (aa)')],
    ['refused by the real count', () => refusal(400, 8007, 'AiError: AiError: Max context reached 107960 tokens but model supports only 60000 (bb)')],
    ['a bare 413', () => new Response('too large', { status: 413 })],
  ])('reads a text alone in its request and %s as too long', async (_name, reply) => {
    stubWorkersAi(() => reply())
    await expect(embedder.embedQuery('x')).rejects.toBeInstanceOf(EmbeddingInputTooLongError)
  })

  it('does not blame a passage when a request of several is over the total', async () => {
    // That is batching gone wrong, not a passage: no window is too long here.
    stubWorkersAi(() => refusal(413, 5021, 'AiError: Ai: The estimated number of input and maximum output tokens (60238) exceeded this model context window limit (60000).'))
    const failure = await embedder.embedDocuments(['a', 'b']).catch(e => e)
    expect(failure).toBeInstanceOf(EmbeddingError)
    expect(failure).not.toBeInstanceOf(EmbeddingInputTooLongError)
    expect(failure).toMatchObject({ statusCode: 502, retryable: false })
  })

  it('does not read every code 8007 as too long', async () => {
    stubWorkersAi(() => refusal(400, 8007, 'AiError: AiError: text[0] must be a non-empty string (cc)'))
    const failure = await embedder.embedQuery('x').catch(e => e)
    expect(failure).not.toBeInstanceOf(EmbeddingInputTooLongError)
    expect(failure.message).toMatch(/non-empty string/)
  })
})

describe('failures', () => {
  it.each([401, 403])('treats rejected credentials as final (HTTP %i)', async (status) => {
    const calls = stubWorkersAi(() => refusal(status, 10000, 'Authentication error'))
    const failure = await embedder.embedQuery('x').catch(e => e)
    expect(failure).toMatchObject({ statusCode: 502, retryable: false })
    expect(failure.message).toMatch(/rejected our credentials/)
    expect(calls).toHaveLength(1)
  })

  it.each([400, 404, 422])('does not retry any other refusal (HTTP %i)', async (status) => {
    const calls = stubWorkersAi(() => refusal(status, 5007, 'No such model'))
    await expect(embedder.embedQuery('x')).rejects.toMatchObject({ retryable: false })
    expect(calls).toHaveLength(1)
  })

  // Cloudflare's error page lists both as 408. Our own timeout is retried, so the
  // provider's is too. Not seen against the real API.
  it.each([
    [3007, 'Timeout'],
    [3008, 'Aborted'],
  ])('retries a provider timeout once, then succeeds (code %i)', async (code, message) => {
    const calls = stubWorkersAi((sent, call) => call === 1 ? refusal(408, code, message) : embeddingsFor(sent))
    expect(await embedder.embedQuery('x')).toHaveLength(EMBEDDING_DIMENSIONS)
    expect(calls).toHaveLength(2)
  })

  it('gives up after the configured attempts on a persistent provider timeout', async () => {
    const calls = stubWorkersAi(() => refusal(408, 3007, 'Timeout'))
    await expect(embedder.embedQuery('x')).rejects.toMatchObject({ statusCode: 502, retryable: true })
    expect(calls).toHaveLength(2)
  })

  it('retries a server error once, then succeeds', async () => {
    const calls = stubWorkersAi((sent, call) => call === 1 ? new Response('down', { status: 503 }) : embeddingsFor(sent))
    expect(await embedder.embedQuery('x')).toHaveLength(EMBEDDING_DIMENSIONS)
    expect(calls).toHaveLength(2)
  })

  it('gives up after the configured attempts on a persistent server error', async () => {
    const calls = stubWorkersAi(() => new Response('down', { status: 503 }))
    await expect(embedder.embedQuery('x')).rejects.toMatchObject({ retryable: true })
    expect(calls).toHaveLength(2)
  })

  it('retries an unreachable service and an unreadable body', async () => {
    let call = 0
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
      call++
      if (call === 1) throw new TypeError('fetch failed')
      if (call === 2) return new Response('<html>not json</html>')
      const sent = JSON.parse(String(init.body))
      return replyWith(sent.text.map(() => vector(0)))
    })
    const patient = createWorkersAiEmbedder({ accountId: ACCOUNT, apiToken: TOKEN, maxAttempts: 3 })
    expect(await patient.embedQuery('x')).toHaveLength(EMBEDDING_DIMENSIONS)
    expect(call).toBe(3)
  })
})

describe('no error carries a credential', () => {
  const echoed = `Bearer ${TOKEN} at /accounts/${ACCOUNT}/ai/run`
  const leaks = (message: string) => message.includes(TOKEN) || message.includes(ACCOUNT)

  it.each<[string, () => Response]>([
    ['a refusal that echoes the request', () => refusal(400, 7000, echoed)],
    ['credentials refused', () => refusal(403, 10000, echoed)],
    ['a server error', () => refusal(500, 7000, echoed)],
    ['the daily limit', () => refusal(429, 4006, echoed)],
    ['an over-long input', () => refusal(400, 8007, `Sequence too long: 9613 > 8192 ${echoed}`)],
    ['a body that is not JSON', () => new Response(echoed, { status: 400 })],
    ['success: false on a 200', () => refusal(200, 7000, echoed)],
  ])('%s', async (_name, reply) => {
    stubWorkersAi(() => reply())
    const failure = await embedder.embedQuery('x').catch(e => e)
    expect(failure).toBeInstanceOf(EmbeddingError)
    expect(leaks(failure.message)).toBe(false)
  })

  it('an unreachable service, whatever the failure says about the request', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new Error(`connect failed: ${echoed}`)
    })
    const failure = await embedder.embedQuery('x').catch(e => e)
    expect(failure.message).toMatch(/Could not reach the embedding service: connect failed/)
    expect(leaks(failure.message)).toBe(false)
  })

  it('a refusal keeps the part of the reason that is not secret', async () => {
    stubWorkersAi(() => refusal(400, 7000, `No route for that URI: ${echoed}`))
    const failure = await embedder.embedQuery('x').catch(e => e)
    expect(failure.message).toMatch(/HTTP 400, code 7000.*No route for that URI/)
  })
})
