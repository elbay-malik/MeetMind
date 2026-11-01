/**
 * The "Your meetings" list: what this browser remembers of the meetings uploaded
 * from it. There is no server-side list (ADR-0013), so this is the only record of
 * these links, and it holds capabilities: whoever reads it can open the meetings.
 *
 * Every function takes the storage rather than reaching for it, and none of them
 * throw. Storage can be missing (SSR), refused (blocked site data throws on merely
 * touching `window.localStorage`), full, or hand-edited, and none of that may break
 * an upload or a page.
 */

export interface LocalMeeting {
  id: string
  title: string
  createdAt: string
  /** Registered, and the upload has not been confirmed. Absent once it has. */
  unfinished?: true
}

export type LocalMeetingStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

export const LOCAL_MEETINGS_KEY = 'meetmind.your-meetings.v1'

/** Written and removed at once, about the size of one more entry. */
const PROBE_KEY = 'meetmind.your-meetings.probe'
const PROBE_VALUE = 'x'.repeat(256)

/** The stored id ends up in a link, so a tampered entry must not steer it elsewhere. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function isLocalMeeting(value: unknown): value is LocalMeeting {
  if (typeof value !== 'object' || value === null) return false
  const { id, title, createdAt } = value as Record<string, unknown>
  return typeof id === 'string' && UUID.test(id)
    && typeof title === 'string'
    && typeof createdAt === 'string' && !Number.isNaN(Date.parse(createdAt))
}

/** `window.localStorage`, or `null` where there is none or touching it is refused. */
export function browserStorage(): LocalMeetingStorage | null {
  if (typeof window === 'undefined') return null
  try {
    return window.localStorage ?? null
  }
  catch {
    return null
  }
}

/**
 * The remembered meetings, newest first. `available: false` means the storage could
 * not be read at all, which is different from having nothing in it. Unreadable
 * content counts as empty, and one bad entry costs only itself.
 */
export function readLocalMeetings(storage: LocalMeetingStorage | null): { available: boolean, meetings: LocalMeeting[] } {
  if (!storage) return { available: false, meetings: [] }
  let raw: string | null
  try {
    raw = storage.getItem(LOCAL_MEETINGS_KEY)
  }
  catch {
    return { available: false, meetings: [] }
  }
  if (!raw) return { available: true, meetings: [] }
  try {
    const parsed: unknown = JSON.parse(raw)
    const meetings = Array.isArray(parsed) ? parsed.filter(isLocalMeeting) : []
    return {
      available: true,
      meetings: meetings
        .map(({ id, title, createdAt, unfinished }) => ({
          id,
          title,
          createdAt,
          ...(unfinished === true ? { unfinished } : {}),
        }))
        .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)),
    }
  }
  catch {
    return { available: true, meetings: [] }
  }
}

/**
 * Whether a new entry would be stored. Separate from `available`, because a full disk
 * or an origin out of quota reads as normal and refuses only the write, and a list that
 * could not take the last upload must not say nothing was uploaded.
 */
export function canStoreLocalMeetings(storage: LocalMeetingStorage | null): boolean {
  if (!storage) return false
  try {
    storage.setItem(PROBE_KEY, PROBE_VALUE)
    storage.removeItem(PROBE_KEY)
    return true
  }
  catch {
    return false
  }
}

/** Add a meeting to the list, or refresh its entry. Returns whether that was stored. */
export function rememberLocalMeeting(
  storage: LocalMeetingStorage | null,
  meeting: Pick<LocalMeeting, 'id' | 'title' | 'createdAt'>,
  { unfinished = false }: { unfinished?: boolean } = {},
): boolean {
  if (!storage) return false
  const { id, title, createdAt } = meeting
  const others = readLocalMeetings(storage).meetings.filter(m => m.id !== id)
  const entry: LocalMeeting = { id, title, createdAt, ...(unfinished ? { unfinished: true } : {}) }
  return write(storage, [entry, ...others])
}

/**
 * Take a meeting off the list. The meeting itself stays, reachable by anyone who kept
 * its link. Returns whether that was stored.
 */
export function forgetLocalMeeting(storage: LocalMeetingStorage | null, id: string): boolean {
  if (!storage) return false
  return write(storage, readLocalMeetings(storage).meetings.filter(m => m.id !== id))
}

function write(storage: LocalMeetingStorage, meetings: LocalMeeting[]): boolean {
  try {
    storage.setItem(LOCAL_MEETINGS_KEY, JSON.stringify(meetings))
    return true
  }
  catch {
    return false
  }
}
