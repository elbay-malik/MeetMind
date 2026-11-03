/**
 * The public demo's daily count of questions, shared by every server instance (ADR-0019). Only
 * a question on the demo calls any of this.
 */

export interface DemoQuestionGate {
  /** Today's count has reached the limit. */
  overCount: boolean
  /** A meeting other than the demo has an extraction going on or stopped: `extractionInProgress`. */
  extractionPending: boolean
}

export interface DemoQuestionRepository {
  readonly kind: 'supabase' | 'local'
  /** Reads, and writes nothing, so refusing costs nobody a question. Cheap on a table of any size. */
  gate(options: { limit: number, demoMeetingId: string }): Promise<DemoQuestionGate>
  /**
   * Count one of today's questions if the limit allows, and say whether it did. Concurrent
   * callers cannot take more than the limit between them. Also deletes earlier days' counts.
   */
  take(limit: number): Promise<boolean>
}

/** The UTC day a moment falls on, as the table keys it. */
export function utcDay(at: number): string {
  return new Date(at).toISOString().slice(0, 10)
}

/** When the count starts again, which is what a refusal over it tells a caller. */
export function nextUtcMidnight(at: number): Date {
  const now = new Date(at)
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1))
}
