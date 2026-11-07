import type { H3Event } from 'h3'
import { useMeetingRepository } from './db'

/**
 * Refuse an upload that would take the object store past a self-imposed ceiling.
 *
 * R2 has no spending cap. Past the free allowance Cloudflare bills rather than
 * refusing, and the only usage notification needs a Professional plan, so the
 * limit has to live here. Storage is the charge worth guarding: it is $0.015 per
 * GB-month for as long as the object exists, so unlike the per-request
 * operation charges it accumulates and recurs.
 *
 * Nothing bounded it before. `POST /api/meetings` takes one shared invite code
 * (ADR-0015), so anyone holding it could grow a standing monthly bill with an
 * upload loop; the only way to reverse it is the admin-only DELETE (ADR-0011),
 * which an operator has to notice the need for. The bucket's lifecycle rule
 * caps how long each object survives, which bounds slow growth, but it does
 * nothing inside a burst -- a script can add hundreds of gigabytes in a day and
 * pay for all of it for a month. This is the part that stops rather than warns.
 *
 * Deliberately NOT metering per-request operations as well. Class B is now one
 * operation per audio request and costs $0.36 per million, and a counter row
 * written on every request would cost more in latency and database quota than
 * the charge it guards -- the same trap the route's removed HEAD was. An
 * in-memory counter is worse than nothing on Workers, where isolates are
 * short-lived and per-request, so it would under-count without saying so.
 * Bounding request volume is rate limiting's job, not a budget's.
 */
export async function assertStorageBudget(event: H3Event, incomingBytes: number): Promise<void> {
  const config = useRuntimeConfig(event)
  const ceiling = Number(config.r2MaxStoredBytes)
  // A ceiling of zero disables the check. An unparseable one does NOT: a typo
  // in the environment must not silently remove the only limit there is.
  if (ceiling === 0) return
  if (!Number.isFinite(ceiling) || ceiling < 0) {
    throw new Error(`NUXT_R2_MAX_STORED_BYTES is not a usable byte count: ${JSON.stringify(config.r2MaxStoredBytes)}`)
  }

  const stored = await useMeetingRepository(event).storedAudioBytes({
    retentionDays: Number(config.r2RetentionDays),
    reservationSeconds: UPLOAD_RESERVATION_SEC,
  })

  if (stored + incomingBytes > ceiling) {
    // 507 rather than 429: the request is not too frequent, the store is full,
    // and retrying the same upload later only helps once something expires.
    throw createError({
      statusCode: 507,
      statusMessage: 'Insufficient Storage',
      message: 'The audio archive is full. No further recordings can be stored until existing ones expire.',
      data: { storedBytes: stored, ceilingBytes: ceiling, requestedBytes: incomingBytes },
    })
  }
}

/**
 * How long the browser has to PUT the audio after registering the meeting.
 *
 * Lives here rather than in the route because the budget needs it too: a
 * registration whose upload URL is still valid has reserved its bytes, and the
 * two numbers going out of step would either double-count or under-count them.
 *
 * Five minutes is enough because the browser PUTs straight after registering,
 * and the store checks the expiry when an upload STARTS, not when it finishes: a
 * large recording on a slow link only has to begin inside the window, and may
 * go on landing after it (meeting-deletion.ts's grace covers that). A shorter
 * life means a registered URL can be replayed for less time. The local driver's
 * grant lives exactly as long.
 */
export const UPLOAD_URL_TTL_SEC = 5 * 60

/**
 * How long past its expiry an upload URL is still treated as live.
 *
 * R2 checks a presigned URL's expiry when the PUT starts, not when it finishes,
 * so an upload begun a second before expiry can still be landing well after it.
 * A 25 MB cap on a slow connection takes minutes; this is comfortably more.
 *
 * Lives beside the TTL because both the budget and meeting-deletion.ts add it
 * to the TTL, and meeting-deletion.ts already imports from here (the other way
 * round would be a circular import).
 */
export const UPLOAD_GRACE_SEC = 15 * 60

/**
 * How long a registration that has not completed keeps its bytes reserved: the
 * URL's lifetime plus the grace for a PUT still landing after it. The same
 * window the delete route waits out, so the budget stops counting a pending
 * upload no earlier than the point where its bytes can no longer arrive. Until
 * `complete` sets `uploaded_at`, this reservation is the only place those bytes
 * are counted.
 */
export const UPLOAD_RESERVATION_SEC = UPLOAD_URL_TTL_SEC + UPLOAD_GRACE_SEC
