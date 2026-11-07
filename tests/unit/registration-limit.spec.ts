import { afterAll, beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import { NEW_MEETINGS_USED_MESSAGE, UPLOADS_UNAVAILABLE_MESSAGE } from '../../shared/utils/meeting'
import { nextUtcMidnight } from '../../server/utils/db/demo-questions'
import { MEETINGS_PER_DAY } from '../../server/utils/registration-limit'

/**
 * ADR-0020's ceiling on new meetings, through `POST /api/meetings` with everything around it
 * recording what was called. What matters is where it sits: after the invite code, the body and
 * the storage budget, so none of those refusals uses one of the day, and before the upload URL,
 * so a refusal mints nothing.
 */

const route = vi.hoisted(() => ({
  calls: [] as string[],
  take: vi.fn(),
  inviteRefuses: false,
  budgetRefuses: false,
  body: {} as unknown,
}))

vi.mock('../../server/utils/invite', () => ({
  requireInviteCode: async () => {
    route.calls.push('invite')
    if (route.inviteRefuses) throw Object.assign(new Error('Uploading needs a valid invite code.'), { statusCode: 401 })
  },
}))
vi.mock('../../server/utils/drivers', () => ({ requireDrivers: () => route.calls.push('drivers') }))
vi.mock('../../server/utils/storage-budget', () => ({
  UPLOAD_URL_TTL_SEC: 300,
  assertStorageBudget: async () => {
    route.calls.push('budget')
    if (route.budgetRefuses) throw Object.assign(new Error('The audio archive is full.'), { statusCode: 507 })
  },
}))
vi.mock('../../server/utils/storage', () => ({
  useAudioStore: () => ({
    presignPut: async () => {
      route.calls.push('presign')
      return { url: 'https://example.invalid/put', headers: {} }
    },
  }),
}))
vi.mock('../../server/utils/db', () => ({
  useMeetingRepository: () => ({
    create: async (input: Record<string, unknown>) => {
      route.calls.push('create')
      return { ...input, createdAt: 'now', updatedAt: 'now' }
    },
  }),
  useRegistrationRepository: () => ({
    kind: 'local',
    take: async (limit: number) => {
      route.calls.push('take')
      return route.take(limit)
    },
  }),
}))

const BODY = { title: 'A meeting', sourceFileName: 'a.mp4', sourceBytes: 1000, sourceMime: 'video/mp4', durationSec: 10, audioBytes: 500 }

describe('POST /api/meetings, and the day\'s new meetings', () => {
  const headers = new Map<string, unknown>()
  type Handler = (event: unknown) => Promise<unknown>
  let handler: Handler
  let warn: MockInstance<typeof console.warn>

  beforeAll(async () => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.stubGlobal('defineEventHandler', (fn: Handler) => fn)
    vi.stubGlobal('getRequestHeader', (_event: unknown, name: string) => ({ 'content-length': '200' })[name])
    vi.stubGlobal('readBody', async () => route.body)
    vi.stubGlobal('setResponseStatus', () => {})
    vi.stubGlobal('setResponseHeader', (_event: unknown, name: string, value: unknown) => headers.set(name, value))
    vi.stubGlobal('createError', (input: { statusCode: number, message: string }) => Object.assign(new Error(input.message), input))
    handler = (await import('../../server/api/meetings/index.post')).default as unknown as Handler
  })
  beforeEach(() => {
    headers.clear()
    warn.mockClear()
    route.calls = []
    route.take.mockReset()
    route.take.mockResolvedValue(true)
    route.inviteRefuses = false
    route.budgetRefuses = false
    route.body = BODY
  })
  afterAll(() => {
    vi.unstubAllGlobals()
    warn.mockRestore()
  })

  it('has thirty a day, as ADR-0020 says', () => {
    expect(MEETINGS_PER_DAY).toBe(30)
  })

  it('counts one after the invite, the body and the budget, and before the upload URL', async () => {
    await handler({})
    expect(route.calls).toEqual(['invite', 'drivers', 'budget', 'take', 'presign', 'create'])
    expect(route.take).toHaveBeenCalledWith(MEETINGS_PER_DAY)
  })

  it('counts nothing for a request without a valid invite code', async () => {
    route.inviteRefuses = true
    await expect(handler({})).rejects.toMatchObject({ statusCode: 401 })
    expect(route.calls).toEqual(['invite'])
  })

  it('counts nothing for a body that is refused', async () => {
    route.body = { title: 'x' }
    await expect(handler({})).rejects.toMatchObject({ statusCode: 400 })
    expect(route.calls).not.toContain('take')
  })

  it('counts nothing when the store has no room', async () => {
    route.budgetRefuses = true
    await expect(handler({})).rejects.toMatchObject({ statusCode: 507 })
    expect(route.calls).not.toContain('take')
  })

  it('over the ceiling answers 429 with the next 00:00 UTC and mints no URL, and logs nothing', async () => {
    route.take.mockResolvedValue(false)
    const refused = await handler({}).catch((err: unknown) => err) as { statusCode: number, message: string, data: { retryAt: string, retryAfterSec: number } }
    expect(refused).toMatchObject({ statusCode: 429, message: NEW_MEETINGS_USED_MESSAGE })
    expect(refused.data.retryAt).toBe(nextUtcMidnight(Date.now()).toISOString())
    expect(refused.data.retryAfterSec).toBeGreaterThan(0)
    expect(refused.data.retryAfterSec).toBeLessThanOrEqual(86_400)
    expect(headers.get('retry-after')).toBe(refused.data.retryAfterSec)
    expect(route.calls).not.toContain('presign')
    expect(warn).not.toHaveBeenCalled()
  })

  it('fails closed when the count cannot be taken, with a fixed sentence and the words in the log', async () => {
    route.take.mockRejectedValue(new Error('Supabase take meeting registration failed (PGRST202): Could not find the function'))
    const refused = await handler({}).catch((err: unknown) => err) as { statusCode: number, message: string, data?: unknown }
    expect(refused).toMatchObject({ statusCode: 503, message: UPLOADS_UNAVAILABLE_MESSAGE })
    expect(refused.message).not.toMatch(/Supabase|PGRST/)
    expect(refused.data).toBeUndefined()
    expect(route.calls).not.toContain('presign')
    expect(warn).toHaveBeenCalledOnce()
    expect(String((warn.mock.lastCall![1] as Error).message)).toContain('PGRST202')
  })
})
