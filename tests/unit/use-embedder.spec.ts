import { afterEach, describe, expect, it, vi } from 'vitest'
import type { H3Event } from 'h3'
import { EMBEDDING_DIMENSIONS } from '../../server/utils/qa/embedder'
import { useEmbedder } from '../../server/utils/qa/index'

const useRuntimeConfig = vi.hoisted(() => vi.fn())
// Auto-imported from Nuxt's app runtime in this tier, so not a global to stub.
vi.mock('#app/nuxt', async importOriginal => ({ ...await importOriginal<object>(), useRuntimeConfig }))

const event = {} as H3Event
const configure = (workersAiAccountId: string, workersAiApiToken: string) =>
  useRuntimeConfig.mockReturnValue({ workersAiAccountId, workersAiApiToken, embedStubQuotaCanary: '' })

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

  it.each([['the-account', ''], ['', 'the-token']])('refuses half a configuration (%j, %j)', (accountId, token) => {
    configure(accountId, token)
    expect(() => useEmbedder(event)).toThrow(/Workers AI is partially configured/)
  })
})
