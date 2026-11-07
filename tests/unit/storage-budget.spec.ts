import type { H3Event } from 'h3'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { StorageUsageWindow } from '../../server/utils/db/meetings'

const asked: StorageUsageWindow[] = []
let stored = 0

vi.mock('#app/nuxt', async importOriginal => ({
  ...await importOriginal<object>(),
  useRuntimeConfig: () => ({ r2MaxStoredBytes: '1000000', r2RetentionDays: '30' }),
}))
vi.mock('../../server/utils/db', () => ({
  useMeetingRepository: () => ({
    storedAudioBytes: async (window: StorageUsageWindow) => {
      asked.push(window)
      return stored
    },
  }),
}))
vi.stubGlobal('createError', (input: { statusCode: number, message: string }) => Object.assign(new Error(input.message), input))

const { assertStorageBudget, UPLOAD_GRACE_SEC, UPLOAD_RESERVATION_SEC, UPLOAD_URL_TTL_SEC } = await import('../../server/utils/storage-budget')
const { deletionBlocker } = await import('../../server/utils/meeting-deletion')

const MIN = 60_000
const event = {} as H3Event

beforeEach(() => {
  asked.length = 0
  stored = 0
})

describe('assertStorageBudget', () => {
  // A PUT that starts just before its URL expires can go on landing for the
  // whole grace period, and nothing else counts those bytes until `complete`
  // records the upload. So a pending registration has to stay reserved for the
  // URL's life plus the grace, spelled out here as 20 minutes so that shrinking
  // the window back to the bare TTL fails this test.
  it('reserves a pending upload for the URL lifetime plus the grace, 20 minutes', async () => {
    await assertStorageBudget(event, 1)
    expect(asked).toEqual([{ retentionDays: 30, reservationSeconds: 20 * 60 }])
    expect(UPLOAD_RESERVATION_SEC).toBe(UPLOAD_URL_TTL_SEC + UPLOAD_GRACE_SEC)
  })

  it('uses the same window the delete route waits out', () => {
    const createdAt = new Date(0).toISOString()
    expect(deletionBlocker({ createdAt }, UPLOAD_RESERVATION_SEC * 1000 - 1)).not.toBeNull()
    expect(deletionBlocker({ createdAt }, UPLOAD_RESERVATION_SEC * 1000)).toBeNull()
    expect(UPLOAD_RESERVATION_SEC * 1000).toBe(20 * MIN)
  })

  it('refuses with 507 once the reserved and stored bytes would pass the ceiling', async () => {
    stored = 999_999
    await expect(assertStorageBudget(event, 1)).resolves.toBeUndefined()
    await expect(assertStorageBudget(event, 2)).rejects.toMatchObject({ statusCode: 507 })
  })
})
