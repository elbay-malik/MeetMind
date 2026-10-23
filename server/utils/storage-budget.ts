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
 * Nothing bounded it before. `POST /api/meetings` is anonymous and there is no
 * DELETE route anywhere in the API, so an upload loop could grow a standing
 * monthly bill with no in-app way to reverse it. The bucket's lifecycle rule
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
    reservationSeconds: UPLOAD_URL_TTL_SEC,
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
 */
export const UPLOAD_URL_TTL_SEC = 15 * 60
