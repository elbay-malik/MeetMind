/**
 * Request slots per provider, shared by every server instance (ADR-0012).
 *
 * A provider's rate limit is per account, so pacing has to be decided somewhere
 * every instance sees. On Workers an in-memory queue is per isolate, and many
 * isolates run at once, so it paced nothing.
 */

/** The providers whose limits are paced here. */
export type SlotProvider = 'groq-chat' | 'groq-whisper'

export type SlotReservation
  = | { granted: true, slotAt: Date }
    | { granted: false, retryAt: Date }

export interface SlotRepository {
  readonly kind: 'supabase' | 'local'
  /**
   * Reserve the provider's next request slot if it starts within `maxWaitMs`,
   * and move the next one `intervalMs` past it. Concurrent callers get distinct
   * slots one interval apart. When the next slot is further off than that,
   * reserves nothing and says when it frees -- so a caller that gives up holds
   * no slot that would delay everyone after it.
   */
  reserve(provider: SlotProvider, options: { intervalMs: number, maxWaitMs: number }): Promise<SlotReservation>
  /** The provider refused with a 429: no slot starts before `retryAfterMs` from now. Never shortens a block. */
  noteRateLimit(provider: SlotProvider, retryAfterMs: number): Promise<void>
  /**
   * The end of the provider's current Retry-After block, or null when there is
   * none. A slot reserved before a 429 was noted can fall inside the block the
   * 429 created, so a caller that waited for its slot checks this before sending.
   */
  blockedUntil(provider: SlotProvider): Promise<Date | null>
}

/** The persisted state of one provider's slots. */
export interface SlotState {
  nextAvailableAt: number
  blockedUntil: number
}

/**
 * The reservation rule, for the local driver. A deliberate mirror of
 * `public.reserve_slot` in supabase/migrations/20261025120000_provider_slots.sql;
 * scripts/verify-migrations.sh asserts the SQL against the same cases
 * tests/unit/slots.spec.ts asserts this against.
 */
export function reserveFrom(
  state: SlotState,
  { intervalMs, maxWaitMs }: { intervalMs: number, maxWaitMs: number },
  now: number,
): { next: SlotState, reservation: SlotReservation } {
  // A NaN or negative interval would store a NaN slot (pacing silently off) or
  // move the next slot backwards; the SQL refuses the same inputs.
  if (!Number.isFinite(intervalMs) || intervalMs < 0 || !Number.isFinite(maxWaitMs) || maxWaitMs < 0) {
    throw new Error(`Slot interval and wait must be non-negative numbers, got ${intervalMs} and ${maxWaitMs}`)
  }
  const start = Math.max(now, state.nextAvailableAt, state.blockedUntil)
  if (start > now + maxWaitMs) {
    return { next: state, reservation: { granted: false, retryAt: new Date(start) } }
  }
  return {
    next: { ...state, nextAvailableAt: start + intervalMs },
    reservation: { granted: true, slotAt: new Date(start) },
  }
}
