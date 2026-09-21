import { z } from 'zod'
import { MAX_QUESTION_CHARS } from './qa'

/**
 * A cross-meeting search query is embedded the same way a question is
 * (ADR-0008), so it is held to the same length rather than inventing a
 * second, unrelated limit.
 */
export const searchQuerySchema = z.object({
  q: z.string().trim().min(1).max(MAX_QUESTION_CHARS),
}).strict()
