import { afterEach, describe, expect, it, vi } from 'vitest'
import { EMBEDDING_DIMENSIONS, EmbeddingError } from '../../server/utils/qa/embedder'
import { createGeminiEmbedder, GEMINI_EMBEDDING_MODEL, MAX_BATCH } from '../../server/utils/qa/gemini'

const embedder = createGeminiEmbedder({ apiKey: 'test-key' })

const vector = (seed: number, length = EMBEDDING_DIMENSIONS) =>
  Array.from({ length }, (_, i) => (seed + i) / 10_000)

interface Sent { url: string, headers: Headers, body: { requests: Array<Record<string, unknown>> } }

/** Reply to each request with `respond`, recording what was sent. */
function stubGemini(respond: (sent: Sent, call: number) => Response | Promise<Response>) {
  const calls: Sent[] = []
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    const sent = { url, headers: new Headers(init.headers), body: JSON.parse(String(init.body)) }
    calls.push(sent)
    return respond(sent, calls.length)
  })
  return calls
}

/** A well-formed reply with one vector per requested text. */
const embeddingsFor = (sent: Sent, offset = 0) => Response.json({
  embeddings: sent.body.requests.map((_, i) => ({ values: vector(offset + i) })),
})

afterEach(() => vi.unstubAllGlobals())

describe('request', () => {
  it('batches to batchEmbedContents with the key in a header, never the URL', async () => {
    const calls = stubGemini(sent => embeddingsFor(sent))
    await embedder.embedDocuments(['hello'])

    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_EMBEDDING_MODEL}:batchEmbedContents`,
    )
    // A key in the query string ends up in access logs and error reports.
    expect(calls[0]!.url).not.toContain('test-key')
    expect(calls[0]!.headers.get('x-goog-api-key')).toBe('test-key')
  })

  it('labels a window as a document and asks for 768 dimensions through the current config field', async () => {
    const calls = stubGemini(sent => embeddingsFor(sent))
    await embedder.embedDocuments(['We agreed to ship on Friday.'])

    const request = calls[0]!.body.requests[0]!
    expect(request).toEqual({
      model: `models/${GEMINI_EMBEDDING_MODEL}`,
      content: { parts: [{ text: 'title: none | text: We agreed to ship on Friday.' }] },
      embedContentConfig: { outputDimensionality: 768 },
    })
    // The top-level field is deprecated in the API reference.
    expect(request).not.toHaveProperty('outputDimensionality')
    expect(request).not.toHaveProperty('taskType')
  })

  it('labels a question as a question-answering query', async () => {
    const calls = stubGemini(sent => embeddingsFor(sent))
    await embedder.embedQuery('What did we decide about the budget?')
    expect(calls[0]!.body.requests[0]!.content).toEqual({
      parts: [{ text: 'task: question answering | query: What did we decide about the budget?' }],
    })
  })

  it('sends nothing for an empty list', async () => {
    const calls = stubGemini(sent => embeddingsFor(sent))
    expect(await embedder.embedDocuments([])).toEqual([])
    expect(calls).toHaveLength(0)
  })

  it(`splits more than ${MAX_BATCH} texts into sequential batches and keeps every vector with its text`, async () => {
    let offset = 0
    const calls = stubGemini((sent) => {
      const reply = embeddingsFor(sent, offset)
      offset += sent.body.requests.length
      return reply
    })
    const texts = Array.from({ length: MAX_BATCH * 2 + 5 }, (_, i) => `text ${i}`)
    const vectors = await embedder.embedDocuments(texts)

    expect(calls.map(c => c.body.requests.length)).toEqual([MAX_BATCH, MAX_BATCH, 5])
    expect(vectors).toHaveLength(texts.length)
    // The Nth vector belongs to the Nth text across batch boundaries.
    for (const i of [0, MAX_BATCH - 1, MAX_BATCH, texts.length - 1]) {
      expect(vectors[i]![0]).toBe(i / 10_000)
    }
  })
})

describe('response validation', () => {
  it('refuses a vector of the wrong size instead of storing it, without retrying', async () => {
    // What a silently ignored dimension setting looks like: the 3,072 default.
    const calls = stubGemini(() => Response.json({ embeddings: [{ values: vector(0, 3072) }] }))
    await expect(embedder.embedDocuments(['x'])).rejects.toThrow(/768-dimension embedding, got 3072/)
    expect(calls).toHaveLength(1)
  })

  it('refuses a reply with a different number of vectors than texts sent', async () => {
    // Pairing by position would put every later vector on the wrong window.
    stubGemini(() => Response.json({ embeddings: [{ values: vector(0) }] }))
    await expect(embedder.embedDocuments(['a', 'b'])).rejects.toThrow(/Expected 2 embeddings, got 1/)
  })

  it('refuses a vector containing a non-finite value', async () => {
    const bad = vector(0)
    bad[10] = Number.NaN
    // JSON has no NaN; a null in the payload is how it would arrive.
    stubGemini(() => new Response(JSON.stringify({ embeddings: [{ values: bad }] })))
    await expect(embedder.embedDocuments(['x'])).rejects.toThrow(/non-numeric or non-finite/)
  })
})

describe('failures', () => {
  it('reports a quota refusal as a 429, with the wait, and does not retry into it', async () => {
    const calls = stubGemini(() => new Response('quota', { status: 429, headers: { 'retry-after': '37' } }))
    const failure = await embedder.embedDocuments(['x']).catch(e => e)
    expect(failure).toBeInstanceOf(EmbeddingError)
    expect(failure).toMatchObject({ statusCode: 429, retryable: false })
    expect(failure.message).toMatch(/37s/)
    expect(calls).toHaveLength(1)
  })

  it('treats rejected credentials as final', async () => {
    const calls = stubGemini(() => new Response('nope', { status: 403 }))
    await expect(embedder.embedQuery('x')).rejects.toMatchObject({ retryable: false })
    expect(calls).toHaveLength(1)
  })

  it('retries a server error once, then succeeds', async () => {
    const calls = stubGemini((sent, call) => call === 1 ? new Response('down', { status: 503 }) : embeddingsFor(sent))
    expect(await embedder.embedQuery('x')).toHaveLength(768)
    expect(calls).toHaveLength(2)
  })

  it('gives up after the configured attempts on a persistent server error', async () => {
    const calls = stubGemini(() => new Response('down', { status: 503 }))
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
      return Response.json({ embeddings: sent.requests.map(() => ({ values: vector(0) })) })
    })
    const patient = createGeminiEmbedder({ apiKey: 'k', maxAttempts: 3 })
    expect(await patient.embedQuery('x')).toHaveLength(768)
    expect(call).toBe(3)
  })
})
