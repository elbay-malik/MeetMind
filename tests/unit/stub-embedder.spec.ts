import { describe, expect, it } from 'vitest'
import { createStubEmbedder, hashedTokenVector } from '../../server/utils/qa/stub'

const cosine = (a: number[], b: number[]) => a.reduce((sum, v, i) => sum + v * b[i]!, 0)

describe('stub embedder', () => {
  const embedder = createStubEmbedder()

  it('produces unit-length vectors of the schema\'s size', async () => {
    const [v] = await embedder.embedDocuments(['We agreed to ship the billing change on Friday.'])
    expect(v).toHaveLength(768)
    expect(Math.sqrt(cosine(v!, v!))).toBeCloseTo(1, 10)
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
})
