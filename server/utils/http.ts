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

export function conflict(message: string) {
  return createError({ statusCode: 409, statusMessage: 'Conflict', message })
}

/** Route param `id`, validated as a UUID so storage keys can never be steered. */
export function requireMeetingId(event: H3Event): string {
  const parsed = meetingIdSchema.safeParse(getRouterParam(event, 'id'))
  if (!parsed.success) throw notFound('Meeting not found')
  return parsed.data
}
