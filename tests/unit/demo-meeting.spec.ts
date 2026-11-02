import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { refuseOnPublicDemo } from '../../server/utils/demo-meeting'

const ID = '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d'
const OTHER = '3f2504e0-4f89-41d3-9a0c-0305e82c3301'

let demoMeetingId: unknown = ''
// Auto-imported from Nuxt's app runtime in this tier, so not a global to stub.
vi.mock('#app/nuxt', async importOriginal => ({ ...await importOriginal<object>(), useRuntimeConfig: () => ({ public: { demoMeetingId } }) }))

beforeAll(() => {
  vi.stubGlobal('createError', (input: { statusCode: number, message: string }) => Object.assign(new Error(input.message), input))
})
afterAll(() => vi.unstubAllGlobals())

const check = (configured: unknown, id: string) => {
  demoMeetingId = configured
  return () => refuseOnPublicDemo({} as never, id)
}

describe('refuseOnPublicDemo', () => {
  it.each([
    ['the id as configured', ID, ID],
    ['the id in capitals', ID, ID.toUpperCase()],
    ['an id configured in capitals', ID.toUpperCase(), ID],
    // A secret store can keep a pasted newline, and this guard must not fail open on it.
    ['an id configured with a trailing newline', `${ID}\n`, ID],
    ['an id configured with spaces around it', `  ${ID} `, ID],
  ])('refuses %s', (_name, configured, id) => {
    expect(check(configured, id)).toThrow(expect.objectContaining({ statusCode: 403 }))
  })

  it.each([
    ['another meeting', ID, OTHER],
    ['any meeting when no demo is configured', '', ID],
    ['any meeting when the setting is missing', undefined, ID],
    ['any meeting when the setting is only whitespace', ' \n', ID],
  ])('leaves %s alone', (_name, configured, id) => {
    expect(check(configured, id)).not.toThrow()
  })
})
