import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PipelineResponse } from '../../shared/types/meeting'
import {
  ADVANCE_TIMEOUT_MS,
  LONG_WAIT_MS,
  LONGEST_BACKOFF_MS,
  LONGEST_HINT_MS,
  LONGEST_NO_PROGRESS_MS,
  LONGEST_SLEEP_MS,
  MAX_IDLE_CONTINUES,
  MAX_JITTER_MS,
  MAX_SPIN_PAUSES,
  MAX_TROUBLE_RETRIES,
  READ_TIMEOUT_MS,
  REBUILD_REFUSED,
  RELOOK_AFTER_MS,
  SHORTEST_WAIT_MS,
  SLOW_LOOK_MS,
  SPIN_PAUSE_MS,
  WATCH_POLL_MS,
  classifyReply,
  createPipelineDriver,
  initialDriverState,
  nextMove,
  progressSignature,
  troubleDelayMs,
  type DriverDeps,
  type DriverFetch,
  type DriverLocks,
} from '../../app/utils/pipeline-driver'

const ID = '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d'
const ADVANCE = 'POST /advance'
const READ = 'GET /pipeline'
const REBUILD = 'POST /search-index'
const LOCK = `meeting:${ID}`
const HOUR = 60 * 60_000

function answer(patch: Partial<PipelineResponse> = {}): PipelineResponse {
  return {
    status: 'transcribing',
    progress: { stage: 'transcription', done: 0, total: null, etaSeconds: null },
    index: { state: 'unavailable', done: 0, total: null, retryAt: null },
    next: 'continue',
    retryAt: null,
    retryAfterMs: null,
    ...patch,
  }
}

const atByte = (done: number, patch: Partial<PipelineResponse> = {}) =>
  answer({ progress: { stage: 'transcription', done, total: 1_000, etaSeconds: null }, ...patch })
const wait = (ms: number, patch: Partial<PipelineResponse> = {}) =>
  answer({ next: 'wait', retryAfterMs: ms, retryAt: new Date(Date.now() + ms).toISOString(), ...patch })
const READY = answer({ status: 'ready', progress: { stage: 'search_index', done: 8, total: 8, etaSeconds: null }, index: { state: 'complete', done: 8, total: 8, retryAt: null }, next: 'done' })
const FAILED = answer({ status: 'failed', next: 'failed', retryAt: '2026-11-03T12:01:00.000Z', retryAfterMs: 60_000 })
const FAILED_FOR_GOOD = answer({ status: 'failed', next: 'failed' })
const PENDING = answer({ status: 'pending_upload', progress: { stage: 'upload', done: 0, total: null, etaSeconds: null }, next: 'wait' })
const NOT_ANSWERED = Symbol('not answered')

interface FakeReply {
  status?: number
  body?: unknown
  retryAfter?: string
  /** No answer at all: what a lost connection looks like to a page. */
  network?: true
  /** Unparseable, as an HTML error page is. */
  notJson?: true
}

const reply = (status: number, body?: unknown, retryAfter?: string): FakeReply => ({ status, body, retryAfter })
const ok = (body: unknown): FakeReply => ({ status: 200, body })
const LOST: FakeReply = { network: true }

type Script = Partial<Record<string, Array<FakeReply | typeof NOT_ANSWERED>>>

/**
 * The server, as a page sees it. Each route takes its next scripted reply, and the last one
 * stands for ever after. A route with no script is a test that did not expect it: every test
 * can then say which routes it asks for by not giving any others a reply.
 */
function fakeServer(script: Script) {
  const calls: Array<{ route: string, at: number, signal: AbortSignal }> = []
  const held: Array<() => void> = []
  const started = Date.now()
  const fetch: DriverFetch = async (url, { method, signal }) => {
    const route = `${method} ${url.replace(`/api/meetings/${ID}`, '')}`
    calls.push({ route, at: Date.now() - started, signal })
    const queue = script[route]
    if (!queue?.length) throw new Error(`nothing scripted for ${route}`)
    const next = queue.length > 1 ? queue.shift()! : queue[0]!
    if (next === NOT_ANSWERED) {
      await new Promise<void>((resolve, reject) => {
        held.push(resolve)
        signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true })
      })
    }
    const planned = next === NOT_ANSWERED ? ok(READY) : next
    if (planned.network) throw new TypeError('Failed to fetch')
    return {
      status: planned.status ?? 200,
      headers: { get: (name: string) => name.toLowerCase() === 'retry-after' ? planned.retryAfter ?? null : null },
      json: async () => {
        if (planned.notJson) throw new SyntaxError('Unexpected token <')
        return planned.body
      },
    }
  }
  return {
    fetch,
    calls,
    routes: () => calls.map(call => call.route),
    count: (route: string) => calls.filter(call => call.route === route).length,
    /** Answer the requests the script left hanging. */
    answerHeld: () => held.splice(0).forEach(answerNow => answerNow()),
    script,
  }
}

/** One browser's lock manager: exclusive, in order, and it can refuse or be cancelled. */
function fakeLocks() {
  type Waiter = { name: string, run: () => void }
  const waiting: Waiter[] = []
  const held = new Set<string>()
  const requests: Array<{ name: string, options: { ifAvailable?: boolean, signal?: AbortSignal } }> = []
  const next = (name: string) => {
    if (held.has(name)) return
    const index = waiting.findIndex(waiter => waiter.name === name)
    if (index >= 0) waiting.splice(index, 1)[0]!.run()
  }
  const locks: DriverLocks & { held: Set<string>, requests: typeof requests, queued: () => number } = {
    held,
    requests,
    queued: () => waiting.length,
    request(name, options, callback) {
      requests.push({ name, options })
      if (options.ifAvailable && options.signal) throw new DOMException('Cannot use both', 'NotSupportedError')
      return new Promise((resolve, reject) => {
        const grant = () => {
          held.add(name)
          void Promise.resolve(callback({ name, mode: 'exclusive' }))
            .then(resolve, reject)
            .finally(() => {
              held.delete(name)
              next(name)
            })
        }
        if (options.ifAvailable) {
          if (held.has(name)) void Promise.resolve(callback(null)).then(resolve, reject)
          else grant()
          return
        }
        const waiter: Waiter = { name, run: grant }
        waiting.push(waiter)
        options.signal?.addEventListener('abort', () => {
          const index = waiting.indexOf(waiter)
          if (index < 0) return
          waiting.splice(index, 1)
          reject(new DOMException('Aborted', 'AbortError'))
        }, { once: true })
        next(name)
      })
    },
  }
  return locks
}

function tab(server: { fetch: DriverFetch }, overrides: Partial<DriverDeps> = {}) {
  return createPipelineDriver({
    meetingId: ID,
    fetch: server.fetch,
    locks: fakeLocks(),
    now: () => Date.now(),
    setTimer: (fire, ms) => setTimeout(fire, ms),
    clearTimer: timer => clearTimeout(timer as ReturnType<typeof setTimeout>),
    random: () => 0,
    ...overrides,
  })
}

const settle = () => vi.advanceTimersByTimeAsync(0)
const pass = (ms: number) => vi.advanceTimersByTimeAsync(ms)

beforeEach(() => {
  vi.useFakeTimers({ now: new Date('2026-11-03T12:00:00.000Z') })
})

afterEach(() => {
  vi.useRealTimers()
})

describe('nextMove', () => {
  const now = Date.parse('2026-11-03T12:00:00.000Z')
  const move = (a: PipelineResponse, retryPermitted = false) => nextMove(a, { retryPermitted, now })

  it.each<[string, PipelineResponse, ReturnType<typeof nextMove>]>([
    ['continue is another step, now', answer(), { kind: 'advance' }],
    ['wait with a duration is that long', answer({ next: 'wait', retryAfterMs: 8_000 }), { kind: 'sleep', ms: 8_000 }],
    ['wait with no time is not something to drive on', answer({ next: 'wait' }), { kind: 'look' }],
    ['done is the end', READY, { kind: 'stop', stop: 'finished', retryInMs: null }],
    ['a failure with a time says when a retry could help', FAILED, { kind: 'stop', stop: 'failed', retryInMs: 60_000 }],
    ['a failure with no time cannot be retried', FAILED_FOR_GOOD, { kind: 'stop', stop: 'failed', retryInMs: null }],
  ])('%s', (_name, given, expected) => {
    expect(move(given)).toEqual(expected)
  })

  it('takes the server\'s duration over its own idea of the time, whatever the clocks say', () => {
    expect(move(answer({ next: 'wait', retryAfterMs: 8_000, retryAt: '2020-01-01T00:00:00.000Z' }))).toEqual({ kind: 'sleep', ms: 8_000 })
    expect(move(answer({ next: 'wait', retryAfterMs: 8_000, retryAt: '2040-01-01T00:00:00.000Z' }))).toEqual({ kind: 'sleep', ms: 8_000 })
  })

  it('falls back on retryAt with no duration, and never to less than nothing', () => {
    expect(move(answer({ next: 'wait', retryAt: '2026-11-03T12:00:30.000Z' }))).toEqual({ kind: 'sleep', ms: 30_000 })
    expect(move(answer({ next: 'wait', retryAt: '2026-11-03T11:00:00.000Z' }))).toEqual({ kind: 'sleep', ms: 0 })
    expect(move(answer({ next: 'wait', retryAt: 'whenever' }))).toEqual({ kind: 'look' })
  })

  it('reads a `done` with a parked index as something that can be carried on later', () => {
    const parked = answer({ status: 'ready', next: 'done', retryAfterMs: HOUR, retryAt: '2026-11-03T13:00:00.000Z', index: { state: 'parked', done: 3, total: null, retryAt: '2026-11-03T13:00:00.000Z' } })
    expect(move(parked)).toEqual({ kind: 'stop', stop: 'finished', retryInMs: HOUR })
  })

  it('reads a held or stopped index as nothing a retry of this kind can move', () => {
    const held = answer({ status: 'ready', next: 'done', index: { state: 'held', done: 0, total: null, retryAt: null } })
    expect(move(held)).toEqual({ kind: 'stop', stop: 'finished', retryInMs: null })
    const stopped = answer({ status: 'ready', next: 'done', index: { state: 'stopped', done: 0, total: null, retryAt: null } })
    expect(move(stopped)).toEqual({ kind: 'stop', stop: 'finished', retryInMs: null })
  })

  describe('a failed meeting told continue', () => {
    const retryOnOffer = answer({ status: 'failed', next: 'continue', index: { state: 'complete', done: 1, total: 1, retryAt: null } })
    const indexWork = answer({ status: 'failed', next: 'continue', index: { state: 'building', done: 1, total: null, retryAt: null } })

    it('stops, with the retry open, since the step on offer can only be a retry', () => {
      expect(move(retryOnOffer)).toEqual({ kind: 'stop', stop: 'failed', retryInMs: 0 })
      expect(move(answer({ status: 'failed', next: 'continue' }))).toEqual({ kind: 'stop', stop: 'failed', retryInMs: 0 })
    })

    it('takes the step once a click has said to', () => {
      expect(move(retryOnOffer, true)).toEqual({ kind: 'advance' })
    })

    it('carries on with the index, which a failed extraction does not stop', () => {
      expect(move(indexWork)).toEqual({ kind: 'advance' })
    })
  })
})

describe('classifyReply', () => {
  const now = Date.parse('2026-11-03T12:00:00.000Z')
  const classify = (status: number, body?: unknown, retryAfter: string | null = null) => classifyReply({ status, body, retryAfter }, now)

  it('takes a well-formed 200 as an answer', () => {
    expect(classify(200, READY)).toEqual({ kind: 'answer', answer: READY })
  })

  it.each([
    ['HTML', '<html>'],
    ['nothing', null],
    ['another shape', { index: { state: 'ready' } }],
    ['an unknown next', answer({ next: 'later' as never })],
    ['no progress', { ...answer(), progress: undefined }],
    ['no index', { ...answer(), index: undefined }],
  ])('takes a 200 of %s as the server misbehaving, not an answer', (_name, body) => {
    expect(classify(200, body)).toEqual({ kind: 'trouble', cause: 'server', hintMs: null })
  })

  it.each([
    [403, { kind: 'read-only' }],
    [404, { kind: 'missing' }],
    [409, { kind: 'not-uploaded' }],
    [429, { kind: 'trouble', cause: 'rate-limited', hintMs: null }],
    [503, { kind: 'trouble', cause: 'unavailable', hintMs: null }],
    [500, { kind: 'trouble', cause: 'server', hintMs: null }],
    [502, { kind: 'trouble', cause: 'server', hintMs: null }],
    [400, { kind: 'trouble', cause: 'server', hintMs: null }],
  ])('reads a %i', (status, expected) => {
    expect(classify(status)).toEqual(expected)
  })

  it.each<[string, string | null, unknown, number]>([
    ['Retry-After in seconds', '120', null, 120_000],
    ['Retry-After as a date', 'Tue, 03 Nov 2026 12:02:00 GMT', null, 120_000],
    ['retryAfterMs in the body', null, { retryAfterMs: 90_000 }, 90_000],
    ['retryAfterMs under data', null, { data: { retryAfterMs: 45_000 } }, 45_000],
    ['retryAfterSec under data, as the ask route has it', null, { data: { retryAfterSec: 30 } }, 30_000],
    ['the longest of several', '10', { retryAfterMs: 90_000 }, 90_000],
  ])('hears how long from %s', (_name, header, body, hintMs) => {
    expect(classify(429, body, header)).toEqual({ kind: 'trouble', cause: 'rate-limited', hintMs })
  })

  it('caps how long it will honour, so nothing can strand the tab', () => {
    expect(classify(429, null, String(30 * 24 * 3600))).toMatchObject({ hintMs: LONGEST_HINT_MS })
  })

  it.each(['soon', '', '-5'])('ignores a Retry-After of %j', (header) => {
    expect(classify(503, null, header)).toEqual({ kind: 'trouble', cause: 'unavailable', hintMs: null })
  })
})

describe('progressSignature', () => {
  it.each<[string, Partial<PipelineResponse>]>([
    ['the status', { status: 'indexing' }],
    ['the stage', { progress: { stage: 'summarization', done: 0, total: null, etaSeconds: null } }],
    ['done', { progress: { stage: 'transcription', done: 1, total: null, etaSeconds: null } }],
    ['total', { progress: { stage: 'transcription', done: 0, total: 9, etaSeconds: null } }],
    ['the index state', { index: { state: 'building', done: 0, total: null, retryAt: null } }],
    ['the index done', { index: { state: 'unavailable', done: 1, total: null, retryAt: null } }],
    ['the index total', { index: { state: 'unavailable', done: 0, total: 1, retryAt: null } }],
  ])('moves with %s', (_name, patch) => {
    expect(progressSignature(answer(patch))).not.toBe(progressSignature(answer()))
  })

  it('does not move with the time to come back', () => {
    expect(progressSignature(wait(5_000))).toBe(progressSignature(wait(9_000)))
  })
})

describe('troubleDelayMs', () => {
  it('backs off, then holds at the longest', () => {
    expect([1, 2, 3, 4, 5, 50].map(attempt => troubleDelayMs(attempt, null))).toEqual([5_000, 15_000, 45_000, 60_000, 60_000, LONGEST_BACKOFF_MS])
  })

  it('never waits less than it was asked to', () => {
    expect(troubleDelayMs(1, 90_000)).toBe(90_000)
    expect(troubleDelayMs(3, 1_000)).toBe(45_000)
  })
})

describe('driving', () => {
  it('reads first, then asks for steps until the server says done, with no click', async () => {
    const server = fakeServer({
      [READ]: [ok(answer({ status: 'uploaded' }))],
      [ADVANCE]: [ok(atByte(10)), ok(atByte(20)), ok(answer({ status: 'summarizing', progress: { stage: 'summarization', done: 0, total: 3, etaSeconds: null } })), ok(READY)],
    })
    const driver = tab(server)
    driver.start()
    await settle()

    expect(server.routes()).toEqual([READ, ADVANCE, ADVANCE, ADVANCE, ADVANCE])
    expect(driver.state()).toMatchObject({ stop: 'finished', role: 'driving', answer: READY, asking: false, retryFrom: null })
  })

  it('asks again at once on continue: nothing in the way but the request itself', async () => {
    const server = fakeServer({ [READ]: [ok(answer())], [ADVANCE]: [ok(atByte(1)), ok(atByte(2)), ok(atByte(3)), ok(READY)] })
    tab(server).start()
    await settle()
    expect(server.calls.every(call => call.at === 0)).toBe(true)
    expect(server.count(ADVANCE)).toBe(4)
  })

  it('stops for good at done: nothing more for a day, and no timer left', async () => {
    const server = fakeServer({ [READ]: [ok(answer())], [ADVANCE]: [ok(READY)] })
    const driver = tab(server)
    driver.start()
    await settle()
    const asked = server.calls.length
    expect(vi.getTimerCount()).toBe(0)
    await pass(24 * HOUR)
    expect(server.calls.length).toBe(asked)
    expect(driver.state().stop).toBe('finished')
  })

  it('sends no step at all for a meeting already finished', async () => {
    const server = fakeServer({ [READ]: [ok(READY)] })
    const driver = tab(server)
    driver.start()
    await settle()
    expect(server.routes()).toEqual([READ])
    expect(driver.state().stop).toBe('finished')
  })

  describe('told to wait', () => {
    it.each([[0, 8_000], [1, 8_000 + MAX_JITTER_MS]])('sleeps the time it was told plus jitter, at random %s', async (random, expected) => {
      const server = fakeServer({ [READ]: [ok(answer())], [ADVANCE]: [ok(wait(8_000)), ok(READY)] })
      tab(server, { random: () => random }).start()
      await settle()
      expect(server.count(ADVANCE)).toBe(1)
      await pass(expected - 1)
      expect(server.count(ADVANCE)).toBe(1)
      await pass(1)
      expect(server.count(ADVANCE)).toBe(2)
    })

    it('goes by the duration, so a clock minutes off neither hurries nor strands it', async () => {
      const ahead = answer({ next: 'wait', retryAfterMs: 3_000, retryAt: new Date(Date.now() - HOUR).toISOString() })
      const behind = answer({ next: 'wait', retryAfterMs: 3_000, retryAt: new Date(Date.now() + 24 * HOUR).toISOString() })
      const server = fakeServer({ [READ]: [ok(answer())], [ADVANCE]: [ok(ahead), ok(behind), ok(READY)] })
      tab(server).start()
      await settle()
      await pass(2_999)
      expect(server.count(ADVANCE)).toBe(1)
      await pass(1)
      expect(server.count(ADVANCE)).toBe(2)
      await pass(3_000)
      expect(server.count(ADVANCE)).toBe(3)
    })

    it('does not hot-loop on a wait of nothing', async () => {
      const server = fakeServer({ [READ]: [ok(answer())], [ADVANCE]: [ok(wait(0))] })
      tab(server).start()
      await settle()
      await pass(10 * SHORTEST_WAIT_MS)
      expect(server.count(ADVANCE)).toBe(11)
    })

    it('does not hot-loop on a retryAt already past, with no duration', async () => {
      const past = answer({ next: 'wait', retryAt: new Date(Date.now() - HOUR).toISOString() })
      const server = fakeServer({ [READ]: [ok(answer())], [ADVANCE]: [ok(past)] })
      tab(server).start()
      await settle()
      await pass(10 * SHORTEST_WAIT_MS)
      expect(server.count(ADVANCE)).toBe(11)
    })

    it('keeps looking through a block of a day, at a rate that hammers nothing', async () => {
      // The server says what is left each time it is asked.
      const end = Date.now() + 24 * HOUR
      const server = fakeServer({ [READ]: [ok(answer())], [ADVANCE]: [] })
      const script = server.script[ADVANCE]!
      const fetch: DriverFetch = (url, init) => {
        if (url.endsWith('/advance')) {
          const left = end - Date.now()
          script.push(left > 0 ? ok(wait(left)) : ok(READY))
          while (script.length > 1) script.shift()
        }
        return server.fetch(url, init)
      }
      const driver = tab({ fetch })
      driver.start()
      await settle()
      await pass(24 * HOUR + LONGEST_SLEEP_MS)

      expect(driver.state().stop).toBe('finished')
      // Every five minutes for a day, and not one more.
      expect(server.count(ADVANCE)).toBeLessThanOrEqual(24 * 12 + 2)
      const gaps = server.calls.filter(call => call.route === ADVANCE).map(call => call.at)
      for (let i = 1; i < gaps.length; i++) expect(gaps[i]! - gaps[i - 1]!).toBeGreaterThanOrEqual(SHORTEST_WAIT_MS)
    })

    it('counts down to what the server said, not to its next look at the server', async () => {
      const server = fakeServer({ [READ]: [ok(answer())], [ADVANCE]: [ok(wait(3 * HOUR))] })
      const driver = tab(server)
      driver.start()
      await settle()
      expect(driver.state()).toMatchObject({ pause: 'wait', waitMs: 3 * HOUR, nextRequestAt: Date.now() + 3 * HOUR })
      await pass(LONGEST_SLEEP_MS - 1)
      expect(server.count(ADVANCE)).toBe(1)
      await pass(1)
      expect(server.count(ADVANCE)).toBe(2)
    })

    it('never sets one timer past the cap, so a block cannot strand the tab', async () => {
      const longest: number[] = []
      const server = fakeServer({ [READ]: [ok(answer())], [ADVANCE]: [ok(wait(24 * HOUR))] })
      tab(server, {
        setTimer: (fire, ms) => {
          if (ms !== ADVANCE_TIMEOUT_MS && ms !== READ_TIMEOUT_MS) longest.push(ms)
          return setTimeout(fire, ms)
        },
      }).start()
      await settle()
      expect(longest).toEqual([LONGEST_SLEEP_MS])
    })
  })

  describe('told it failed', () => {
    it('stops at once rather than waiting out the cooldown, and says when a retry could help', async () => {
      const server = fakeServer({ [READ]: [ok(answer())], [ADVANCE]: [ok(FAILED)] })
      const driver = tab(server)
      driver.start()
      await settle()
      expect(driver.state()).toMatchObject({ stop: 'failed', retryFrom: Date.now() + 60_000, answer: FAILED })
      expect(vi.getTimerCount()).toBe(0)
      await pass(HOUR)
      expect(server.count(ADVANCE)).toBe(1)
    })

    it('offers nothing for a failure no retry can help', async () => {
      const server = fakeServer({ [READ]: [ok(answer())], [ADVANCE]: [ok(FAILED_FOR_GOOD)] })
      const driver = tab(server)
      driver.start()
      await settle()
      expect(driver.state()).toMatchObject({ stop: 'failed', retryFrom: null })
    })

    it('opens no step on a failed meeting when the page opens, even with the cooldown over', async () => {
      const server = fakeServer({ [READ]: [ok(answer({ status: 'failed', next: 'continue' }))] })
      const driver = tab(server)
      driver.start()
      await settle()
      expect(server.routes()).toEqual([READ])
      expect(driver.state()).toMatchObject({ stop: 'failed', retryFrom: Date.now() })
    })

    it('goes on building the index of a meeting whose extraction failed', async () => {
      const building = (done: number) => answer({ status: 'failed', next: 'continue', progress: { stage: 'summarization', done: 1, total: 3, etaSeconds: null }, index: { state: 'building', done, total: null, retryAt: null } })
      const server = fakeServer({ [READ]: [ok(building(0))], [ADVANCE]: [ok(building(16)), ok(FAILED)] })
      const driver = tab(server)
      driver.start()
      await settle()
      expect(server.count(ADVANCE)).toBe(2)
      expect(driver.state().stop).toBe('failed')
    })
  })

  describe('retry', () => {
    it('spends one step, once it is clicked, and drives on from there', async () => {
      const server = fakeServer({ [READ]: [ok(answer({ status: 'failed', next: 'continue' }))], [ADVANCE]: [ok(atByte(1)), ok(READY)] })
      const driver = tab(server)
      driver.start()
      await settle()
      expect(server.count(ADVANCE)).toBe(0)

      driver.retry()
      await settle()
      expect(server.routes()).toEqual([READ, READ, ADVANCE, ADVANCE])
      expect(driver.state()).toMatchObject({ stop: 'finished', retryFrom: null })
    })

    it('gives way to the server: a cooldown that moved stops it again, with no step', async () => {
      const server = fakeServer({ [READ]: [ok(answer({ status: 'failed', next: 'continue' })), ok(FAILED)] })
      const driver = tab(server)
      driver.start()
      await settle()
      driver.retry()
      await settle()
      expect(server.count(ADVANCE)).toBe(0)
      expect(driver.state()).toMatchObject({ stop: 'failed', retryFrom: Date.now() + 60_000 })
    })

    it('is permission for one step, not for a second failure', async () => {
      const offered = answer({ status: 'failed', next: 'continue' })
      const server = fakeServer({ [READ]: [ok(offered)], [ADVANCE]: [ok(offered)] })
      const driver = tab(server)
      driver.start()
      await settle()
      driver.retry()
      await settle()
      expect(server.count(ADVANCE)).toBe(1)
      expect(driver.state().stop).toBe('failed')
    })

    it('carries on a parked index from when its time is up, by asking /advance and not /search-index', async () => {
      const parked = answer({ status: 'ready', next: 'done', retryAfterMs: HOUR, retryAt: new Date(Date.now() + HOUR).toISOString(), index: { state: 'parked', done: 3, total: null, retryAt: null } })
      const moving = answer({ status: 'ready', next: 'continue', index: { state: 'building', done: 3, total: null, retryAt: null } })
      const server = fakeServer({ [READ]: [ok(parked), ok(moving)], [ADVANCE]: [ok(READY)] })
      const driver = tab(server)
      driver.start()
      await settle()
      expect(driver.state()).toMatchObject({ stop: 'finished', retryFrom: Date.now() + HOUR })
      expect(server.count(ADVANCE)).toBe(0)
      expect(vi.getTimerCount()).toBe(0)

      await pass(HOUR)
      expect(server.count(READ)).toBe(1)
      driver.retry()
      await settle()
      expect(server.routes()).toEqual([READ, READ, ADVANCE])
      expect(driver.state().answer).toEqual(READY)
    })
  })

  describe('told wait with no time', () => {
    it('sends no step, looks slowly, and drives once something else has moved it', async () => {
      const server = fakeServer({ [READ]: [ok(PENDING), ok(PENDING), ok(answer({ status: 'uploaded' }))], [ADVANCE]: [ok(READY)] })
      const driver = tab(server)
      driver.start()
      await settle()
      expect(driver.state()).toMatchObject({ pause: 'look', role: 'driving' })
      expect(server.routes()).toEqual([READ])

      await pass(SLOW_LOOK_MS - 1)
      expect(server.count(READ)).toBe(1)
      await pass(1)
      expect(server.routes()).toEqual([READ, READ])
      await pass(SLOW_LOOK_MS)
      expect(server.routes()).toEqual([READ, READ, READ, ADVANCE])
    })
  })

  it('starts only once', async () => {
    const server = fakeServer({ [READ]: [ok(READY)] })
    const driver = tab(server)
    driver.start()
    driver.start()
    await settle()
    expect(server.count(READ)).toBe(1)
  })
})

describe('the spin bound', () => {
  it('pauses rather than following a continue that shows nothing new, and then stops', async () => {
    const server = fakeServer({ [READ]: [ok(atByte(5))], [ADVANCE]: [ok(atByte(5))] })
    const driver = tab(server)
    driver.start()
    await settle()

    expect(server.count(ADVANCE)).toBe(MAX_IDLE_CONTINUES)
    expect(driver.state()).toMatchObject({ pause: 'spinning', stop: null, nextRequestAt: Date.now() + SPIN_PAUSE_MS })

    await pass(SPIN_PAUSE_MS)
    expect(server.count(ADVANCE)).toBe(2 * MAX_IDLE_CONTINUES)
    await pass(SPIN_PAUSE_MS)
    expect(server.count(ADVANCE)).toBe((MAX_SPIN_PAUSES + 1) * MAX_IDLE_CONTINUES)
    expect(driver.state()).toMatchObject({ stop: 'stalled', retryFrom: Date.now() })

    const asked = server.calls.length
    expect(vi.getTimerCount()).toBe(0)
    await pass(24 * HOUR)
    expect(server.calls.length).toBe(asked)
  })

  it('is not fooled by figures that only go back and forth', async () => {
    const a = ok(atByte(1))
    const b = ok(atByte(2))
    const flipping = [a, b, a, b, a, b, a, b, a, b, a, b, a, b, a, b, a, b, a, b, a, b, a, b, a, b, a, b, a, b, a, b, a, b, a, b, a, b, a, b, a, b, a, b, a, b, a, b, a, b, a, b, a, b, a, b, a, b, a, b, a, b]
    const server = fakeServer({ [READ]: [ok(answer())], [ADVANCE]: flipping })
    const driver = tab(server)
    driver.start()
    await settle()
    await pass(HOUR)
    expect(driver.state().stop).toBe('stalled')
    expect(server.count(ADVANCE)).toBeLessThanOrEqual((MAX_SPIN_PAUSES + 1) * MAX_IDLE_CONTINUES + 2)
  })

  it('never pauses a run that is moving, however long it is', async () => {
    const replies = Array.from({ length: 200 }, (_, i) => ok(atByte(i + 1)))
    const server = fakeServer({ [READ]: [ok(answer())], [ADVANCE]: [...replies, ok(READY)] })
    const driver = tab(server)
    driver.start()
    await settle()
    expect(server.count(ADVANCE)).toBe(201)
    expect(server.calls.every(call => call.at === 0)).toBe(true)
    expect(driver.state().stop).toBe('finished')
  })

  it('counts continues in a row, so a wait between them starts it over', async () => {
    const stuck = ok(atByte(1))
    const run = Array.from({ length: MAX_IDLE_CONTINUES - 2 }, () => stuck)
    const server = fakeServer({ [READ]: [ok(answer())], [ADVANCE]: [stuck, ...run, ok(wait(1_000, { progress: atByte(1).progress })), ...run, ok(READY)] })
    const driver = tab(server)
    driver.start()
    await settle()
    await pass(1_000)
    expect(driver.state().stop).toBe('finished')
    expect(driver.state().pause).toBe(null)
  })

  it('gives up on a wait that has shown nothing new for longer than any block can last', async () => {
    const server = fakeServer({ [READ]: [ok(atByte(1))], [ADVANCE]: [ok(wait(HOUR, { progress: atByte(1).progress }))] })
    const driver = tab(server)
    driver.start()
    await settle()
    await pass(LONGEST_NO_PROGRESS_MS + LONGEST_SLEEP_MS + MAX_JITTER_MS)
    expect(driver.state().stop).toBe('stalled')
    expect(driver.state().retryFrom).toBeLessThanOrEqual(Date.now())
    const asked = server.calls.length
    await pass(HOUR)
    expect(server.calls.length).toBe(asked)
  })

  it('starts counting afresh when someone clicks', async () => {
    const server = fakeServer({ [READ]: [ok(atByte(5))], [ADVANCE]: [ok(atByte(5))] })
    const driver = tab(server)
    driver.start()
    await settle()
    await pass(2 * SPIN_PAUSE_MS)
    expect(driver.state().stop).toBe('stalled')

    const before = server.count(ADVANCE)
    driver.retry()
    await settle()
    expect(server.count(ADVANCE)).toBe(before + MAX_IDLE_CONTINUES)
    expect(driver.state().pause).toBe('spinning')
  })
})

describe('answers that are not 200', () => {
  describe.each<[string, number, 'server' | 'unavailable']>([
    ['a 500', 500, 'server'],
    ['the driver gate\'s 503', 503, 'unavailable'],
    ['a 502 from something in front', 502, 'server'],
  ])('%s', (_name, status, cause) => {
    const refused = reply(status, { error: true, message: 'The internals of the server, in a sentence nobody should read' })

    it('backs off, a bounded number of times, then stops with a retry and no failure', async () => {
      const server = fakeServer({ [READ]: [ok(answer())], [ADVANCE]: [refused] })
      const driver = tab(server)
      driver.start()
      await settle()
      expect(driver.state()).toMatchObject({ pause: cause, stop: null, nextRequestAt: Date.now() + 5_000 })

      await pass(5_000 + 15_000 + 45_000 + 60_000)
      expect(server.count(ADVANCE)).toBe(1 + MAX_TROUBLE_RETRIES)
      expect(server.calls.filter(call => call.route === ADVANCE).map(call => call.at)).toEqual([0, 5_000, 20_000, 65_000, 125_000])
      expect(driver.state()).toMatchObject({ stop: 'trouble', troubleCause: cause, retryFrom: Date.now(), pause: null })
      expect(vi.getTimerCount()).toBe(0)

      await pass(24 * HOUR)
      expect(server.count(ADVANCE)).toBe(1 + MAX_TROUBLE_RETRIES)
    })

    it('carries on without a click if the next try is answered', async () => {
      const server = fakeServer({ [READ]: [ok(answer())], [ADVANCE]: [refused, ok(READY)] })
      const driver = tab(server)
      driver.start()
      await settle()
      await pass(5_000)
      expect(driver.state()).toMatchObject({ stop: 'finished', pause: null, troubleCause: null })
    })

    it('takes a click to try again, and that starts the count over', async () => {
      const server = fakeServer({ [READ]: [ok(answer())], [ADVANCE]: [refused] })
      const driver = tab(server)
      driver.start()
      await settle()
      await pass(125_000)
      expect(driver.state().stop).toBe('trouble')
      driver.retry()
      await settle()
      expect(driver.state()).toMatchObject({ stop: null, pause: cause })
    })
  })

  it('respects Retry-After on a 429: nothing before it, however short its own backoff', async () => {
    const server = fakeServer({ [READ]: [ok(answer())], [ADVANCE]: [reply(429, {}, '120'), ok(READY)] })
    const driver = tab(server)
    driver.start()
    await settle()
    expect(driver.state().pause).toBe('rate-limited')
    await pass(119_999)
    expect(server.count(ADVANCE)).toBe(1)
    await pass(1)
    expect(server.count(ADVANCE)).toBe(2)
  })

  it('respects Retry-After on a 503', async () => {
    const server = fakeServer({ [READ]: [ok(answer())], [ADVANCE]: [reply(503, {}, '600'), ok(READY)] })
    tab(server).start()
    await settle()
    await pass(599_999)
    expect(server.count(ADVANCE)).toBe(1)
    await pass(1)
    expect(server.count(ADVANCE)).toBe(2)
  })

  it('respects a retryAfterMs in the body', async () => {
    const server = fakeServer({ [READ]: [ok(answer())], [ADVANCE]: [reply(429, { retryAfterMs: 90_000 }), ok(READY)] })
    tab(server).start()
    await settle()
    await pass(89_999)
    expect(server.count(ADVANCE)).toBe(1)
    await pass(1)
    expect(server.count(ADVANCE)).toBe(2)
  })

  it('never hot-loops on 429, with or without a header, and stops', async () => {
    const server = fakeServer({ [READ]: [ok(answer())], [ADVANCE]: [reply(429, {})] })
    const driver = tab(server)
    driver.start()
    await settle()
    await pass(HOUR)
    expect(server.count(ADVANCE)).toBe(1 + MAX_TROUBLE_RETRIES)
    expect(driver.state()).toMatchObject({ stop: 'trouble', troubleCause: 'rate-limited' })
  })

  it('reads the same trouble on the first read as on a step, and sends no step', async () => {
    const server = fakeServer({ [READ]: [reply(503, {})] })
    const driver = tab(server)
    driver.start()
    await settle()
    await pass(HOUR)
    expect(server.routes()).toEqual(Array.from({ length: 1 + MAX_TROUBLE_RETRIES }, () => READ))
    expect(driver.state().stop).toBe('trouble')
  })

  it('asks the same route again after trouble: a step it could not ask for is still next', async () => {
    const server = fakeServer({ [READ]: [ok(answer())], [ADVANCE]: [reply(500, {}), ok(READY)] })
    tab(server).start()
    await settle()
    await pass(5_000)
    expect(server.routes()).toEqual([READ, ADVANCE, ADVANCE])
  })

  it('takes a 200 it cannot read as trouble, not as an answer to act on', async () => {
    const server = fakeServer({ [READ]: [ok(answer())], [ADVANCE]: [{ status: 200, notJson: true }, ok({ hello: 'proxy' }), ok(READY)] })
    const driver = tab(server)
    driver.start()
    await settle()
    expect(driver.state().pause).toBe('server')
    await pass(5_000)
    expect(driver.state().pause).toBe('server')
    await pass(15_000)
    expect(driver.state().stop).toBe('finished')
  })

  it('never shows the words a refusal came with: they are not kept', async () => {
    const server = fakeServer({ [READ]: [ok(answer())], [ADVANCE]: [reply(500, { message: 'relation "pipeline_runs" does not exist' })] })
    const driver = tab(server)
    driver.start()
    await settle()
    await pass(125_000)
    expect(JSON.stringify(driver.state())).not.toContain('pipeline_runs')
  })

  describe('a network error', () => {
    it('is not a failure of the meeting: it waits, and carries on by itself when answered', async () => {
      const server = fakeServer({ [READ]: [ok(answer())], [ADVANCE]: [LOST, LOST, ok(READY)] })
      const driver = tab(server)
      driver.start()
      await settle()
      expect(driver.state()).toMatchObject({ pause: 'network', stop: null, answer: answer() })
      await pass(5_000)
      expect(driver.state().pause).toBe('network')
      await pass(15_000)
      expect(driver.state()).toMatchObject({ stop: 'finished', pause: null })
    })

    it('goes on trying through a long outage, once a minute, with no click', async () => {
      const server = fakeServer({ [READ]: [ok(answer())], [ADVANCE]: [LOST] })
      const driver = tab(server)
      driver.start()
      await settle()
      await pass(6 * HOUR)
      expect(driver.state()).toMatchObject({ stop: null, pause: 'network' })
      expect(server.count(ADVANCE)).toBeLessThanOrEqual(6 * 60 + 5)
    })

    it('does not let an outage use up the bound on bad answers', async () => {
      const outage = Array.from({ length: 10 }, () => LOST)
      const server = fakeServer({ [READ]: [ok(answer())], [ADVANCE]: [...outage, reply(500, {}), ok(READY)] })
      const driver = tab(server)
      driver.start()
      await settle()
      await pass(10 * LONGEST_BACKOFF_MS)
      expect(driver.state().stop).toBe('finished')
    })

    it('tries at once when the connection comes back', async () => {
      const server = fakeServer({ [READ]: [ok(answer())], [ADVANCE]: [LOST, ok(READY)] })
      const driver = tab(server)
      driver.start()
      await settle()
      driver.wake('online')
      await settle()
      expect(driver.state().stop).toBe('finished')
      expect(server.calls.at(-1)!.at).toBe(0)
    })

    it('gives up on a step that never answers, and asks again', async () => {
      const server = fakeServer({ [READ]: [ok(answer())], [ADVANCE]: [NOT_ANSWERED, ok(READY)] })
      const driver = tab(server)
      driver.start()
      await settle()
      await pass(ADVANCE_TIMEOUT_MS - 1)
      expect(server.count(ADVANCE)).toBe(1)
      await pass(1)
      expect(server.calls.find(call => call.route === ADVANCE)!.signal.aborted).toBe(true)
      expect(driver.state().pause).toBe('network')
      await pass(5_000)
      expect(driver.state().stop).toBe('finished')
    })
  })

  it('becomes read-only on a 403, with no step ever again, and gives up the lock', async () => {
    const locks = fakeLocks()
    const demo = answer({ status: 'uploaded', next: 'wait' })
    const server = fakeServer({ [READ]: [ok(answer()), ok(demo)], [ADVANCE]: [reply(403, { message: 'The demo meeting is read-only' })] })
    const driver = tab(server, { locks })
    driver.start()
    await settle()
    expect(driver.state()).toMatchObject({ role: 'read-only', answer: demo, stop: null, pause: null })
    expect(locks.held.size).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
    await pass(HOUR)
    expect(server.count(ADVANCE)).toBe(1)
    driver.retry()
    driver.rebuildIndex()
    await settle()
    expect(server.count(ADVANCE)).toBe(1)
    expect(server.count(READ)).toBe(2)
  })

  it('says a meeting is gone on a 404, with no retry and no more requests', async () => {
    const server = fakeServer({ [READ]: [ok(answer())], [ADVANCE]: [reply(404, {})] })
    const driver = tab(server)
    driver.start()
    await settle()
    expect(driver.state()).toMatchObject({ stop: 'missing', retryFrom: null })
    await pass(HOUR)
    expect(server.calls.length).toBe(2)
  })

  it('stops asking on a 409, and looks instead until the upload is confirmed', async () => {
    const server = fakeServer({ [READ]: [ok(answer()), ok(PENDING), ok(answer({ status: 'uploaded' }))], [ADVANCE]: [reply(409, {}), ok(READY)] })
    const driver = tab(server)
    driver.start()
    await settle()
    expect(server.routes()).toEqual([READ, ADVANCE])

    await pass(SHORTEST_WAIT_MS)
    expect(server.routes()).toEqual([READ, ADVANCE, READ])
    expect(driver.state()).toMatchObject({ pause: 'look', answer: PENDING })

    await pass(SLOW_LOOK_MS)
    expect(server.routes()).toEqual([READ, ADVANCE, READ, READ, ADVANCE])
    expect(driver.state().stop).toBe('finished')
  })

  it('cannot be walked into a tight loop by a read and a step that disagree', async () => {
    const server = fakeServer({ [READ]: [ok(answer())], [ADVANCE]: [reply(409, {})] })
    tab(server).start()
    await settle()
    await pass(10 * SHORTEST_WAIT_MS)
    expect(server.count(ADVANCE)).toBeLessThanOrEqual(11)
  })
})

describe('one driving tab per browser', () => {
  /** A driver on a step that does not end, so a second tab has someone to watch. */
  const busyFirst = () => fakeServer({ [READ]: [ok(answer())], [ADVANCE]: [NOT_ANSWERED] })

  it('asks for the lock named after the meeting', async () => {
    const locks = fakeLocks()
    const server = fakeServer({ [READ]: [ok(READY)] })
    tab(server, { locks }).start()
    await settle()
    expect(locks.requests[0]).toMatchObject({ name: LOCK })
    expect(new Set(locks.requests.map(request => request.name))).toEqual(new Set([LOCK]))
  })

  it('keeps one meeting\'s lock apart from another\'s', async () => {
    const locks = fakeLocks()
    const server = fakeServer({ [READ]: [ok(answer())], [ADVANCE]: [NOT_ANSWERED] })
    tab(server, { locks }).start()
    await settle()
    expect(locks.held).toEqual(new Set([LOCK]))
  })

  it('a second tab shows progress every 5 s and sends no step', async () => {
    const locks = fakeLocks()
    const driverServer = busyFirst()
    tab(driverServer, { locks }).start()
    await settle()

    const watcherServer = fakeServer({ [READ]: [ok(atByte(10)), ok(atByte(20)), ok(atByte(30))] })
    const watcher = tab(watcherServer, { locks, initial: answer() })
    watcher.start()
    await settle()

    expect(watcher.state()).toMatchObject({ role: 'watching', answer: answer() })
    expect(watcherServer.calls.length).toBe(0)
    await pass(WATCH_POLL_MS)
    expect(watcher.state().answer).toEqual(atByte(10))
    await pass(WATCH_POLL_MS)
    expect(watcher.state().answer).toEqual(atByte(20))
    await pass(WATCH_POLL_MS)
    expect(watcher.state().answer).toEqual(atByte(30))

    expect(watcherServer.routes()).toEqual([READ, READ, READ])
    expect(watcherServer.calls.map(call => call.at)).toEqual([WATCH_POLL_MS, 2 * WATCH_POLL_MS, 3 * WATCH_POLL_MS])
  })

  it('reads at once in a second tab that has nothing to show yet', async () => {
    const locks = fakeLocks()
    tab(busyFirst(), { locks }).start()
    await settle()
    const watcherServer = fakeServer({ [READ]: [ok(atByte(1))] })
    tab(watcherServer, { locks }).start()
    await settle()
    expect(watcherServer.routes()).toEqual([READ])
  })

  it('takes over when the driving tab goes, from a read and then with steps', async () => {
    const locks = fakeLocks()
    const driver = tab(busyFirst(), { locks })
    driver.start()
    await settle()

    const watcherServer = fakeServer({ [READ]: [ok(atByte(1)), ok(atByte(2))], [ADVANCE]: [ok(atByte(3)), ok(READY)] })
    const watcher = tab(watcherServer, { locks, initial: answer() })
    watcher.start()
    await settle()
    await pass(WATCH_POLL_MS)
    expect(watcherServer.count(ADVANCE)).toBe(0)
    expect(watcher.state().role).toBe('watching')

    driver.stop()
    await settle()

    expect(watcher.state()).toMatchObject({ role: 'driving', stop: 'finished', answer: READY })
    expect(watcherServer.routes()).toEqual([READ, READ, ADVANCE, ADVANCE])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('stops its own poll on taking over, rather than running both', async () => {
    const locks = fakeLocks()
    const driver = tab(busyFirst(), { locks })
    driver.start()
    await settle()
    const watcherServer = fakeServer({ [READ]: [ok(wait(60_000))], [ADVANCE]: [ok(wait(60_000))] })
    const watcher = tab(watcherServer, { locks, initial: answer() })
    watcher.start()
    await settle()
    driver.stop()
    await settle()
    const reads = watcherServer.count(READ)
    await pass(30_000)
    expect(watcherServer.count(READ)).toBe(reads)
    expect(watcher.state().role).toBe('driving')
  })

  it('leaves a tab watching for as long as the driver lives, with the lock never shared', async () => {
    const locks = fakeLocks()
    tab(busyFirst(), { locks }).start()
    await settle()
    const servers = [fakeServer({ [READ]: [ok(atByte(1))] }), fakeServer({ [READ]: [ok(atByte(1))] })]
    for (const server of servers) tab(server, { locks, initial: answer() }).start()
    await settle()
    await pass(10 * WATCH_POLL_MS)
    for (const server of servers) expect(server.count(ADVANCE)).toBe(0)
    expect(locks.queued()).toBe(2)
  })

  it('a finished driver lets the next tab read that, with no step sent', async () => {
    const locks = fakeLocks()
    const driverServer = fakeServer({ [READ]: [ok(answer())], [ADVANCE]: [NOT_ANSWERED] })
    tab(driverServer, { locks }).start()
    await settle()
    const watcherServer = fakeServer({ [READ]: [ok(READY)] })
    const watcher = tab(watcherServer, { locks, initial: answer() })
    watcher.start()
    await settle()

    driverServer.answerHeld()
    await settle()

    expect(locks.held.size).toBe(0)
    expect(watcher.state()).toMatchObject({ stop: 'finished', answer: READY })
    expect(watcherServer.count(ADVANCE)).toBe(0)
  })

  it.each<[string, PipelineResponse, string]>([
    ['done', READY, 'finished'],
    ['failed', FAILED, 'failed'],
  ])('a watching tab that reads %s stops looking and leaves the queue', async (_name, final, stop) => {
    const locks = fakeLocks()
    const driver = tab(busyFirst(), { locks })
    driver.start()
    await settle()
    const watcherServer = fakeServer({ [READ]: [ok(final)] })
    const watcher = tab(watcherServer, { locks, initial: answer() })
    watcher.start()
    await settle()
    expect(locks.queued()).toBe(1)

    await pass(WATCH_POLL_MS)
    expect(watcher.state().stop).toBe(stop)
    expect(locks.queued()).toBe(0)
    expect(vi.getTimerCount()).toBeLessThanOrEqual(1)
    await pass(HOUR)
    expect(watcherServer.count(READ)).toBe(1)
    driver.stop()
    await settle()
    expect(watcherServer.count(READ)).toBe(1)
    expect(watcherServer.count(ADVANCE)).toBe(0)
  })

  it('a watching tab looks less often through a long block, and does not spin', async () => {
    const locks = fakeLocks()
    tab(busyFirst(), { locks }).start()
    await settle()
    const watcherServer = fakeServer({ [READ]: [ok(wait(LONG_WAIT_MS))] })
    const watcher = tab(watcherServer, { locks, initial: answer() })
    watcher.start()
    await settle()
    await pass(WATCH_POLL_MS)
    expect(watcher.state()).toMatchObject({ pause: 'wait', waitMs: LONG_WAIT_MS })
    await pass(SLOW_LOOK_MS - 1)
    expect(watcherServer.count(READ)).toBe(1)
    await pass(1)
    expect(watcherServer.count(READ)).toBe(2)
  })

  it('a watching tab keeps its 5 s through the pacing of a healthy run', async () => {
    const locks = fakeLocks()
    tab(busyFirst(), { locks }).start()
    await settle()
    const watcherServer = fakeServer({ [READ]: [ok(wait(60_000))] })
    tab(watcherServer, { locks, initial: answer() }).start()
    await settle()
    await pass(WATCH_POLL_MS)
    await pass(WATCH_POLL_MS)
    expect(watcherServer.count(READ)).toBe(2)
  })

  it('a watching tab looks slowly at a meeting nothing can move', async () => {
    const locks = fakeLocks()
    tab(busyFirst(), { locks }).start()
    await settle()
    const watcherServer = fakeServer({ [READ]: [ok(PENDING)] })
    const watcher = tab(watcherServer, { locks, initial: answer() })
    watcher.start()
    await settle()
    await pass(WATCH_POLL_MS)
    expect(watcher.state().pause).toBe('look')
    await pass(SLOW_LOOK_MS - 1)
    expect(watcherServer.count(READ)).toBe(1)
  })

  it('a watching tab backs off when reads fail, and keeps watching without a click', async () => {
    const locks = fakeLocks()
    tab(busyFirst(), { locks }).start()
    await settle()
    const watcherServer = fakeServer({ [READ]: [reply(500, {})] })
    const watcher = tab(watcherServer, { locks, initial: answer() })
    watcher.start()
    await settle()
    await pass(HOUR)
    expect(watcher.state()).toMatchObject({ role: 'watching', pause: 'server', stop: null })
    expect(watcherServer.count(READ)).toBeLessThanOrEqual(65)
  })

  it('a watching tab says a deleted meeting is gone', async () => {
    const locks = fakeLocks()
    tab(busyFirst(), { locks }).start()
    await settle()
    const watcher = tab(fakeServer({ [READ]: [reply(404, {})] }), { locks, initial: answer() })
    watcher.start()
    await settle()
    await pass(WATCH_POLL_MS)
    expect(watcher.state().stop).toBe('missing')
    expect(locks.queued()).toBe(0)
  })

  describe('with no lock manager', () => {
    it('drives, since the server\'s claim is the authority', async () => {
      const server = fakeServer({ [READ]: [ok(answer())], [ADVANCE]: [ok(READY)] })
      const driver = tab(server, { locks: null })
      driver.start()
      await settle()
      expect(server.routes()).toEqual([READ, ADVANCE])
      expect(driver.state()).toMatchObject({ role: 'driving', stop: 'finished' })
    })

    it('drives when the lock manager refuses outright', async () => {
      const refusing: DriverLocks = { request: () => Promise.reject(new DOMException('No', 'SecurityError')) }
      const server = fakeServer({ [READ]: [ok(answer())], [ADVANCE]: [ok(READY)] })
      const driver = tab(server, { locks: refusing })
      driver.start()
      await settle()
      expect(driver.state().stop).toBe('finished')
    })

    it('drives when a queue that was promised is then refused', async () => {
      const refusing: DriverLocks = {
        request: (_name, options, callback) => options.ifAvailable
          ? Promise.resolve(callback(null))
          : Promise.reject(new DOMException('No', 'SecurityError')),
      }
      const server = fakeServer({ [READ]: [ok(answer())], [ADVANCE]: [ok(READY)] })
      const driver = tab(server, { locks: refusing, initial: answer() })
      driver.start()
      await settle()
      expect(driver.state()).toMatchObject({ role: 'driving', stop: 'finished' })
      expect(server.routes()).toEqual([READ, ADVANCE])
    })
  })
})

describe('leaving', () => {
  it('during a wait: the timer goes, and no request ever comes', async () => {
    const server = fakeServer({ [READ]: [ok(answer())], [ADVANCE]: [ok(wait(8_000))] })
    const driver = tab(server)
    driver.start()
    await settle()
    driver.stop()
    expect(vi.getTimerCount()).toBe(0)
    await pass(HOUR)
    expect(server.count(ADVANCE)).toBe(1)
    expect(driver.state()).toMatchObject({ asking: false, pause: null, nextRequestAt: null })
  })

  it('during a read: it is aborted, and whatever comes back is not read', async () => {
    const server = fakeServer({ [READ]: [NOT_ANSWERED] })
    const driver = tab(server, { initial: answer() })
    driver.start()
    await settle()
    expect(server.calls[0]!.signal.aborted).toBe(false)
    driver.stop()
    expect(server.calls[0]!.signal.aborted).toBe(true)
    await settle()
    expect(vi.getTimerCount()).toBe(0)
    expect(driver.state().answer).toEqual(answer())
  })

  it('during a step: it is left to finish, since a hung-up step costs its lease, and is not read', async () => {
    const server = fakeServer({ [READ]: [ok(answer())], [ADVANCE]: [NOT_ANSWERED] })
    const driver = tab(server)
    driver.start()
    await settle()
    driver.stop()
    expect(server.calls.find(call => call.route === ADVANCE)!.signal.aborted).toBe(false)
    expect(vi.getTimerCount()).toBe(0)

    server.answerHeld()
    await settle()
    expect(driver.state()).toMatchObject({ answer: answer(), stop: null, asking: false })
    await pass(HOUR)
    expect(server.count(ADVANCE)).toBe(1)
  })

  it('gives the lock to the next tab at once', async () => {
    const locks = fakeLocks()
    const server = fakeServer({ [READ]: [ok(answer())], [ADVANCE]: [ok(wait(60_000))] })
    const driver = tab(server, { locks })
    driver.start()
    await settle()
    expect(locks.held.size).toBe(1)
    driver.stop()
    await settle()
    expect(locks.held.size).toBe(0)
  })

  it('while queued: leaves the queue, and a later grant does nothing', async () => {
    const locks = fakeLocks()
    const first = tab(fakeServer({ [READ]: [ok(answer())], [ADVANCE]: [NOT_ANSWERED] }), { locks })
    first.start()
    await settle()
    const server = fakeServer({ [READ]: [ok(atByte(1))] })
    const second = tab(server, { locks, initial: answer() })
    second.start()
    await settle()
    expect(locks.queued()).toBe(1)
    second.stop()
    await settle()
    expect(locks.queued()).toBe(0)
    first.stop()
    await settle()
    await pass(HOUR)
    expect(server.calls.length).toBe(0)
  })

  it('and coming back, as from the back-forward cache: resumes from a read', async () => {
    const server = fakeServer({ [READ]: [ok(answer()), ok(atByte(5))], [ADVANCE]: [ok(wait(8_000)), ok(READY)] })
    const driver = tab(server)
    driver.start()
    await settle()
    driver.stop()
    await pass(HOUR)
    expect(server.routes()).toEqual([READ, ADVANCE])

    driver.start()
    await settle()
    expect(driver.state()).toMatchObject({ stop: 'finished', answer: READY })
    expect(server.routes()).toEqual([READ, ADVANCE, READ, ADVANCE])
  })

  it('does nothing when asked to stop twice, or before it started', async () => {
    const locks = fakeLocks()
    const driver = tab(fakeServer({}), { locks })
    driver.stop()
    driver.stop()
    await settle()
    expect(locks.requests.length).toBe(0)
  })

  it('takes no step from a retry or a rebuild after it has gone', async () => {
    const server = fakeServer({ [READ]: [ok(FAILED)], [ADVANCE]: [ok(READY)], [REBUILD]: [ok({ index: {} })] })
    const driver = tab(server)
    driver.start()
    await settle()
    driver.stop()
    driver.retry()
    driver.rebuildIndex()
    driver.wake('visible')
    await settle()
    expect(server.routes()).toEqual([READ])
  })

  it('a grant that arrives after leaving is handed straight back', async () => {
    const slow = fakeLocks()
    let grant: (() => void) | undefined
    const locks: DriverLocks = {
      request: (name, options, callback) => new Promise((resolve) => {
        grant = () => {
          void slow.request(name, options, callback).then(resolve)
        }
      }),
    }
    const server = fakeServer({})
    const driver = tab(server, { locks })
    driver.start()
    driver.stop()
    grant!()
    await settle()
    expect(slow.held.size).toBe(0)
    expect(server.calls.length).toBe(0)
  })
})

describe('a hidden tab', () => {
  it('just asks again when a throttled timer fires late', async () => {
    const delays: Array<() => void> = []
    const server = fakeServer({ [READ]: [ok(answer())], [ADVANCE]: [ok(wait(8_000)), ok(READY)] })
    // A timer the browser holds back: it has not fired, whatever the clock says.
    const driver = tab(server, {
      setTimer: (fire, ms) => {
        if (ms === 8_000) {
          delays.push(fire)
          return 'throttled'
        }
        return setTimeout(fire, ms)
      },
      clearTimer: timer => timer === 'throttled' ? undefined : clearTimeout(timer as ReturnType<typeof setTimeout>),
    })
    driver.start()
    await settle()
    expect(delays.length).toBe(1)
    await pass(60_000)
    expect(server.count(ADVANCE)).toBe(1)

    delays[0]!()
    await settle()
    expect(server.count(ADVANCE)).toBe(2)
    expect(driver.state().stop).toBe('finished')
  })

  it('does not wait for the timer once it is back in view and the time has passed', async () => {
    const server = fakeServer({ [READ]: [ok(answer())], [ADVANCE]: [ok(wait(8_000)), ok(READY)] })
    const driver = tab(server, { setTimer: () => 'throttled', clearTimer: () => undefined })
    driver.start()
    await settle()
    vi.setSystemTime(Date.now() + 8_000)
    driver.wake('visible')
    await settle()
    expect(server.count(ADVANCE)).toBe(2)
  })

  it('does not hurry a wait that has time left because the tab came back', async () => {
    const server = fakeServer({ [READ]: [ok(answer())], [ADVANCE]: [ok(wait(8_000)), ok(READY)] })
    const driver = tab(server)
    driver.start()
    await settle()
    driver.wake('visible')
    await settle()
    expect(server.count(ADVANCE)).toBe(1)
    driver.wake('online')
    await settle()
    expect(server.count(ADVANCE)).toBe(1)
  })

  it('a stopped tab coming back into view looks once, and spends nothing on a failure', async () => {
    const server = fakeServer({ [READ]: [ok(FAILED), ok(answer({ status: 'failed', next: 'continue' }))] })
    const driver = tab(server)
    driver.start()
    await settle()

    await pass(RELOOK_AFTER_MS - 1)
    driver.wake('visible')
    await settle()
    expect(server.count(READ)).toBe(1)

    await pass(1)
    driver.wake('visible')
    await settle()
    expect(server.routes()).toEqual([READ, READ])
    expect(driver.state()).toMatchObject({ stop: 'failed', retryFrom: Date.now() })
  })

  it('a parked tab coming back after the park carries on with no click', async () => {
    const parked = answer({ status: 'ready', next: 'done', retryAfterMs: HOUR, retryAt: 'x', index: { state: 'parked', done: 3, total: null, retryAt: null } })
    const moving = answer({ status: 'ready', next: 'continue', index: { state: 'building', done: 3, total: null, retryAt: null } })
    const server = fakeServer({ [READ]: [ok(parked), ok(moving)], [ADVANCE]: [ok(READY)] })
    const driver = tab(server)
    driver.start()
    await settle()
    await pass(HOUR + 1)
    driver.wake('visible')
    await settle()
    expect(driver.state()).toMatchObject({ stop: 'finished', answer: READY })
  })

  it.each<[string, PipelineResponse]>([
    ['finished for good', READY],
    ['held', answer({ status: 'ready', next: 'done', index: { state: 'held', done: 0, total: null, retryAt: null } })],
  ])('a tab %s has nothing to come back to', async (_name, final) => {
    const server = fakeServer({ [READ]: [ok(final)] })
    const driver = tab(server)
    driver.start()
    await settle()
    await pass(HOUR)
    driver.wake('visible')
    await settle()
    expect(server.count(READ)).toBe(1)
  })
})

describe('the public demo', () => {
  it('asks nothing, holds nothing and sets no timer when the page already has an answer', async () => {
    const locks = fakeLocks()
    const unfinished = answer({ status: 'uploaded', next: 'wait' })
    const server = fakeServer({})
    const driver = tab(server, { locks, readOnly: true, initial: unfinished })
    driver.start()
    await settle()
    expect(driver.state()).toMatchObject({ role: 'read-only', answer: unfinished, stop: null, pause: null })
    expect(server.calls.length).toBe(0)
    expect(locks.requests.length).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
    await pass(24 * HOUR)
    expect(server.calls.length).toBe(0)
  })

  it('reads once when it has nothing to show, and never sends a step', async () => {
    const locks = fakeLocks()
    const server = fakeServer({ [READ]: [ok(READY)] })
    const driver = tab(server, { locks, readOnly: true })
    driver.start()
    await settle()
    await pass(HOUR)
    expect(server.routes()).toEqual([READ])
    expect(driver.state()).toMatchObject({ answer: READY, stop: null })
    expect(locks.requests.length).toBe(0)
  })

  it('tries that read a few times, then says it could not, with no retry', async () => {
    const server = fakeServer({ [READ]: [reply(500, {})] })
    const driver = tab(server, { readOnly: true })
    driver.start()
    await settle()
    await pass(HOUR)
    expect(server.routes()).toEqual([READ, READ, READ])
    expect(driver.state()).toMatchObject({ stop: 'trouble', retryFrom: null, role: 'read-only' })
  })

  it('says a meeting is gone', async () => {
    const driver = tab(fakeServer({ [READ]: [reply(404, {})] }), { readOnly: true })
    driver.start()
    await settle()
    expect(driver.state().stop).toBe('missing')
  })

  it('offers no way to take a step', async () => {
    const server = fakeServer({ [READ]: [ok(FAILED)], [ADVANCE]: [ok(READY)], [REBUILD]: [ok({ index: {} })] })
    const driver = tab(server, { readOnly: true, initial: FAILED })
    driver.start()
    driver.retry()
    driver.rebuildIndex()
    driver.wake('visible')
    await settle()
    expect(server.calls.length).toBe(0)
  })

  it('starts from a role that says so, on the server\'s render too', () => {
    expect(initialDriverState(null, true).role).toBe('read-only')
    expect(initialDriverState(null).role).toBe('starting')
  })
})

describe('rebuilding the index', () => {
  const held = answer({ status: 'ready', next: 'done', index: { state: 'held', done: 0, total: null, retryAt: null } })
  const step = (done: number, next: 'continue' | 'wait' = 'continue', retryAfterMs: number | null = null) =>
    reply(202, { progress: { done, total: null, lastError: null }, next, retryAt: null, retryAfterMs })

  it('runs the explicit route to its end and then reads where that leaves things', async () => {
    const server = fakeServer({ [READ]: [ok(held), ok(READY)], [REBUILD]: [step(16), step(32), ok({ index: { state: 'ready' } })] })
    const driver = tab(server)
    driver.start()
    await settle()
    expect(driver.state().stop).toBe('finished')

    driver.rebuildIndex()
    await settle()
    expect(server.routes()).toEqual([READ, REBUILD, REBUILD, REBUILD, READ])
    expect(driver.state()).toMatchObject({ stop: 'finished', answer: READY, rebuild: null, rebuildError: null })
    expect(server.count(ADVANCE)).toBe(0)
  })

  it('reports how far it has got', async () => {
    const server = fakeServer({ [READ]: [ok(held)], [REBUILD]: [step(16, 'wait', 5_000), ok({ index: {} })] })
    const driver = tab(server)
    driver.start()
    await settle()
    driver.rebuildIndex()
    await settle()
    expect(driver.state()).toMatchObject({ rebuild: { done: 16, total: null }, pause: 'wait', stop: null })
  })

  it('waits when it is told to, for as long as it is told to', async () => {
    const server = fakeServer({ [READ]: [ok(held)], [REBUILD]: [step(16, 'wait', 5_000), ok({ index: {} })] })
    const driver = tab(server)
    driver.start()
    await settle()
    driver.rebuildIndex()
    await settle()
    await pass(4_999)
    expect(server.count(REBUILD)).toBe(1)
    await pass(1)
    expect(server.count(REBUILD)).toBe(2)
  })

  it('passes on the route\'s own sentence, and nothing but that', async () => {
    const MESSAGE = 'The free daily limit for indexing and questions has been reached. It resets at 00:00 UTC.'
    const server = fakeServer({ [READ]: [ok(held)], [REBUILD]: [reply(429, { statusMessage: 'Indexing failed', message: MESSAGE })] })
    const driver = tab(server)
    driver.start()
    await settle()
    driver.rebuildIndex()
    await settle()
    expect(driver.state()).toMatchObject({ rebuildError: MESSAGE, rebuild: null, stop: 'finished', answer: held })
    expect(server.count(REBUILD)).toBe(1)
  })

  it.each<[string, FakeReply]>([
    ['a 500 of anyone else\'s', reply(500, { statusMessage: 'Server Error', message: 'relation "windows" does not exist' })],
    ['no sentence', reply(500, {})],
    ['something not written for a person', reply(500, { statusMessage: 'Indexing failed', message: 'x'.repeat(401) })],
    ['HTML', { status: 502, notJson: true }],
  ])('says its own sentence for %s', async (_name, refusal) => {
    const server = fakeServer({ [READ]: [ok(held)], [REBUILD]: [refusal] })
    const driver = tab(server)
    driver.start()
    await settle()
    driver.rebuildIndex()
    await settle()
    expect(driver.state().rebuildError).toBe(REBUILD_REFUSED)
  })

  it('goes read-only on a 403, with nothing more sent', async () => {
    const server = fakeServer({ [READ]: [ok(held)], [REBUILD]: [reply(403, {})] })
    const driver = tab(server)
    driver.start()
    await settle()
    driver.rebuildIndex()
    await settle()
    expect(driver.state().role).toBe('read-only')
    await pass(HOUR)
    expect(server.count(REBUILD)).toBe(1)
  })

  it('waits out a lost connection and carries on', async () => {
    const server = fakeServer({ [READ]: [ok(held), ok(READY)], [REBUILD]: [LOST, ok({ index: {} })] })
    const driver = tab(server)
    driver.start()
    await settle()
    driver.rebuildIndex()
    await settle()
    expect(driver.state()).toMatchObject({ pause: 'network', rebuild: { done: 0, total: null } })
    await pass(5_000)
    expect(driver.state()).toMatchObject({ stop: 'finished', answer: READY, rebuild: null })
  })

  it('cannot spin: a continue that keeps showing nothing new ends it', async () => {
    const server = fakeServer({ [READ]: [ok(held)], [REBUILD]: [step(16)] })
    const driver = tab(server)
    driver.start()
    await settle()
    driver.rebuildIndex()
    await settle()
    expect(server.count(REBUILD)).toBe(MAX_IDLE_CONTINUES + 1)
    expect(driver.state()).toMatchObject({ rebuildError: REBUILD_REFUSED, rebuild: null, stop: 'finished' })
    await pass(HOUR)
    expect(server.count(REBUILD)).toBe(MAX_IDLE_CONTINUES + 1)
  })

  it('stops on leaving, and does not start again on coming back', async () => {
    const server = fakeServer({ [READ]: [ok(held)], [REBUILD]: [step(16, 'wait', 5_000)] })
    const driver = tab(server)
    driver.start()
    await settle()
    driver.rebuildIndex()
    await settle()
    driver.stop()
    await pass(HOUR)
    expect(server.count(REBUILD)).toBe(1)
    driver.start()
    await settle()
    await pass(HOUR)
    expect(server.count(REBUILD)).toBe(1)
  })

  it('takes the lock, and runs in the tab that already holds it', async () => {
    const locks = fakeLocks()
    const server = fakeServer({ [READ]: [ok(answer({ next: 'wait', retryAfterMs: 60_000 })), ok(READY)], [ADVANCE]: [ok(wait(60_000))], [REBUILD]: [ok({ index: {} })] })
    const driver = tab(server, { locks })
    driver.start()
    await settle()
    expect(locks.held.size).toBe(1)
    await pass(60_000)
    driver.rebuildIndex()
    await settle()
    expect(driver.state().stop).toBe('finished')
    expect(locks.held.size).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('does not run twice over', async () => {
    const server = fakeServer({ [READ]: [ok(held)], [REBUILD]: [step(16, 'wait', 5_000)] })
    const driver = tab(server)
    driver.start()
    await settle()
    driver.rebuildIndex()
    driver.rebuildIndex()
    await settle()
    expect(server.count(REBUILD)).toBe(1)
  })
})

describe('what a page is told', () => {
  it('hears about every change, so it can show it', async () => {
    const seen: Array<ReturnType<typeof initialDriverState>> = []
    const server = fakeServer({ [READ]: [ok(answer())], [ADVANCE]: [ok(READY)] })
    tab(server, { onChange: state => seen.push(state) }).start()
    await settle()
    expect(seen.some(state => state.asking)).toBe(true)
    expect(seen.at(-1)).toMatchObject({ asking: false, stop: 'finished', answer: READY })
  })

  it('never gets the same object twice, since a page watches it by identity', async () => {
    const seen: unknown[] = []
    const server = fakeServer({ [READ]: [ok(answer())], [ADVANCE]: [ok(READY)] })
    tab(server, { onChange: state => seen.push(state) }).start()
    await settle()
    expect(new Set(seen).size).toBe(seen.length)
  })
})
