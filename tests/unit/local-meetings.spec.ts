import { describe, expect, it } from 'vitest'
import {
  LOCAL_MEETINGS_KEY,
  browserStorage,
  canStoreLocalMeetings,
  forgetLocalMeeting,
  readLocalMeetings,
  rememberLocalMeeting,
  type LocalMeeting,
  type LocalMeetingStorage,
} from '../../app/utils/local-meetings'

const entry = (n: number, createdAt = `2026-11-0${n}T10:00:00.000Z`): LocalMeeting => ({
  id: `9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6${n}`,
  title: `Meeting ${n}`,
  createdAt,
})

function memory(initial?: string): LocalMeetingStorage & { value: string | null } {
  return {
    value: initial ?? null,
    getItem() {
      return this.value
    },
    setItem(key, value) {
      if (key === LOCAL_MEETINGS_KEY) this.value = value
    },
    removeItem(key) {
      if (key === LOCAL_MEETINGS_KEY) this.value = null
    },
  }
}

const refusing: LocalMeetingStorage = {
  getItem: () => {
    throw new Error('SecurityError')
  },
  setItem: () => {
    throw new Error('QuotaExceededError')
  },
  removeItem: () => {},
}

/** Reads fine and refuses to write: a full disk, or an origin out of quota. */
const full = (initial?: string): LocalMeetingStorage => ({
  ...memory(initial),
  getItem: () => initial ?? null,
  setItem: () => {
    throw new DOMException('full', 'QuotaExceededError')
  },
})

describe('readLocalMeetings', () => {
  it('reports no storage as unavailable, not as an empty list', () => {
    expect(readLocalMeetings(null)).toEqual({ available: false, meetings: [] })
    expect(readLocalMeetings(refusing)).toEqual({ available: false, meetings: [] })
  })

  it('reports an untouched storage as available and empty', () => {
    expect(readLocalMeetings(memory())).toEqual({ available: true, meetings: [] })
  })

  it.each(['{not json', 'null', '42', '"text"', '{"id":"x"}'])('treats %s as an empty list', (raw) => {
    expect(readLocalMeetings(memory(raw))).toEqual({ available: true, meetings: [] })
  })

  it('drops only the bad entries', () => {
    const raw = JSON.stringify([
      entry(1),
      null,
      'text',
      { ...entry(2), id: '../../api/health' },
      { ...entry(3), title: 7 },
      { ...entry(4), createdAt: 'not a date' },
      { title: 'no id', createdAt: '2026-11-01T10:00:00.000Z' },
    ])
    expect(readLocalMeetings(memory(raw)).meetings).toEqual([entry(1)])
  })

  it.each([
    ['before', `../../api/health/${entry(1).id}`],
    ['after', `${entry(1).id}/../../api/health`],
  ])('drops an id with a path %s its UUID, which would steer the link', (_where, id) => {
    expect(readLocalMeetings(memory(JSON.stringify([{ ...entry(1), id }]))).meetings).toEqual([])
  })

  it('keeps an id written in capitals, which is still a UUID', () => {
    const upper = { ...entry(1), id: entry(1).id.toUpperCase() }
    expect(readLocalMeetings(memory(JSON.stringify([upper]))).meetings).toEqual([upper])
  })

  it('sorts newest first whatever order was stored', () => {
    const raw = JSON.stringify([entry(1), entry(3), entry(2)])
    expect(readLocalMeetings(memory(raw)).meetings.map(m => m.title)).toEqual(['Meeting 3', 'Meeting 2', 'Meeting 1'])
  })

  it('keeps only the three known fields of an entry', () => {
    const raw = JSON.stringify([{ ...entry(1), audioKey: 'meetings/x/audio.ogg' }])
    expect(readLocalMeetings(memory(raw)).meetings[0]).toEqual(entry(1))
  })
})

describe('rememberLocalMeeting', () => {
  it('stores what readLocalMeetings gives back, under the agreed key', () => {
    const storage = memory()
    const keys: string[] = []
    const spying: LocalMeetingStorage = {
      getItem: key => storage.getItem(key),
      setItem: (key, value) => {
        keys.push(key)
        storage.setItem(key, value)
      },
      removeItem: () => {},
    }
    expect(rememberLocalMeeting(spying, entry(1))).toBe(true)
    expect(rememberLocalMeeting(spying, entry(2))).toBe(true)
    expect(keys).toEqual([LOCAL_MEETINGS_KEY, LOCAL_MEETINGS_KEY])
    expect(readLocalMeetings(storage).meetings).toEqual([entry(2), entry(1)])
  })

  it('stores only the id, title and creation time of a full meeting', () => {
    const storage = memory()
    rememberLocalMeeting(storage, { ...entry(1), audioKey: 'k', errorMessage: 'e' } as LocalMeeting)
    expect(JSON.parse(storage.value!)).toEqual([entry(1)])
  })

  it('refreshes an entry rather than listing a meeting twice', () => {
    const storage = memory()
    rememberLocalMeeting(storage, entry(1))
    rememberLocalMeeting(storage, { ...entry(1), title: 'Renamed' })
    expect(readLocalMeetings(storage).meetings).toEqual([{ ...entry(1), title: 'Renamed' }])
  })

  it('replaces corrupt content rather than failing the upload that got here', () => {
    const storage = memory('{not json')
    expect(rememberLocalMeeting(storage, entry(1))).toBe(true)
    expect(readLocalMeetings(storage).meetings).toEqual([entry(1)])
  })

  it('answers false, without throwing, when it cannot store', () => {
    expect(rememberLocalMeeting(null, entry(1))).toBe(false)
    expect(rememberLocalMeeting(refusing, entry(1))).toBe(false)
  })
})

describe('an unfinished upload', () => {
  it('is marked as such, and the mark survives other entries being written', () => {
    const storage = memory()
    rememberLocalMeeting(storage, entry(1), { unfinished: true })
    rememberLocalMeeting(storage, entry(2))
    expect(readLocalMeetings(storage).meetings).toEqual([entry(2), { ...entry(1), unfinished: true }])
  })

  it('loses the mark when remembered again as finished', () => {
    const storage = memory()
    rememberLocalMeeting(storage, entry(1), { unfinished: true })
    rememberLocalMeeting(storage, entry(1))
    expect(readLocalMeetings(storage).meetings).toEqual([entry(1)])
    expect(JSON.parse(storage.value!)).toEqual([entry(1)])
  })

  it('ignores a tampered mark rather than dropping the entry', () => {
    const raw = JSON.stringify([{ ...entry(1), unfinished: 'yes' }])
    expect(readLocalMeetings(memory(raw)).meetings).toEqual([entry(1)])
  })
})

describe('forgetLocalMeeting', () => {
  it('removes only that meeting', () => {
    const storage = memory()
    rememberLocalMeeting(storage, entry(1))
    rememberLocalMeeting(storage, entry(2), { unfinished: true })
    expect(forgetLocalMeeting(storage, entry(1).id)).toBe(true)
    expect(readLocalMeetings(storage).meetings).toEqual([{ ...entry(2), unfinished: true }])
  })

  it('answers false, without throwing, when it cannot store', () => {
    expect(forgetLocalMeeting(null, entry(1).id)).toBe(false)
    expect(forgetLocalMeeting(refusing, entry(1).id)).toBe(false)
    expect(forgetLocalMeeting(full(JSON.stringify([entry(1)])), entry(1).id)).toBe(false)
  })
})

describe('canStoreLocalMeetings', () => {
  it('is true where a new entry would fit, and leaves nothing behind', () => {
    const written = new Map<string, string>()
    const storage: LocalMeetingStorage = {
      getItem: key => written.get(key) ?? null,
      setItem: (key, value) => void written.set(key, value),
      removeItem: key => void written.delete(key),
    }
    expect(canStoreLocalMeetings(storage)).toBe(true)
    expect(written.size).toBe(0)
  })

  it('is false when writes are refused, even though reads work', () => {
    expect(readLocalMeetings(full()).available).toBe(true)
    expect(canStoreLocalMeetings(full())).toBe(false)
    expect(canStoreLocalMeetings(refusing)).toBe(false)
    expect(canStoreLocalMeetings(null)).toBe(false)
  })

  it('does not touch the list when it probes', () => {
    const raw = JSON.stringify([entry(1)])
    const storage = memory(raw)
    canStoreLocalMeetings(storage)
    expect(readLocalMeetings(storage).meetings).toEqual([entry(1)])
  })
})

describe('browserStorage', () => {
  it('is null under SSR, where there is no window', () => {
    expect(typeof window).toBe('undefined')
    expect(browserStorage()).toBeNull()
  })
})
