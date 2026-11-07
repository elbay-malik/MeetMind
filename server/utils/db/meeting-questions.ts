/**
 * The daily count of questions on each meeting but the public demo, shared by every server
 * instance (ADR-0020). The demo keeps its own count (ADR-0019), and never calls any of this.
 */

export interface MeetingQuestionRepository {
  readonly kind: 'supabase' | 'local'
  /** Whether today's count on this meeting has reached the limit. Reads, and writes nothing. */
  overCount(options: { limit: number, meetingId: string }): Promise<boolean>
  /**
   * Count one of today's questions on this meeting if the limit allows, and say whether it did.
   * Concurrent callers cannot take more than the limit between them. Also deletes earlier days'
   * counts, of every meeting.
   */
  take(options: { limit: number, meetingId: string }): Promise<boolean>
}
