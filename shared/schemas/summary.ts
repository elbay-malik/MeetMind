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
 *
 * The descriptions are part of the contract too: `z.toJSONSchema` writes each
 * one as the field's `description`, which strict mode passes to the model
 * beside the field it describes (tests/unit/groq-summarizer.spec.ts checks
 * that they survive `toStrictJsonSchema`). `summary` needs one most. The
 * meeting's overview is the chunks' summaries joined (mergeReconciled in
 * server/utils/summary/reconcile.ts), so a chunk that says "nothing was
 * decided" contradicts the lists as soon as another chunk decides something.
 * The definitions of a decision and an action item are in the instructions
 * (server/utils/summary/groq.ts); these stay short, since every character is
 * sent with every chunk (tests/unit/groq-token-budget.spec.ts).
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
  assignee: z.string().nullable().describe('The person given responsibility, or null.'),
  dueDateText: z.string().nullable(),
})

export const wireSummarySchema = z.object({
  summary: z.string().describe(
    'Two or three sentences on what this part of the meeting discussed. Never state what '
    + 'was or was not decided or assigned; the lists carry that.',
  ),
  decisions: z.array(wireDecisionSchema),
  actionItems: z.array(wireActionItemSchema),
})

export type WireSummary = z.output<typeof wireSummarySchema>

/**
 * What we accept after reconciling the model's answer against the transcript.
 * Enforced by `reconcile()` (server/utils/summary/reconcile.ts) as a defensive
 * assertion on its own output, not requested from the model.
 */
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

/**
 * The full contract, for documentation and for tests/services once a real key
 * exists (mirroring how meetingSchema is used there for meetings). Its two
 * item schemas are independently enforced at runtime by `reconcile()`; this
 * one additionally covers `summary` and `provider`.
 */
export const meetingSummarySchema = z.object({
  summary: z.string(),
  decisions: z.array(decisionSchema),
  actionItems: z.array(actionItemSchema),
  provider: z.enum(['groq', 'stub']),
}) satisfies z.ZodType<MeetingSummary>
