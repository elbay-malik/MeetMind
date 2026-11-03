import { afterEach, describe, expect, it, vi } from 'vitest'
import type { H3Event } from 'h3'
import { EMBEDDING_DIMENSIONS } from '../../server/utils/qa/embedder'
import { useEmbedder, useStepEmbedder } from '../../server/utils/qa/index'

const useRuntimeConfig = vi.hoisted(() => vi.fn())
// Auto-imported from Nuxt's app runtime in this tier, so not a global to stub.
vi.mock('#app/nuxt', async importOriginal => ({ ...await importOriginal<object>(), useRuntimeConfig }))

const event = { context: {} } as H3Event
// With the opt-in, as a stub needs on a built server, which this tier runs as (ADR-0016).
const configure = (workersAiAccountId: string, workersAiApiToken: string) =>
  useRuntimeConfig.mockReturnValue({ workersAiAccountId, workersAiApiToken, embedStubQuotaCanary: '', allowLocalDrivers: true })

afterEach(() => vi.unstubAllGlobals())

// The driver's own tests build it directly, and so do the real-service checks. This
// is the one place the two values come out of the configuration, by name.
describe('useEmbedder', () => {
  it('builds the real driver when both are set, with each value in its own place', async () => {
    configure('the-account', 'the-token')
    const fetched = vi.fn(async (_url: string, _init: RequestInit) => Response.json({
      success: true,
      result: { data: [new Array(EMBEDDING_DIMENSIONS).fill(0.1)] },
    }))
    vi.stubGlobal('fetch', fetched)

    const embedder = useEmbedder(event)
    expect(embedder.kind).toBe('workers-ai')
    await embedder.embedQuery('x')

    const [url, init] = fetched.mock.calls[0]!
    expect(url).toContain('/accounts/the-account/')
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer the-token')
  })

  it('falls back to the stub when neither is set', () => {
    configure('', '')
    expect(useEmbedder(event).kind).toBe('stub')
  })

  // The names go to the log, not to whoever asked: see tests/unit/driver-gate.spec.ts.
  it.each([['the-account', ''], ['', 'the-token']])('refuses half a configuration (%j, %j)', (accountId, token) => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    configure(accountId, token)
    expect(() => useEmbedder(event)).toThrow(/not available at the moment/)
    expect(() => useStepEmbedder(event)).toThrow(/not available at the moment/)
    expect(logged.mock.calls.flat().join(' ')).toMatch(accountId ? /half a group.*NUXT_WORKERS_AI_API_TOKEN/ : /half a group.*NUXT_WORKERS_AI_ACCOUNT_ID/)
    logged.mockRestore()
  })

  it('refuses to fall back to the stub without the opt-in', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    useRuntimeConfig.mockReturnValue({ workersAiAccountId: '', workersAiApiToken: '', embedStubQuotaCanary: '' })
    expect(() => useEmbedder(event)).toThrow(/not available at the moment/)
    vi.restoreAllMocks()
  })
})

// A retry is the next step's attempt, on the ledger (ADR-0012). A second request inside
// one step would be a step that can spend twice and take twice as long, past its lease.
describe('useStepEmbedder', () => {
  it('sends one request and leaves a failure to the next step, where useEmbedder retries in place', async () => {
    configure('the-account', 'the-token')
    const fetched = vi.fn(async () => new Response('down', { status: 500 }))
    vi.stubGlobal('fetch', fetched)

    await expect(useStepEmbedder(event).embedDocuments(['x'])).rejects.toMatchObject({ retryable: true })
    expect(fetched).toHaveBeenCalledTimes(1)

    await expect(useEmbedder(event).embedDocuments(['x'])).rejects.toMatchObject({ retryable: true })
    expect(fetched).toHaveBeenCalledTimes(3)
  })

  it('falls back to the stub as useEmbedder does, and so reads as another model\'s index', () => {
    configure('', '')
    expect(useStepEmbedder(event).kind).toBe('stub')
  })

  // That reading is the hazard: one indexing request overwrites up to 16 real windows.
  it('refuses to do so beside a real database, opt-in or not', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    useRuntimeConfig.mockReturnValue({ allowLocalDrivers: true, embedStubQuotaCanary: '', supabaseUrl: 'https://example.invalid', supabaseServiceKey: 'k' })
    expect(() => useStepEmbedder(event)).toThrow(/not available at the moment/)
    vi.restoreAllMocks()
  })
})
