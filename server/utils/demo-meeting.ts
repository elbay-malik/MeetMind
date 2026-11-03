import type { H3Event } from 'h3'
import { DEMO_READ_ONLY_MESSAGE, isDemoMeetingId } from '#shared/utils/meeting'

/** Whether this id is the public demo's: see {@link isDemoMeetingId}. */
export function isPublicDemo(event: H3Event, id: string): boolean {
  return isDemoMeetingId(useRuntimeConfig(event).public.demoMeetingId, id)
}

/**
 * Refuse anything that would move the public demo meeting along (ADR-0015). A meeting's
 * id is the capability to drive its pipeline (ADR-0012, ADR-0013), and this one's id is
 * on the home page, so here holding it proves nothing: a demo that is not quite finished
 * would otherwise spend provider quota, or change, for anyone who asked. Reading and
 * asking questions stay open, and an operator finishes or repairs the meeting with the
 * variable unset. Holding the invite code makes no difference: that is for uploading.
 */
export function refuseOnPublicDemo(event: H3Event, id: string): void {
  if (isPublicDemo(event, id)) {
    throw createError({
      statusCode: 403,
      statusMessage: 'Forbidden',
      message: DEMO_READ_ONLY_MESSAGE,
    })
  }
}
