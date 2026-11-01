import { describe, expect, it } from 'vitest'
import {
  LOCAL_MEETINGS_KEY,
  browserStorage,
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
    setItem(_key, value) {
      this.value = value
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
}

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

describe('browserStorage', () => {
  it('is null under SSR, where there is no window', () => {
    expect(typeof window).toBe('undefined')
    expect(browserStorage()).toBeNull()
  })
})
