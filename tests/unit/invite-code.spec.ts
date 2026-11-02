import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { MIN_INVITE_CODE_LENGTH, requireInviteCode } from '../../server/utils/invite'

/**
 * What the e2e specs cannot set up through an environment variable: the values a
 * runtime hands the config, whatever was written. The HTTP behaviour is exercised end
 * to end in tests/e2e/invite-api.spec.ts and invite-closed.spec.ts.
 */

const CODE = 'c'.repeat(MIN_INVITE_CODE_LENGTH)

let configured: unknown
let header: string | undefined

// Auto-imported from Nuxt's app runtime in this tier, so not a global to stub.
vi.mock('#app/nuxt', async importOriginal => ({ ...await importOriginal<object>(), useRuntimeConfig: () => ({ inviteCode: configured }) }))

beforeAll(() => {
  vi.stubGlobal('getRequestHeader', () => header)
  vi.stubGlobal('setResponseHeader', () => {})
  vi.stubGlobal('createError', (input: { statusCode: number, message: string }) => Object.assign(new Error(input.message), input))
})
afterAll(() => vi.unstubAllGlobals())
afterEach(() => vi.restoreAllMocks())

const attempt = (value: unknown, presented: string | undefined) => {
  configured = value
  header = presented
  return requireInviteCode({} as never)
}

describe('requireInviteCode', () => {
  it('matches the admin token\'s minimum', () => {
    expect(MIN_INVITE_CODE_LENGTH).toBe(32)
  })

  // A code of only digits reaches the config as a number, and a secret store can keep
  // a pasted newline. Neither should lock everyone out with no warning, or open anything.
  it('closes on a value parsed into something shorter than the rule, even for one presenting it', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await expect(attempt(12345, 'Bearer 12345')).rejects.toMatchObject({ statusCode: 503 })
    await expect(attempt(null, 'Bearer null')).rejects.toMatchObject({ statusCode: 503 })
    await expect(attempt(undefined, 'Bearer undefined')).rejects.toMatchObject({ statusCode: 503 })
    expect(warn).toHaveBeenCalledTimes(3)
  })

  it('ignores whitespace around the configured code when counting and comparing', async () => {
    await expect(attempt(`  ${CODE}\n`, `Bearer ${CODE}`)).resolves.toBeUndefined()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await expect(attempt(`${'c'.repeat(MIN_INVITE_CODE_LENGTH - 1)}\n`, 'Bearer anything')).rejects.toMatchObject({ statusCode: 503 })
    expect(warn).toHaveBeenCalled()
  })

  it('names the setting in its warning and never its value', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await expect(attempt('a-short-code', 'Bearer a-short-code')).rejects.toMatchObject({ statusCode: 503 })
    const logged = warn.mock.calls.flat().join(' ')
    expect(logged).toContain('NUXT_INVITE_CODE')
    expect(logged).not.toContain('a-short-code')
  })

  it('does not warn over a refused code when the configuration is fine', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await expect(attempt(CODE, 'Bearer wrong')).rejects.toMatchObject({ statusCode: 401 })
    expect(warn).not.toHaveBeenCalled()
  })
})
