/**
 * The daily count of new meetings across the whole app, shared by every server instance
 * (ADR-0020). Only `POST /api/meetings` calls it, after the invite code has passed.
 */

export interface RegistrationRepository {
  readonly kind: 'supabase' | 'local'
  /**
   * Count one of today's new meetings if the limit allows, and say whether it did. Concurrent
   * callers cannot take more than the limit between them. Also deletes earlier days' counts.
   */
  take(limit: number): Promise<boolean>
}
