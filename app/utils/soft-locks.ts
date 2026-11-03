import type { DriverLocks } from './pipeline-driver'

/**
 * A stand-in for `navigator.locks` where the browser has none: a page over plain http, or an
 * old browser. Without it every tab would drive. That is safe, because the server's claim is
 * the authority, but each tab would keep asking about steps another tab has already taken.
 *
 * It is a lease in `localStorage`, renewed by whoever holds it and removed on the way out. Far
 * weaker than the real thing: two tabs arriving together can both believe they won, and that
 * is fine, since all this has to do is make that rare. Storage that refuses makes it say yes
 * to everyone, which is the same as having no lock at all.
 */

/**
 * Past the once-a-minute a hidden tab's timers can slow to, or a throttled tab would lose it
 * while still driving. It only matters for a tab that crashed: one that closes removes it.
 */
export const SOFT_LEASE_MS = 90_000
export const SOFT_RENEW_MS = 20_000
/** How often a queued tab tries again. The watcher's own pace, near enough. */
export const SOFT_RETRY_MS = 5_000
/** How long a tab that wrote the lease waits before believing it, so the last of two writers wins. */
export const SOFT_SETTLE_MS = 100

const KEY_PREFIX = 'meetmind.pipeline-lease.'

/**
 * The lock's name holds a meeting's id, and a meeting's id is the capability to read it. A
 * visitor's storage does not need one left behind if a tab crashes, so this keeps a hash.
 */
function keyFor(name: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < name.length; i++) {
    hash ^= name.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return `${KEY_PREFIX}${(hash >>> 0).toString(36)}`
}

export interface SoftLockDeps {
  storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null
  now: () => number
  setTimer: (fire: () => void, ms: number) => unknown
  clearTimer: (timer: unknown) => void
  random: () => number
}

export function softLocks(deps: SoftLockDeps): DriverLocks {
  const { storage, now, setTimer, clearTimer, random } = deps
  const me = random().toString(36).slice(2)

  /** Null when nobody holds it or storage cannot say. */
  function holder(key: string): string | null {
    try {
      const lease = JSON.parse(storage?.getItem(key) ?? 'null') as { owner?: unknown, until?: unknown } | null
      return lease && typeof lease.owner === 'string' && typeof lease.until === 'number' && lease.until > now()
        ? lease.owner
        : null
    }
    catch {
      return null
    }
  }

  function write(key: string) {
    try {
      storage?.setItem(key, JSON.stringify({ owner: me, until: now() + SOFT_LEASE_MS }))
    }
    catch {
      // Refused: nobody can read a lease here, so nobody is kept out by one.
    }
  }

  const pause = (ms: number) => new Promise<void>(resolve => setTimer(resolve, ms))

  /** Whether this tab holds it now. Takes it if it is free, then checks nobody wrote after. */
  async function take(key: string): Promise<boolean> {
    const held = holder(key)
    if (held && held !== me) return false
    write(key)
    await pause(SOFT_SETTLE_MS)
    const after = holder(key)
    return after === null || after === me
  }

  function give(key: string) {
    try {
      if (holder(key) === me) storage?.removeItem(key)
    }
    catch {
      // It will run out by itself.
    }
  }

  async function hold(key: string, callback: (lock: unknown) => Promise<void> | void) {
    let timer: unknown
    const renew = () => {
      write(key)
      timer = setTimer(renew, SOFT_RENEW_MS)
    }
    timer = setTimer(renew, SOFT_RENEW_MS)
    try {
      await callback({ name: key, mode: 'exclusive' })
    }
    finally {
      clearTimer(timer)
      give(key)
    }
  }

  return {
    async request(name, options, callback) {
      const key = keyFor(name)
      if (options.ifAvailable) {
        if (await take(key)) return hold(key, callback)
        return callback(null)
      }
      const { signal } = options
      for (;;) {
        if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
        if (await take(key)) break
        await new Promise<void>((resolve) => {
          const timer = setTimer(resolve, SOFT_RETRY_MS)
          signal?.addEventListener('abort', () => {
            clearTimer(timer)
            resolve()
          }, { once: true })
        })
      }
      if (signal?.aborted) {
        give(key)
        throw new DOMException('Aborted', 'AbortError')
      }
      return hold(key, callback)
    },
  }
}
