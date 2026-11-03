import type { H3Event } from 'h3'
import { notFound } from './http'

/**
 * Shortest admin token accepted. A configured token below this is refused
 * loudly rather than used: the token is the only thing between the internet
 * and an irreversible delete, and a short one is guessable.
 */
export const MIN_ADMIN_TOKEN_LENGTH = 32

const encoder = new TextEncoder()

/**
 * Whether `provided` equals `expected`, in time that does not depend on where
 * they first differ.
 *
 * A plain `===` returns as soon as a character differs, which leaks how much of
 * a guess was right. Both values are MACed under a key that exists only for
 * this call, and Web Crypto's `verify` compares the MACs -- the same approach
 * signed-token.ts takes, and for the same reason: `node:crypto.timingSafeEqual`
 * is not available on Workers. Lengths can differ freely; a MAC is fixed-size.
 */
export async function secretMatches(provided: string, expected: string): Promise<boolean> {
  const key = await crypto.subtle.generateKey({ name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify'])
  const expectedMac = await crypto.subtle.sign('HMAC', key, encoder.encode(expected))
  return crypto.subtle.verify('HMAC', key, expectedMac, encoder.encode(provided))
}

/**
 * The token in `Authorization: Bearer <token>`, or an empty string when there is
 * none. Empty, not null, so a missing header takes the same path through
 * {@link secretMatches} as a wrong one, and no configured secret can equal it.
 */
export function bearerToken(event: H3Event): string {
  return /^Bearer (.+)$/i.exec(getRequestHeader(event, 'authorization') ?? '')?.[1] ?? ''
}

/**
 * Admit the request only if it carries `Authorization: Bearer <NUXT_ADMIN_TOKEN>`.
 *
 * With no token configured the admin surface does not exist: the caller gets
 * the same 404 an unknown route would, so an unconfigured deployment neither
 * accepts nor advertises it. There is deliberately no generated fallback (unlike
 * the local upload secret) -- a token nobody knows is the same as none, and a
 * random one would only make the route look enabled.
 */
export async function requireAdmin(event: H3Event): Promise<void> {
  // Trimmed, as the invite code is: a secret store can keep a pasted newline, which a header
  // cannot carry to compare against, and that would lock the operator out with no warning.
  const configured = String(useRuntimeConfig(event).adminToken ?? '').trim()
  if (!configured) throw notFound()
  if (configured.length < MIN_ADMIN_TOKEN_LENGTH) {
    throw new Error(`NUXT_ADMIN_TOKEN must be at least ${MIN_ADMIN_TOKEN_LENGTH} characters; refusing to use a shorter one`)
  }

  if (!(await secretMatches(bearerToken(event), configured))) {
    setResponseHeader(event, 'WWW-Authenticate', 'Bearer')
    throw createError({ statusCode: 401, statusMessage: 'Unauthorized', message: 'Admin token required' })
  }
}
