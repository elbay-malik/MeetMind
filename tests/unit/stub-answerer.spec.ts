import { describe, expect, it } from 'vitest'
import { createStubAnswerer } from '../../server/utils/qa/stub-answerer'
import type { TranscriptSegment } from '../../shared/types/meeting'

const segment = (idx: number, text: string): TranscriptSegment => ({ idx, startMs: idx * 5_000, endMs: idx * 5_000 + 4_800, text })

describe('stub answerer', () => {
  it('cites the retrieved line sharing the most meaningful words with the question', async () => {
    const segments = [
      segment(10, 'We agreed to cut the marketing budget by twenty percent next quarter.'),
      segment(11, 'general update with nothing notable'),
    ]
    const result = await createStubAnswerer().answer({ question: 'What did we decide about the marketing budget?', segments })
    expect(result.citations).toEqual([{ quote: segments[0]!.text, segmentIdx: 10 }])
  })

  it('cites nothing when no retrieved line shares a meaningful word', async () => {
    const segments = [segment(10, 'general update with nothing notable')]
    const result = await createStubAnswerer().answer({ question: 'What did we decide about the marketing budget?', segments })
    expect(result.citations).toEqual([])
  })

  it('does not let a shared long stopword outrank a real answer worded differently', async () => {
    // The bug this guards: the first fix only dropped words under 4 characters
    // ("the", "for"), so a longer filler word like "about" still counted as
    // "meaningful" and could outscore the true answer whenever it happens to be
    // phrased with a different word ("hires" here, not "hiring" as asked) —
    // the exact scenario an adversarial self-review of this branch surfaced.
    // The fix must stop the wrong line winning; it is not expected to make the
    // stub understand "hires" and "hiring" are the same word; a stub with no
    // real overlap correctly reports nothing found rather than confidently
    // citing the wrong line.
    const segments = [
      segment(10, 'The CEO approved two new hires for the design team.'),
      segment(11, 'About the office parking policy, nothing changed this month.'),
    ]
    const result = await createStubAnswerer().answer({ question: 'What did the CEO decide about hiring?', segments })
    expect(result.citations).toEqual([])
  })
})
