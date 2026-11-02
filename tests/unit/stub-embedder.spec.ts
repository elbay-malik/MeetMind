import { describe, expect, it } from 'vitest'
import { EmbeddingInputTooLongError, MAX_INPUT_TOKENS } from '../../server/utils/qa/embedder'
import { createStubEmbedder, hashedTokenVector, STUB_EMBEDDING_MODEL } from '../../server/utils/qa/stub'
import { estimateTokens } from '../../server/utils/summary/plan'

const cosine = (a: number[], b: number[]) => a.reduce((sum, v, i) => sum + v * b[i]!, 0)

describe('stub embedder', () => {
  const embedder = createStubEmbedder()

  it('produces unit-length vectors of the schema\'s size', async () => {
    const [v] = await embedder.embedDocuments(['We agreed to ship the billing change on Friday.'])
    expect(v).toHaveLength(1024)
    expect(Math.sqrt(cosine(v!, v!))).toBeCloseTo(1, 10)
  })

  it('is not called what it was at 768 dimensions', () => {
    // The name is what tells a stored index apart. Reusing it would read an old
    // local index as current, and the first question would fail on the sizes.
    expect(STUB_EMBEDDING_MODEL).not.toBe('stub-hashed-tokens-v1')
  })

  it('is deterministic', () => {
    expect(hashedTokenVector('the budget review')).toEqual(hashedTokenVector('the budget review'))
  })

  it('scores a question closer to the window that answers it than to an unrelated one', async () => {
    // The property that makes retrieval testable without credentials: the
    // window sharing the question's words must outrank the one that does not.
    const [billing, hiring] = await embedder.embedDocuments([
      'We agreed to ship the billing change on Friday after the review.',
      'Priya will interview two candidates for the design role next week.',
    ])
    const question = await embedder.embedQuery('When does the billing change ship?')
    expect(cosine(question, billing!)).toBeGreaterThan(cosine(question, hiring!))
    expect(cosine(question, billing!)).toBeGreaterThan(0)
  })

  it('ignores case and punctuation the way citation matching does', () => {
    expect(hashedTokenVector('Ship the BILLING change!')).toEqual(hashedTokenVector('ship the billing change'))
  })

  it('matches no-space scripts by character, not as one opaque token', () => {
    // Uses reconciliation's script-aware tokenizer: a Japanese sentence and a
    // fragment of it share characters, so they must score as related.
    const sentence = hashedTokenVector('来週までに移行計画を作成します')
    const fragment = hashedTokenVector('移行計画')
    expect(cosine(sentence, fragment)).toBeGreaterThan(0.3)
  })

  it('embeds text with no tokens as the zero vector, not NaN', () => {
    const v = hashedTokenVector('  —!?  ')
    expect(v.every(x => x === 0)).toBe(true)
  })

  it('embeds a question and a document of the same text identically', async () => {
    const [doc] = await embedder.embedDocuments(['budget'])
    expect(await embedder.embedQuery('budget')).toEqual(doc)
  })

  it('refuses a text over the model\'s limit, as the real provider does', async () => {
    const huge = Array.from({ length: 6_000 }, (_, i) => `word${i}`).join(' ')
    expect(estimateTokens(huge)).toBeGreaterThan(MAX_INPUT_TOKENS)
    await expect(embedder.embedDocuments(['fine', huge])).rejects.toBeInstanceOf(EmbeddingInputTooLongError)
    await expect(embedder.embedQuery(huge)).rejects.toBeInstanceOf(EmbeddingInputTooLongError)
  })

  it('accepts a text at the limit', async () => {
    const atLimit = Array.from({ length: 5_000 }, () => 'word').join(' ')
    expect(estimateTokens(atLimit)).toBeLessThanOrEqual(MAX_INPUT_TOKENS)
    await expect(embedder.embedQuery(atLimit)).resolves.toHaveLength(1024)
  })

  it('refuses as the provider does at its daily limit, only when told to, and only for that text', async () => {
    const canary = createStubEmbedder({ quotaCanary: 'CANARY' })
    await expect(canary.embedQuery('has CANARY in it')).rejects.toMatchObject({
      statusCode: 429, retryable: false, message: expect.stringMatching(/free daily limit.*00:00 UTC/),
    })
    await expect(canary.embedDocuments(['fine', 'has CANARY in it'])).rejects.toMatchObject({ statusCode: 429 })
    await expect(canary.embedQuery('no such word')).resolves.toHaveLength(1024)
    // Nothing is refused for a stub that was not told a canary.
    await expect(embedder.embedQuery('has CANARY in it')).resolves.toHaveLength(1024)
  })
})
