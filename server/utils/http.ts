import type { H3Event } from 'h3'
import { z } from 'zod'
import { meetingIdSchema } from '#shared/schemas/meeting'

/** 400 with zod's readable issue list in `data` when validation failed. */
export function badRequest(message: string, error?: z.ZodError) {
  return createError({
    statusCode: 400,
    statusMessage: 'Bad Request',
    message,
    data: error ? { issues: z.prettifyError(error) } : undefined,
  })
}

export function notFound(message = 'Not Found') {
  return createError({ statusCode: 404, statusMessage: 'Not Found', message })
}

/**
 * "Not now", not "failed": say when, in the header for any client and in the body
 * for the page. Relative as well as absolute, because the page holds off by its
 * own clock, which need not agree with the server's.
 */
export function retryLater(event: H3Event, retryAt: Date): { retryAt: string, retryAfterSec: number } {
  const seconds = Math.max(1, Math.ceil((retryAt.getTime() - Date.now()) / 1000))
  setResponseHeader(event, 'retry-after', seconds)
  return { retryAt: retryAt.toISOString(), retryAfterSec: seconds }
}

export function conflict(message: string) {
  return createError({ statusCode: 409, statusMessage: 'Conflict', message })
}

/**
 * Route param `id`, validated as a UUID so storage keys can never be steered, and in lower case:
 * Postgres compares a uuid in either case, and the local drivers' keys must name the same row on
 * a case-sensitive file system too.
 */
export function requireMeetingId(event: H3Event): string {
  const parsed = meetingIdSchema.safeParse(getRouterParam(event, 'id'))
  if (!parsed.success) throw notFound('Meeting not found')
  return parsed.data.toLowerCase()
}
