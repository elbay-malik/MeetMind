import { z } from 'zod'

/** Longest question accepted. A question is embedded and sent to the answering
 * model alongside the retrieved lines; an essay here only spends tokens. */
export const MAX_QUESTION_CHARS = 500

export const askBodySchema = z.object({
  question: z.string().trim().min(1).max(MAX_QUESTION_CHARS),
}).strict()

/**
 * What the answering model is asked to produce.
 *
 * Free of constraints for the same reason as the summary wire schema: strict
 * mode rejects them, and what matters is checked against the transcript
 * afterwards. Key order is load-bearing here too — `citations` before `answer`
 * makes "find the evidence, then answer" a property of constrained decoding,
 * and within a citation the quote comes before the line number.
 */
export const wireCitationSchema = z.object({
  quote: z.string(),
  segmentIdx: z.number(),
})

export const wireAnswerSchema = z.object({
  citations: z.array(wireCitationSchema),
  answer: z.string(),
})

export type WireAnswer = z.output<typeof wireAnswerSchema>
