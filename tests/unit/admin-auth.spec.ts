import { describe, expect, it } from 'vitest'
import { secretMatches, MIN_ADMIN_TOKEN_LENGTH } from '../../server/utils/admin'

// requireAdmin() itself is not covered here: it reaches for useRuntimeConfig,
// getRequestHeader and createError through Nuxt auto-imports, which only exist
// inside a built server. Its HTTP behaviour (404 when unconfigured, 500 for a
// short token, 401 + WWW-Authenticate for a missing or wrong bearer) is
// exercised end to end in tests/e2e instead. What is left to pin down here is
// the comparison it delegates to, since a bug there silently opens the route.

const expected = 'a'.repeat(MIN_ADMIN_TOKEN_LENGTH - 1) + 'Z'

describe('secretMatches', () => {
  it('accepts the exact token', async () => {
    expect(await secretMatches(expected, expected)).toBe(true)
  })

  // The MAC comparison has no early exit, so the classic bug is not "stops at
  // the first difference" but "compares the wrong thing" -- e.g. MACing the
  // same value twice. A one-character miss at the very end is the closest
  // guess there is, and must still be refused.
  it('refuses a token that differs only in its last character', async () => {
    expect(await secretMatches(expected.slice(0, -1) + 'Y', expected)).toBe(false)
  })

  // Lengths are allowed to differ (a MAC is fixed-size), which is exactly why
  // a prefix or an extension has to be checked: a comparison that only looked
  // at the overlapping part would accept both.
  it('refuses a prefix of the token', async () => {
    expect(await secretMatches(expected.slice(0, -1), expected)).toBe(false)
  })

  it('refuses the token with extra characters appended', async () => {
    expect(await secretMatches(`${expected}x`, expected)).toBe(false)
  })

  // An empty bearer is what a client sends when its own config is missing; it
  // must never match a configured token.
  it('refuses an empty token', async () => {
    expect(await secretMatches('', expected)).toBe(false)
  })
})
