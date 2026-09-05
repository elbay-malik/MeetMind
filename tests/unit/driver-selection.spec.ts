import { describe, expect, it } from 'vitest'
import { requireAllOrNone } from '../../server/utils/storage'

describe('requireAllOrNone', () => {
  it('activates the service when every setting is present', () => {
    expect(requireAllOrNone('R2', { A: 'a', B: 'b' })).toBe(true)
  })

  it('falls back to the local driver when none are present', () => {
    expect(requireAllOrNone('R2', { A: '', B: '' })).toBe(false)
  })

  it('refuses to start half-configured, naming what is missing', () => {
    // Silently using the local driver here would write production audio to a
    // container filesystem while looking like it worked.
    expect(() => requireAllOrNone('Cloudflare R2', {
      NUXT_R2_ACCOUNT_ID: 'acct',
      NUXT_R2_ACCESS_KEY_ID: 'key',
      NUXT_R2_SECRET_ACCESS_KEY: '',
      NUXT_R2_BUCKET: '',
    })).toThrow(/partially configured.*NUXT_R2_SECRET_ACCESS_KEY, NUXT_R2_BUCKET/)
  })

  it('names the service in the error so the operator knows which one', () => {
    expect(() => requireAllOrNone('Supabase', { NUXT_SUPABASE_URL: 'u', NUXT_SUPABASE_SERVICE_KEY: '' }))
      .toThrow(/^Supabase is partially configured/)
  })
})
