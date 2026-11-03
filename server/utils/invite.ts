import type { H3Event } from 'h3'
import { INVITE_REFUSED_MESSAGE, UPLOADS_CLOSED_MESSAGE } from '#shared/utils/invite'
import { bearerToken, MIN_ADMIN_TOKEN_LENGTH, secretMatches } from './admin'

/** The admin token's rule, for the same reason: a short one is guessable. */
export const MIN_INVITE_CODE_LENGTH = MIN_ADMIN_TOKEN_LENGTH

/**
 * Admit the request only if it carries `Authorization: Bearer <NUXT_INVITE_CODE>`
 * (ADR-0015). In a header because URLs land in logs and browser history. First in
 * every route it guards, so a refused caller costs no body parsing, budget check,
 * storage or provider call.
 *
 * FAILS CLOSED, even under `pnpm dev`, where other absent settings select a stub
 * (ADR-0016): with no usable code, nobody may upload, and that includes someone presenting the
 * short code exactly. A missing setting must never read as "open". Whitespace does not
 * count towards the length, since a header cannot carry it to compare against: a secret
 * store that kept a pasted newline would otherwise lock everyone out with no warning.
 *
 * The same answer for a missing code, a wrong one and a nearly right one, so a refusal
 * says nothing about how close a guess was.
 */
export async function requireInviteCode(event: H3Event): Promise<void> {
  const configured = String(useRuntimeConfig(event).inviteCode ?? '').trim()
  if (configured.length < MIN_INVITE_CODE_LENGTH) {
    console.warn(`[meetmind] NUXT_INVITE_CODE is unset or shorter than ${MIN_INVITE_CODE_LENGTH} characters, so uploads are closed for everyone`)
    throw createError({ statusCode: 503, statusMessage: 'Service Unavailable', message: UPLOADS_CLOSED_MESSAGE })
  }
  if (!(await secretMatches(bearerToken(event), configured))) {
    setResponseHeader(event, 'WWW-Authenticate', 'Bearer')
    throw createError({ statusCode: 401, statusMessage: 'Unauthorized', message: INVITE_REFUSED_MESSAGE })
  }
}
