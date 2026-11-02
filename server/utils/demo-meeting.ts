import type { H3Event } from 'h3'

/**
 * Refuse anything that would move the public demo meeting along (ADR-0015). A meeting's
 * id is the capability to drive its pipeline (ADR-0012, ADR-0013), and this one's id is
 * on the home page, so here holding it proves nothing: a demo that is not quite finished
 * would otherwise spend provider quota, or change, for anyone who asked. Reading and
 * asking questions stay open, and an operator finishes or repairs the meeting with the
 * variable unset. Holding the invite code makes no difference: that is for uploading.
 *
 * Compared in lower case: `requireMeetingId` accepts a UUID in capitals, which is the
 * same row to Postgres, and the configured id may be written either way. Trimmed, as
 * `requireInviteCode` trims its setting: a secret store that kept a pasted newline would
 * otherwise turn this guard off with no warning.
 */
export function refuseOnPublicDemo(event: H3Event, id: string): void {
  const demoId = String(useRuntimeConfig(event).public.demoMeetingId ?? '').trim()
  if (demoId && demoId.toLowerCase() === id.toLowerCase()) {
    throw createError({
      statusCode: 403,
      statusMessage: 'Forbidden',
      message: 'The demo meeting is read-only: it can be read and asked questions, not changed.',
    })
  }
}
