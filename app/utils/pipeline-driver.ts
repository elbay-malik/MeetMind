import type { PipelineResponse } from '#shared/types/meeting'

/**
 * The browser's half of ADR-0012 §1: ask the server to take a meeting's next step until it
 * says there is nothing more to do, one tab per browser, and never faster than it says to.
 *
 * Nothing here knows about Vue, the DOM or real time. It is handed its clock, its timers,
 * its `fetch` and its lock manager, so every rule below can be run in a test, in fake time.
 * The server stays the authority (each step is claimed under a token), so what is decided
 * here is only how politely to ask. See the step 10 addendum for why each number is what it is.
 */

/** How often a tab that is not driving looks (ADR-0012 §1). */
export const WATCH_POLL_MS = 5_000
/** How often to look when nothing this tab can do moves the meeting, or a block is hours off. */
export const SLOW_LOOK_MS = 60_000
/** ADR-0012 §1: keeps two tabs told the same moment from arriving together. */
export const MAX_JITTER_MS = 2_000
/** The floor under any wait, so a `retryAt` already past cannot become a tight loop. */
export const SHORTEST_WAIT_MS = 1_000
/**
 * The longest one timer runs before asking again. A wait can last up to a day (ADR-0012's
 * step 9 addendum), and a browser's clock or a block's end can both be wrong, so a long wait
 * is a series of these. A request with no step to take writes nothing and costs at most five
 * subrequests, so a day of this is 288 of them.
 */
export const LONGEST_SLEEP_MS = 5 * 60_000
/** A wait at least this long is a provider's block, not the pacing of a healthy run. */
export const LONG_WAIT_MS = 2 * 60_000
/**
 * `continue` answers in a row that showed nothing new before the driver pauses. The server
 * says each one changed something stored, which a page of a reply doubling its window can do
 * without moving a figure, about five times at most. More than that is something wrong, and
 * each one might be a provider request.
 */
export const MAX_IDLE_CONTINUES = 10
export const SPIN_PAUSE_MS = 30_000
/** Pauses with nothing moving before it stops and asks for a click. */
export const MAX_SPIN_PAUSES = 2
/** A provider's block lasts a day at most, so this long with nothing new is not a block. */
export const LONGEST_NO_PROGRESS_MS = 26 * 60 * 60_000
/** Retries after an answer of 5xx or 429 before it stops and asks for a click. */
export const MAX_TROUBLE_RETRIES = 4
export const FIRST_BACKOFF_MS = 5_000
export const LONGEST_BACKOFF_MS = 60_000
/** A `Retry-After` is honoured up to this. Past it, the tab looks again rather than strand. */
export const LONGEST_HINT_MS = 60 * 60_000
/** Above a Whisper step's ~7 min lease, so only a request that really hung is given up on. */
export const ADVANCE_TIMEOUT_MS = 8 * 60_000
export const READ_TIMEOUT_MS = 30_000
/** A stopped tab coming back into view looks once, if it has not asked for this long. */
export const RELOOK_AFTER_MS = 30_000
/** Reads a page that cannot drive makes before it says it could not read. */
const READ_ONLY_TRIES = 3

/** What this needs of `fetch`. A response's `json` may be anything, and a body may not parse. */
export type DriverFetch = (url: string, init: { method: 'GET' | 'POST', signal: AbortSignal }) => Promise<{
  status: number
  headers: { get: (name: string) => string | null }
  json: () => Promise<unknown>
}>

/** What this needs of `navigator.locks`. `signal` and `ifAvailable` cannot be used together. */
export interface DriverLocks {
  request: (
    name: string,
    options: { ifAvailable?: boolean, signal?: AbortSignal },
    callback: (lock: unknown) => Promise<void> | void,
  ) => Promise<unknown>
}

/** Worth waiting out, because neither says anything about the meeting. */
export type TroubleCause = 'network' | 'server' | 'unavailable' | 'rate-limited'

export type DriverPause
  /** The server said when. */
  = | 'wait'
    /** The server said to wait and not until when, so nothing here can move it. */
    | 'look'
    /** The server keeps saying `continue` and nothing moves. */
    | 'spinning'
    | TroubleCause

export type DriverStop
  /** `done`: read `answer.index`, because this no longer alone means the index is complete. */
  = | 'finished'
    | 'failed'
    /** The meeting is gone. */
    | 'missing'
    /** Too many answers of 5xx or 429 in a row. Says nothing about the meeting. */
    | 'trouble'
    /** The loop's own bounds ran out. Says nothing about the meeting. */
    | 'stalled'

export interface DriverState {
  /**
   * - `starting`: the server's render and the first client render, before any of this runs.
   * - `driving`: this tab holds the lock and asks the server to take steps.
   * - `watching`: another tab of this browser does that, and this one looks every so often.
   * - `read-only`: nothing can move this meeting from a page: the public demo.
   */
  role: 'starting' | 'driving' | 'watching' | 'read-only'
  answer: PipelineResponse | null
  asking: boolean
  pause: DriverPause | null
  /** The duration the server last said to wait, whatever is left of it. */
  waitMs: number | null
  /** When this browser next expects something to happen. By its own clock, from durations. */
  nextRequestAt: number | null
  stop: DriverStop | null
  /** What `stop: 'trouble'` is about. */
  troubleCause: TroubleCause | null
  /** When {@link PipelineDriver.retry} can do anything. Null means it cannot. */
  retryFrom: number | null
  /** An index rebuild is running, and how far it has got. */
  rebuild: { done: number, total: number | null } | null
  /** What the server said of a rebuild it refused. Written for visitors, by that route. */
  rebuildError: string | null
}

export interface PipelineDriver {
  /** Take part: drive, or watch until this tab can. Client only. */
  start: () => void
  /** Leave: no more requests or timers from here, and the lock goes to whichever tab is next. */
  stop: () => void
  /** Ask once more after a stop that said a retry could do something. */
  retry: () => void
  /** Run the explicit `POST .../search-index`, the only thing that replaces a held index. */
  rebuildIndex: () => void
  /** Something happened that may mean a timer ran late or the network came back. */
  wake: (reason: 'visible' | 'online') => void
  state: () => DriverState
}

export interface DriverDeps {
  meetingId: string
  initial?: PipelineResponse | null
  /** The public demo: never asks for a step, never takes the lock. */
  readOnly?: boolean
  fetch: DriverFetch
  /** Null where the browser has none: this tab then drives with no one to coordinate with. */
  locks: DriverLocks | null
  now: () => number
  setTimer: (fire: () => void, ms: number) => unknown
  clearTimer: (timer: unknown) => void
  random: () => number
  onChange?: (state: DriverState) => void
}

export function initialDriverState(answer: PipelineResponse | null, readOnly = false): DriverState {
  return {
    role: readOnly ? 'read-only' : 'starting',
    answer,
    asking: false,
    pause: null,
    waitMs: null,
    nextRequestAt: null,
    stop: null,
    troubleCause: null,
    retryFrom: null,
    rebuild: null,
    rebuildError: null,
  }
}

/** The durations the server gives, not `retryAt` against this browser's clock, unless it gave only that. */
function toldToWaitMs(answer: PipelineResponse, now: number): number | null {
  if (typeof answer.retryAfterMs === 'number' && Number.isFinite(answer.retryAfterMs)) return Math.max(0, answer.retryAfterMs)
  if (typeof answer.retryAt !== 'string') return null
  const at = Date.parse(answer.retryAt)
  return Number.isNaN(at) ? null : Math.max(0, at - now)
}

export type DriverMove
  = | { kind: 'advance' }
    | { kind: 'sleep', ms: number }
    | { kind: 'look' }
    | { kind: 'stop', stop: 'finished' | 'failed', retryInMs: number | null }

/**
 * What an answer means for a driver. A `failed` meeting told `continue` has a step on offer,
 * and with no index work left that step can only be a retry of the failure, which spends a
 * provider's quota and is not this page's to spend by itself: it takes `retryPermitted`, a
 * click. Index work carries on, since a failed extraction does not stop the index (step 9
 * addendum), even though the server may choose the retry instead once the cooldown is over.
 */
export function nextMove(answer: PipelineResponse, { retryPermitted, now }: { retryPermitted: boolean, now: number }): DriverMove {
  const told = toldToWaitMs(answer, now)
  switch (answer.next) {
    case 'continue':
      if (answer.status === 'failed' && answer.index.state !== 'building' && !retryPermitted) {
        return { kind: 'stop', stop: 'failed', retryInMs: 0 }
      }
      return { kind: 'advance' }
    case 'wait':
      return told === null ? { kind: 'look' } : { kind: 'sleep', ms: told }
    case 'done':
      return { kind: 'stop', stop: 'finished', retryInMs: answer.index.state === 'parked' ? told : null }
    case 'failed':
      return { kind: 'stop', stop: 'failed', retryInMs: told }
  }
}

export type DriverReply
  = | { kind: 'answer', answer: PipelineResponse }
    /** The public demo's 403 (ADR-0015). */
    | { kind: 'read-only' }
    | { kind: 'missing' }
    /** `pending_upload`: no step of a driver's can confirm an upload. */
    | { kind: 'not-uploaded' }
    | { kind: 'trouble', cause: TroubleCause, hintMs: number | null }

/** A `Retry-After`, in either of its forms, as a duration. */
function retryAfterMs(header: string | null, now: number): number | null {
  if (!header) return null
  const trimmed = header.trim()
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000
  const at = Date.parse(trimmed)
  return Number.isNaN(at) ? null : Math.max(0, at - now)
}

/** Whichever way the server said how long, the longest of them. */
function hintOf(header: string | null, body: unknown, now: number): number | null {
  const answer = (body ?? {}) as { retryAfterMs?: unknown, data?: { retryAfterMs?: unknown, retryAfterSec?: unknown } }
  const candidates = [
    retryAfterMs(header, now),
    answer.retryAfterMs,
    answer.data?.retryAfterMs,
    typeof answer.data?.retryAfterSec === 'number' ? answer.data.retryAfterSec * 1000 : null,
  ].filter((ms): ms is number => typeof ms === 'number' && Number.isFinite(ms) && ms > 0)
  return candidates.length ? Math.min(Math.max(...candidates), LONGEST_HINT_MS) : null
}

const NEXT_ANSWERS: readonly unknown[] = ['continue', 'wait', 'done', 'failed']

/** A 200 that is not this shape is something else talking: a proxy, a login page, a bug. */
function isPipelineResponse(body: unknown): body is PipelineResponse {
  const answer = (body ?? {}) as Partial<PipelineResponse>
  return NEXT_ANSWERS.includes(answer.next)
    && typeof answer.status === 'string'
    && typeof answer.progress?.stage === 'string'
    && typeof answer.index?.state === 'string'
}

/** What one response means, by what it is rather than by which route gave it. */
export function classifyReply(reply: { status: number, retryAfter: string | null, body: unknown }, now: number): DriverReply {
  const { status, retryAfter, body } = reply
  const hintMs = hintOf(retryAfter, body, now)
  if (status === 200 && isPipelineResponse(body)) return { kind: 'answer', answer: body }
  if (status === 403) return { kind: 'read-only' }
  if (status === 404) return { kind: 'missing' }
  if (status === 409) return { kind: 'not-uploaded' }
  if (status === 429) return { kind: 'trouble', cause: 'rate-limited', hintMs }
  if (status === 503) return { kind: 'trouble', cause: 'unavailable', hintMs }
  return { kind: 'trouble', cause: 'server', hintMs }
}

/** The figures a page shows, so a change here is what "something moved" means. */
export function progressSignature({ status, progress, index }: PipelineResponse): string {
  return [status, progress.stage, progress.done, progress.total, index.state, index.done, index.total].join('|')
}

/** 5 s, 15 s, 45 s, then a minute, and never shorter than the server asked. */
export function troubleDelayMs(attempt: number, hintMs: number | null): number {
  const backoff = Math.min(FIRST_BACKOFF_MS * 3 ** Math.max(0, attempt - 1), LONGEST_BACKOFF_MS)
  return Math.max(backoff, hintMs ?? 0)
}

/** What `POST .../search-index` answers until the index is finished: a 202 of this shape. */
interface IndexingStep {
  progress: { done: number, total: number | null }
  next: 'continue' | 'wait'
  retryAfterMs: number | null
}

function isIndexingStep(body: unknown): body is IndexingStep {
  const step = (body ?? {}) as Partial<IndexingStep>
  return typeof step.progress?.done === 'number' && (step.next === 'continue' || step.next === 'wait')
}

/** What the page says of a rebuild the server refused, when it has no words of its own to pass on. */
export const REBUILD_REFUSED = 'The index could not be rebuilt. What is stored has been kept. Try again later.'

/**
 * That route's own sentences, which are written for visitors, and nothing else. A 500 from
 * further down can be anything, and this page does not show raw errors (step 9 addendum).
 */
function rebuildRefusal(body: unknown): string {
  const { statusMessage, message } = (body ?? {}) as { statusMessage?: unknown, message?: unknown }
  return statusMessage === 'Indexing failed' && typeof message === 'string' && message.length > 0 && message.length <= 400
    ? message
    : REBUILD_REFUSED
}

export function createPipelineDriver(deps: DriverDeps): PipelineDriver {
  const { meetingId, readOnly = false, fetch, locks, now, setTimer, clearTimer, random, onChange } = deps
  const api = `/api/meetings/${meetingId}`
  const lockName = `meeting:${meetingId}`

  let state = initialDriverState(deps.initial ?? null, readOnly)
  /** Between start and stop: this tab is taking part. */
  let live = false
  /** Moves on whenever the current loop is over. A loop that finds it moved walks away. */
  let loop = 0
  /** The same for the lock: a grant for an earlier seek is not wanted any more. */
  let seek = 0
  let sleeper: { until: number, timer: unknown, end: () => void } | null = null
  let read: AbortController | null = null
  const requestTimers = new Set<unknown>()
  let queued: AbortController | null = null
  let releaseLock: (() => void) | null = null

  let retryPermitted = false
  let rebuilding = false
  /** 5xx and 429 answers in a row, which are bounded. */
  let troubles = 0
  /** Network errors in a row, which are not. */
  let outages = 0
  let lastAskAt = Number.NEGATIVE_INFINITY
  /** Until when the server said to leave it alone, which nothing but a click goes against. */
  let holdOffUntil = Number.NEGATIVE_INFINITY

  /** Every state seen, so that A, B, A, B does not pass for progress. */
  const seen = new Set<string>()
  let idleContinues = 0
  let spinPauses = 0
  let lastProgressAt = 0

  function update(patch: Partial<DriverState>) {
    state = { ...state, ...patch }
    onChange?.(state)
  }

  const jitter = () => random() * MAX_JITTER_MS

  function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const end = () => {
        sleeper = null
        resolve()
      }
      sleeper = { until: now() + ms, timer: setTimer(end, ms), end }
    })
  }

  function endSleep() {
    if (!sleeper) return
    clearTimer(sleeper.timer)
    sleeper.end()
  }

  /** Whatever loop is running is over: its timer goes, its read goes, and it walks away. */
  function nextLoop(): number {
    loop++
    endSleep()
    read?.abort()
    return loop
  }

  function releaseTheLock() {
    queued?.abort()
    queued = null
    releaseLock?.()
    releaseLock = null
    seek++
  }

  /** The current loop is over, and this tab holds nothing while it says why. */
  function finish(stop: DriverStop, retryFrom: number | null, troubleCause: TroubleCause | null = null) {
    nextLoop()
    retryPermitted = false
    rebuilding = false
    releaseTheLock()
    update({ asking: false, pause: null, waitMs: null, nextRequestAt: null, stop, retryFrom, troubleCause, rebuild: null })
  }

  /** Asks and gives back what came back, or null if nothing did. Never throws. */
  async function ask(method: 'GET' | 'POST', path: string) {
    const controller = new AbortController()
    if (method === 'GET') read = controller
    const timer = setTimer(() => controller.abort(), method === 'GET' ? READ_TIMEOUT_MS : ADVANCE_TIMEOUT_MS)
    requestTimers.add(timer)
    lastAskAt = now()
    try {
      const res = await fetch(`${api}${path}`, { method, signal: controller.signal })
      const body = await res.json().catch(() => null)
      return { status: res.status, retryAfter: res.headers.get('retry-after'), body }
    }
    catch {
      return null
    }
    finally {
      clearTimer(timer)
      requestTimers.delete(timer)
      if (read === controller) read = null
    }
  }

  const classify = (reply: Awaited<ReturnType<typeof ask>>): DriverReply =>
    reply ? classifyReply(reply, now()) : { kind: 'trouble', cause: 'network', hintMs: null }

  /** Whether this answer shows anything this tab has not seen. */
  function noteProgress(answer: PipelineResponse): boolean {
    const signature = progressSignature(answer)
    if (seen.has(signature)) return false
    seen.add(signature)
    idleContinues = 0
    spinPauses = 0
    lastProgressAt = now()
    return true
  }

  function resetBounds() {
    seen.clear()
    idleContinues = 0
    spinPauses = 0
    troubles = 0
    lastProgressAt = now()
  }

  /**
   * Whether a `continue` that showed nothing new may be followed at once. Once the bound is
   * reached it pauses instead, and after that stops, so nothing here can run for ever.
   */
  async function mayContinue(mine: number): Promise<boolean> {
    if (++idleContinues < MAX_IDLE_CONTINUES) return true
    idleContinues = 0
    if (++spinPauses > MAX_SPIN_PAUSES) {
      finish('stalled', now())
      return false
    }
    const ms = SPIN_PAUSE_MS + jitter()
    update({ pause: 'spinning', nextRequestAt: now() + ms })
    await sleep(ms)
    return mine === loop
  }

  /** A long wait is a series of short timers, and the countdown stays on what the server said. */
  async function waitOut(ms: number) {
    const total = Math.max(ms, SHORTEST_WAIT_MS) + jitter()
    update({ pause: 'wait', waitMs: ms, nextRequestAt: now() + total })
    await sleep(Math.min(total, LONGEST_SLEEP_MS))
  }

  /** An answer that is not a stop: whatever this tab said before about stopping is over. */
  function adopt(answer: PipelineResponse) {
    update({ answer, stop: null, retryFrom: null, troubleCause: null, pause: null, waitMs: null, nextRequestAt: null })
  }

  /** What to do about trouble: how long to wait, or null to stop. Never hot, whatever the answer was. */
  function delayFor(cause: TroubleCause, hintMs: number | null, bounded: boolean): number | null {
    // A network error says nothing about the server or the meeting, and a tab left open
    // through a lost connection should carry on when it returns. A minute apart, these cost
    // nobody anything, so they have no bound beyond that.
    if (cause === 'network') return troubleDelayMs(++outages, null) + jitter()
    outages = 0
    if (hintMs !== null) holdOffUntil = now() + hintMs
    if (++troubles > MAX_TROUBLE_RETRIES && bounded) return null
    return troubleDelayMs(troubles, hintMs) + jitter()
  }

  function answered() {
    troubles = 0
    outages = 0
  }

  /** The explicit rebuild, one step per request, then back to reading where that leaves things. */
  async function rebuildSteps(mine: number): Promise<boolean> {
    update({ rebuild: { done: 0, total: null }, rebuildError: null })
    const figures = new Set<string>()
    let idle = 0
    for (;;) {
      update({ asking: true })
      const reply = await ask('POST', '/search-index')
      if (mine !== loop) return false
      update({ asking: false, pause: null, nextRequestAt: null })

      if (!reply) {
        const ms = delayFor('network', null, false)!
        update({ pause: 'network', nextRequestAt: now() + ms })
        await sleep(ms)
        if (mine !== loop) return false
        continue
      }
      answered()
      if (reply.status === 403) {
        becomeReadOnly()
        return false
      }
      if (reply.status === 202 && isIndexingStep(reply.body)) {
        const { progress, next } = reply.body
        update({ rebuild: { done: progress.done, total: progress.total } })
        const figure = `${progress.done}|${progress.total}`
        idle = figures.has(figure) && next === 'continue' ? idle + 1 : 0
        figures.add(figure)
        if (idle >= MAX_IDLE_CONTINUES) {
          rebuilding = false
          update({ rebuild: null, rebuildError: REBUILD_REFUSED })
          return true
        }
        if (next === 'wait') {
          await waitOut(reply.body.retryAfterMs ?? WATCH_POLL_MS)
          if (mine !== loop) return false
        }
        continue
      }
      rebuilding = false
      update({ rebuild: null, rebuildError: reply.status === 200 ? null : rebuildRefusal(reply.body) })
      return true
    }
  }

  async function drive(mine: number) {
    update({ role: 'driving' })
    let method: 'read' | 'advance' = 'read'
    for (;;) {
      if (rebuilding) {
        if (!await rebuildSteps(mine)) return
        method = 'read'
        continue
      }

      update({ asking: true })
      const sent = method
      const reply = classify(sent === 'read' ? await ask('GET', '/pipeline') : await ask('POST', '/advance'))
      if (mine !== loop) return
      update({ asking: false })

      if (reply.kind === 'read-only') return becomeReadOnly()
      if (reply.kind === 'missing') return finish('missing', null)
      if (reply.kind === 'not-uploaded') {
        // Only reading can show when that changes. Paced, though a read should say `wait`.
        method = 'read'
        await sleep(SHORTEST_WAIT_MS + jitter())
        if (mine !== loop) return
        continue
      }
      if (reply.kind === 'trouble') {
        const ms = delayFor(reply.cause, reply.hintMs, true)
        if (ms === null) return finish('trouble', Math.max(now(), holdOffUntil), reply.cause)
        update({ pause: reply.cause, nextRequestAt: now() + ms })
        await sleep(ms)
        if (mine !== loop) return
        continue
      }

      answered()
      const { answer } = reply
      const fresh = noteProgress(answer)
      if (sent === 'advance') retryPermitted = false
      const move = nextMove(answer, { retryPermitted, now: now() })

      if (move.kind === 'stop') {
        update({ answer })
        return finish(move.stop, move.retryInMs === null ? null : now() + move.retryInMs)
      }
      if (!fresh && now() - lastProgressAt > LONGEST_NO_PROGRESS_MS) {
        update({ answer })
        return finish('stalled', now())
      }

      adopt(answer)
      if (move.kind === 'advance') {
        if (!fresh && !await mayContinue(mine)) return
        method = 'advance'
      }
      else if (move.kind === 'sleep') {
        idleContinues = 0
        await waitOut(move.ms)
        if (mine !== loop) return
        method = 'advance'
      }
      else {
        update({ pause: 'look' })
        await sleep(SLOW_LOOK_MS)
        if (mine !== loop) return
        method = 'read'
      }
    }
  }

  /** A tab that cannot drive looks, and leaves the deciding to whichever tab can. */
  async function watch(mine: number) {
    update({ role: 'watching' })
    let delay = state.answer ? WATCH_POLL_MS : 0
    for (;;) {
      if (delay > 0) {
        await sleep(delay)
        if (mine !== loop) return
      }
      update({ asking: true })
      const reply = classify(await ask('GET', '/pipeline'))
      if (mine !== loop) return
      update({ asking: false })

      if (reply.kind === 'missing') return finish('missing', null)
      if (reply.kind === 'trouble') {
        delay = delayFor(reply.cause, reply.hintMs, false)!
        update({ pause: reply.cause, nextRequestAt: now() + delay })
        continue
      }
      if (reply.kind !== 'answer') {
        delay = WATCH_POLL_MS
        continue
      }

      answered()
      const { answer } = reply
      const move = nextMove(answer, { retryPermitted: false, now: now() })
      if (move.kind === 'stop') {
        update({ answer })
        return finish(move.stop, move.retryInMs === null ? null : now() + move.retryInMs)
      }
      adopt(answer)
      if (move.kind === 'sleep') {
        update({ pause: 'wait', waitMs: move.ms, nextRequestAt: now() + move.ms })
        delay = move.ms >= LONG_WAIT_MS ? SLOW_LOOK_MS : WATCH_POLL_MS
      }
      else if (move.kind === 'look') {
        update({ pause: 'look' })
        delay = SLOW_LOOK_MS
      }
      else {
        delay = WATCH_POLL_MS
      }
    }
  }

  /** Nothing from a page can move this one. A page with something to show asks for nothing. */
  async function readOnlyLook(mine: number, force: boolean) {
    if (state.answer && !force) return
    for (let tries = 1; tries <= READ_ONLY_TRIES; tries++) {
      const reply = classify(await ask('GET', '/pipeline'))
      if (mine !== loop) return
      if (reply.kind === 'missing') return finish('missing', null)
      if (reply.kind === 'answer') return update({ answer: reply.answer })
      if (tries < READ_ONLY_TRIES) {
        await sleep(troubleDelayMs(tries, null) + jitter())
        if (mine !== loop) return
      }
    }
    // Whatever is on the page already stays. Only a page with nothing to show has to say so.
    if (!state.answer) finish('trouble', null, 'server')
  }

  function becomeReadOnly() {
    nextLoop()
    releaseTheLock()
    retryPermitted = false
    rebuilding = false
    update({ role: 'read-only', asking: false, pause: null, waitMs: null, nextRequestAt: null, stop: null, retryFrom: null, rebuild: null })
    void readOnlyLook(loop, true)
  }

  /** The lock is this tab's. Whatever it was doing, it now drives, until the lock is given back. */
  function holdLock(): Promise<void> {
    const released = new Promise<void>((resolve) => {
      releaseLock = resolve
    })
    void drive(nextLoop())
    return released
  }

  function driveWithoutLock() {
    void drive(nextLoop())
  }

  /** Queue for the lock, watching in the meantime. It comes when the driver's tab closes. */
  function queue(mine: number) {
    if (!locks) return
    queued = new AbortController()
    void watch(nextLoop())
    locks.request(lockName, { signal: queued.signal }, () => {
      if (mine !== seek || !live) return
      queued = null
      return holdLock()
    }).catch((err: unknown) => {
      // Refused for a reason of its own (an opaque origin, say). The server's claim is the
      // authority, so driving unlocked is safe, and a tab that can only watch never finishes.
      if (mine === seek && live && (err as { name?: string })?.name !== 'AbortError') driveWithoutLock()
    })
  }

  function seekLock() {
    if (!locks) return driveWithoutLock()
    queued?.abort()
    queued = null
    const mine = ++seek
    locks.request(lockName, { ifAvailable: true }, (lock) => {
      if (mine !== seek || !live) return
      if (lock) return holdLock()
      queue(mine)
    }).catch(() => {
      if (mine === seek && live) driveWithoutLock()
    })
  }

  /** Start over from a read. A tab that already holds the lock keeps it. */
  function begin() {
    resetBounds()
    if (releaseLock) void drive(nextLoop())
    else seekLock()
  }

  return {
    state: () => state,

    start() {
      if (live) return
      live = true
      if (readOnly) {
        update({ role: 'read-only' })
        void readOnlyLook(++loop, false)
        return
      }
      update({ role: 'starting' })
      begin()
    },

    stop() {
      if (!live) return
      live = false
      // A read has nothing to finish, so it goes. A step is left to: on a Worker, a client
      // hanging up kills it, and its lease then has to run out before anyone can take it
      // again. It loses its timer, and nothing here reads its answer.
      nextLoop()
      retryPermitted = false
      rebuilding = false
      for (const timer of requestTimers) clearTimer(timer)
      requestTimers.clear()
      releaseTheLock()
      update({ asking: false, pause: null, waitMs: null, nextRequestAt: null, rebuild: null })
    },

    retry() {
      if (!live || state.role === 'read-only') return
      retryPermitted = true
      update({ stop: null, retryFrom: null, troubleCause: null, rebuildError: null })
      begin()
    },

    rebuildIndex() {
      if (!live || state.role === 'read-only' || rebuilding) return
      rebuilding = true
      update({ stop: null, retryFrom: null, troubleCause: null, rebuildError: null })
      begin()
    },

    wake(reason) {
      if (!live || state.role === 'read-only') return
      // Throttled timers are the one case of this: it fires late, and it just asks again. The
      // connection coming back says nothing about a server that answered, whatever it answered.
      if (sleeper && (sleeper.until <= now() || (reason === 'online' && state.pause === 'network'))) endSleep()
      // A tab that had stopped comes back to something another tab, or the clock, has moved.
      const stoppedWithMore = state.stop === 'failed' || state.stop === 'trouble' || (state.stop === 'finished' && state.retryFrom !== null)
      if (stoppedWithMore && now() >= holdOffUntil && now() - lastAskAt >= RELOOK_AFTER_MS) begin()
    },
  }
}
