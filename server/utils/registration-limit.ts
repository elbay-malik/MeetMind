import type { H3Event } from 'h3'
import { NEW_MEETINGS_USED_MESSAGE, UPLOADS_UNAVAILABLE_MESSAGE } from '#shared/utils/meeting'
import { nextUtcMidnight } from './db/demo-questions'
import type { RegistrationRepository } from './db/registrations'
import { retryLater } from './http'

/**
 * New meetings the whole app registers in a UTC day (ADR-0020). Every meeting can go on to
 * spend the transcription, extraction and indexing quotas and stored bytes that every meeting
 * shares, and registering one takes only the shared invite code, so new meetings have a daily
 * ceiling and the free quotas stay available. Thirty is more recordings in a day than the
 * handful of people with the code upload. A constant and not a setting, as the count of
 * questions per meeting is.
 */
export const MEETINGS_PER_DAY = 30

/**
 * Count this registration against today's ceiling, or refuse it. Called after the invite code
 * and the body have passed and after the storage budget, and before the upload URL is issued:
 * a request without a valid code, a malformed one or one the store has no room for uses none of
 * the day, and a refusal here comes before anything that spends.
 *
 * Over the ceiling is a 429 with the next 00:00 UTC, as the question counts answer. A take that
 * did not work fails closed, with a fixed sentence for the page and the words in the log.
 */
export async function takeRegistration(event: H3Event, repo: RegistrationRepository, now: () => number = Date.now): Promise<void> {
  let taken: boolean
  try {
    taken = await repo.take(MEETINGS_PER_DAY)
  }
  catch (err) {
    console.warn('[meetmind] counting a new meeting failed, so it was refused:', err)
    throw createError({ statusCode: 503, statusMessage: 'Service Unavailable', message: UPLOADS_UNAVAILABLE_MESSAGE })
  }
  if (!taken) {
    throw createError({
      statusCode: 429,
      statusMessage: 'Too Many Requests',
      message: NEW_MEETINGS_USED_MESSAGE,
      data: retryLater(event, nextUtcMidnight(now())),
    })
  }
}
