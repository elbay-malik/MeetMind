import { z } from 'zod'
import type { ActionItem, Decision, MeetingSummary } from '../types/meeting'

/**
 * What the model is asked to produce.
 *
 * Deliberately free of constraints: Groq's strict mode rejects the keywords
 * that make a storage schema useful (min/max, formats), and a constraint the
 * model cannot see is a constraint it cannot satisfy. Validation of ranges and
 * evidence happens afterwards, against the real transcript, where it can
 * actually be checked.
 *
 * Key order is load-bearing. Under constrained decoding the model emits keys in
 * schema order, so putting `quote` first makes "find the evidence, then state
 * the claim" a property of the schema rather than a request in prose.
 */
export const wireDecisionSchema = z.object({
  quote: z.string(),
  segmentIdx: z.number(),
  decision: z.string(),
})

export const wireActionItemSchema = z.object({
  quote: z.string(),
  segmentIdx: z.number(),
  task: z.string(),
  // Nullable, never optional. A present null is an answer — "nobody was named".
  // An absent key is a protocol violation and should be retried, not coerced.
  assignee: z.string().nullable(),
  dueDateText: z.string().nullable(),
})

export const wireSummarySchema = z.object({
  summary: z.string(),
  decisions: z.array(wireDecisionSchema),
  actionItems: z.array(wireActionItemSchema),
})

export type WireSummary = z.output<typeof wireSummarySchema>

/** What we accept after reconciling the model's answer against the transcript. */
export const decisionSchema = z.object({
  idx: z.int().nonnegative(),
  decision: z.string().min(1),
  quote: z.string().min(1),
  segmentIdx: z.int().nonnegative(),
  startMs: z.int().nonnegative(),
}) satisfies z.ZodType<Decision>

export const actionItemSchema = z.object({
  idx: z.int().nonnegative(),
  task: z.string().min(1),
  assignee: z.string().min(1).nullable(),
  dueDateText: z.string().min(1).nullable(),
  quote: z.string().min(1),
  segmentIdx: z.int().nonnegative(),
  startMs: z.int().nonnegative(),
}) satisfies z.ZodType<ActionItem>

export const meetingSummarySchema = z.object({
  summary: z.string(),
  decisions: z.array(decisionSchema),
  actionItems: z.array(actionItemSchema),
  provider: z.enum(['groq', 'stub']),
}) satisfies z.ZodType<MeetingSummary>
