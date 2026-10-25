import { join } from 'node:path'
import { createStorage, type Storage } from 'unstorage'
import { serialize } from './local'
import { reserveFrom, type SlotRepository, type SlotState } from './slots'

const storages = new Map<string, Promise<Storage>>()

function storageFor(base: string): Promise<Storage> {
  let existing = storages.get(base)
  if (!existing) {
    existing = import('unstorage/drivers/fs').then(({ default: fsDriver }) =>
      createStorage({ driver: fsDriver({ base }) }))
    storages.set(base, existing)
  }
  return existing
}

const slotKey = (provider: string) => `slots/${provider}`
const EMPTY: SlotState = { nextAvailableAt: 0, blockedUntil: 0 }

/**
 * JSON-file slots under `<dataDir>/db/` for development and tests. Every
 * reservation for a provider is a read-modify-write queued on one chain, which
 * is the local driver's stand-in for the row lock `reserve_slot` takes.
 */
export function createLocalSlotRepository(options: { dataDir: string }): SlotRepository {
  const base = join(options.dataDir, 'db')

  return {
    kind: 'local',

    async reserve(provider, window) {
      return serialize(slotKey(provider), async () => {
        const s = await storageFor(base)
        const state = (await s.getItem<SlotState>(slotKey(provider))) ?? EMPTY
        const { next, reservation } = reserveFrom(state, window, Date.now())
        if (reservation.granted) await s.setItem<SlotState>(slotKey(provider), next)
        return reservation
      })
    },

    async noteRateLimit(provider, retryAfterMs) {
      await serialize(slotKey(provider), async () => {
        const s = await storageFor(base)
        const state = (await s.getItem<SlotState>(slotKey(provider))) ?? EMPTY
        const blockedUntil = Math.max(state.blockedUntil, Date.now() + retryAfterMs)
        await s.setItem<SlotState>(slotKey(provider), { ...state, blockedUntil })
      })
    },

    async blockedUntil(provider) {
      const state = await serialize(slotKey(provider), async () =>
        (await storageFor(base)).getItem<SlotState>(slotKey(provider)))
      return state && state.blockedUntil > Date.now() ? new Date(state.blockedUntil) : null
    },
  }
}
