import { getEventListeners } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SOFT_LEASE_MS, SOFT_RENEW_MS, SOFT_RETRY_MS, SOFT_SETTLE_MS, softLocks, type SoftLockDeps } from '../../app/utils/soft-locks'

const NAME = 'meeting:9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d'

function memory() {
  const map = new Map<string, string>()
  return {
    map,
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
    removeItem: (key: string) => void map.delete(key),
  }
}

let nextTab = 1
function tab(storage: SoftLockDeps['storage']) {
  const seed = (nextTab++ * 0.137) % 1
  return softLocks({
    storage,
    now: () => Date.now(),
    setTimer: (fire, ms) => setTimeout(fire, ms),
    clearTimer: timer => clearTimeout(timer as ReturnType<typeof setTimeout>),
    random: () => seed,
  })
}

/** A holder that keeps the lock until told to let go. */
function holder() {
  let letGo = () => {}
  const released = new Promise<void>((resolve) => {
    letGo = resolve
  })
  return { callback: vi.fn(() => released), letGo: () => letGo() }
}

const pass = (ms: number) => vi.advanceTimersByTimeAsync(ms)

beforeEach(() => {
  vi.useFakeTimers({ now: new Date('2026-11-03T12:00:00.000Z') })
})

afterEach(() => {
  vi.useRealTimers()
})

describe('softLocks, waiting in the queue a long time', () => {
  it('leaves one listener on the signal, however many times it has tried', async () => {
    const storage = memory()
    void tab(storage).request(NAME, { ifAvailable: true }, holder().callback)
    await pass(SOFT_SETTLE_MS)
    const queue = new AbortController()
    const rejected = vi.fn()
    tab(storage).request(NAME, { signal: queue.signal }, holder().callback).catch(rejected)

    await pass(100 * SOFT_RETRY_MS)
    expect(getEventListeners(queue.signal, 'abort').length).toBeLessThanOrEqual(1)

    queue.abort()
    await pass(0)
    expect(rejected).toHaveBeenCalledWith(expect.objectContaining({ name: 'AbortError' }))
  })
})

describe('softLocks, taking a lock from a tab that has gone quiet', () => {
  it('gives it at once, and the old holder stops renewing rather than take it back', async () => {
    const storage = memory()
    const oldest = holder()
    void tab(storage).request(NAME, { ifAvailable: true }, oldest.callback)
    await pass(SOFT_SETTLE_MS)
    expect(oldest.callback).toHaveBeenCalled()

    const next = holder()
    void tab(storage).request(NAME, { steal: true }, next.callback)
    await pass(0)
    expect(next.callback).toHaveBeenCalled()
    const lease = [...storage.map.values()][0]

    await pass(2 * SOFT_RENEW_MS - 1)
    const renewed = JSON.parse([...storage.map.values()][0]!) as { owner: string }
    expect(renewed.owner).toBe((JSON.parse(lease!) as { owner: string }).owner)
  })
})

describe('softLocks', () => {
  it('gives a free lock, once its claim has settled', async () => {
    const first = holder()
    void tab(memory()).request(NAME, { ifAvailable: true }, first.callback)
    await pass(SOFT_SETTLE_MS - 1)
    expect(first.callback).not.toHaveBeenCalled()
    await pass(1)
    expect(first.callback).toHaveBeenCalledWith(expect.objectContaining({ mode: 'exclusive' }))
  })

  it('tells a second tab asking if available that it is not', async () => {
    const storage = memory()
    void tab(storage).request(NAME, { ifAvailable: true }, holder().callback)
    await pass(SOFT_SETTLE_MS)

    const second = vi.fn()
    await tab(storage).request(NAME, { ifAvailable: true }, second)
    expect(second).toHaveBeenCalledWith(null)
  })

  it('hands it to the queued tab when the holder lets go', async () => {
    const storage = memory()
    const first = holder()
    void tab(storage).request(NAME, { ifAvailable: true }, first.callback)
    await pass(SOFT_SETTLE_MS)

    const second = holder()
    void tab(storage).request(NAME, {}, second.callback)
    await pass(10 * SOFT_RETRY_MS)
    expect(second.callback).not.toHaveBeenCalled()

    first.letGo()
    await pass(SOFT_RETRY_MS + SOFT_SETTLE_MS)
    expect(second.callback).toHaveBeenCalledTimes(1)
  })

  it('leaves the lease behind for only as long as it was held', async () => {
    const storage = memory()
    const first = holder()
    void tab(storage).request(NAME, { ifAvailable: true }, first.callback)
    await pass(SOFT_SETTLE_MS)
    expect(storage.map.size).toBe(1)
    first.letGo()
    await pass(0)
    expect(storage.map.size).toBe(0)
  })

  it('keeps no meeting id in storage, since the id is the capability to read it', async () => {
    const storage = memory()
    void tab(storage).request(NAME, { ifAvailable: true }, holder().callback)
    await pass(SOFT_SETTLE_MS)
    expect(JSON.stringify([...storage.map])).not.toContain('9b1deb4d')
  })

  it('renews for as long as it is held, so a live driver never loses it', async () => {
    const storage = memory()
    const first = holder()
    void tab(storage).request(NAME, { ifAvailable: true }, first.callback)
    await pass(SOFT_SETTLE_MS)

    await pass(10 * SOFT_LEASE_MS)
    const second = vi.fn()
    await tab(storage).request(NAME, { ifAvailable: true }, second)
    expect(second).toHaveBeenCalledWith(null)
  })

  it('stops renewing when let go, leaving no timer', async () => {
    const first = holder()
    void tab(memory()).request(NAME, { ifAvailable: true }, first.callback)
    await pass(SOFT_SETTLE_MS)
    expect(vi.getTimerCount()).toBe(1)
    first.letGo()
    await pass(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('lasts through a hidden tab\'s once-a-minute timers', () => {
    expect(SOFT_LEASE_MS).toBeGreaterThan(60_000 + SOFT_RENEW_MS)
  })

  it('lets a crashed tab\'s lease run out, so someone else can take over', async () => {
    const storage = memory()
    void tab(storage).request(NAME, { ifAvailable: true }, holder().callback)
    await pass(SOFT_SETTLE_MS)
    // The tab is gone: nothing renews it. Written as it would have left it.
    vi.clearAllTimers()

    const early = vi.fn()
    await tab(storage).request(NAME, { ifAvailable: true }, early)
    expect(early).toHaveBeenCalledWith(null)

    await pass(SOFT_LEASE_MS)
    const late = holder()
    void tab(storage).request(NAME, { ifAvailable: true }, late.callback)
    await pass(SOFT_SETTLE_MS)
    expect(late.callback).toHaveBeenCalledWith(expect.objectContaining({ mode: 'exclusive' }))
  })

  it('reads a lease it cannot parse as nobody holding it', async () => {
    const storage = memory()
    const first = holder()
    void tab(storage).request(NAME, { ifAvailable: true }, holder().callback)
    await pass(SOFT_SETTLE_MS)
    for (const key of storage.map.keys()) storage.map.set(key, '{not json')
    void tab(storage).request(NAME, { ifAvailable: true }, first.callback)
    await pass(SOFT_SETTLE_MS)
    expect(first.callback).toHaveBeenCalledWith(expect.objectContaining({ mode: 'exclusive' }))
  })

  it('keeps a second tab out while the first is still settling', async () => {
    const storage = memory()
    const [a, b] = [holder(), holder()]
    void tab(storage).request(NAME, { ifAvailable: true }, a.callback)
    void tab(storage).request(NAME, { ifAvailable: true }, b.callback)
    await pass(SOFT_SETTLE_MS)
    expect(a.callback).toHaveBeenCalledWith(expect.objectContaining({ mode: 'exclusive' }))
    expect(b.callback).toHaveBeenCalledWith(null)
  })

  it('gives way if another process wrote over its claim while it settled, so one of two drives', async () => {
    const storage = memory()
    const loser = holder()
    void tab(storage).request(NAME, { ifAvailable: true }, loser.callback)
    await pass(SOFT_SETTLE_MS - 1)
    for (const key of storage.map.keys()) storage.map.set(key, JSON.stringify({ owner: 'another tab', until: Date.now() + SOFT_LEASE_MS }))
    await pass(1)
    expect(loser.callback).toHaveBeenCalledWith(null)
  })

  it.each<[string, SoftLockDeps['storage']]>([
    ['no storage', null],
    ['storage that refuses', {
      getItem: () => {
        throw new Error('blocked')
      },
      setItem: () => {
        throw new Error('blocked')
      },
      removeItem: () => {
        throw new Error('blocked')
      },
    }],
  ])('with %s, says yes to everyone, leaving the server\'s claim as the authority', async (_name, storage) => {
    const [a, b] = [holder(), holder()]
    void tab(storage).request(NAME, { ifAvailable: true }, a.callback)
    void tab(storage).request(NAME, { ifAvailable: true }, b.callback)
    await pass(SOFT_SETTLE_MS)
    expect(a.callback).toHaveBeenCalledWith(expect.objectContaining({ mode: 'exclusive' }))
    expect(b.callback).toHaveBeenCalledWith(expect.objectContaining({ mode: 'exclusive' }))
    a.letGo()
    b.letGo()
    await pass(0)
  })

  it('stops queueing when told to, with no timer left and no grant', async () => {
    const storage = memory()
    void tab(storage).request(NAME, { ifAvailable: true }, holder().callback)
    await pass(SOFT_SETTLE_MS)

    const controller = new AbortController()
    const second = vi.fn()
    const queued = tab(storage).request(NAME, { signal: controller.signal }, second)
    const outcome = expect(queued).rejects.toMatchObject({ name: 'AbortError' })
    await pass(SOFT_SETTLE_MS)
    controller.abort()
    await outcome
    await pass(SOFT_RETRY_MS)
    expect(second).not.toHaveBeenCalled()
  })

  it('does not keep a lease it won just as it was told to stop', async () => {
    const storage = memory()
    const controller = new AbortController()
    const queued = tab(storage).request(NAME, { signal: controller.signal }, vi.fn())
    const outcome = expect(queued).rejects.toMatchObject({ name: 'AbortError' })
    controller.abort()
    await pass(SOFT_SETTLE_MS)
    await outcome
    expect(storage.map.size).toBe(0)
  })

  it('refuses at once if it was already told to stop', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(tab(memory()).request(NAME, { signal: controller.signal }, vi.fn())).rejects.toMatchObject({ name: 'AbortError' })
  })
})
