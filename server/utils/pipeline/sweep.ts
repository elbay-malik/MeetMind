import type { H3Event } from 'h3'
import { meetingIdSchema } from '#shared/schemas/meeting'
import { isDemoMeetingId } from '#shared/utils/meeting'
import { isPastRetention, purgeDaysInEffect, readRetentionDays } from '#shared/utils/retention'
import { isDriverRefusal } from '../drivers'
import { deleteMeeting, removeDataWith } from '../meeting-deletion'
import { DAILY_LIMIT_MESSAGE } from '../qa/embedder'
import { withoutLogs } from '../quiet-logs'
import { advanceUnattended, type PipelineDeps } from './advance'
import type { PipelineStep } from './assess'
import { usePipelineDeps } from './deps'

/**
 * The cron sweeper (ADR-0012's step 11 addendum): one step of one meeting each tick, with
 * nobody watching, for a meeting whose tab has closed. It runs only where a Cron Trigger calls
 * it, through the `cloudflare:scheduled` hook in server/plugins/sweeper.ts. No route reaches
 * this, so no visitor can spend allowance through it, and a test calls these functions.
 */

export type SweepOutcome
  /** No meeting can move. The database has still been asked, and that is the keep-alive. */
  = | { kind: 'idle' }
    /** One was chosen, and by the time it was read it had no step to take. */
    | { kind: 'no-step' }
    | { kind: 'step', step: PipelineStep, outcome: string }
    /** No step, and the retention purge deleted one expired meeting: its row and its objects. */
    | { kind: 'purged' }
    /** No step, and the one expired meeting it chose was not deleted. A later tick asks again. */
    | { kind: 'purge-left' }
    /** No step, and the purge did not look: the configured demo names no meeting. */
    | { kind: 'purge-no-demo' }

export interface SweepSettings {
  /** What `NUXT_PUBLIC_DEMO_MEETING_ID` holds, as it stands. */
  demoMeetingId: unknown
  /** The days the retention purge runs at (ADR-0017), or null when it does not, as is the default. */
  purgeDays?: number | null
}

/** The configured demo as the database can be told it, or null when no meeting can be it. */
function demoIdOf(configured: unknown): string | null {
  const id = String(configured ?? '').trim()
  return meetingIdSchema.safeParse(id).success ? id : null
}

/**
 * One tick: choose a meeting, then take its one step, at most one claim and one provider request.
 * With no step to take, and only then, the retention purge gets the tick: a tick does one thing,
 * and a person may be waiting on the step.
 */
export async function sweepOnce(deps: PipelineDeps, settings: SweepSettings): Promise<SweepOutcome> {
  const { demoMeetingId } = settings
  const { meetingId, busy } = await deps.pipeline.nextForSweep({
    model: deps.embedder.model,
    excludeId: demoIdOf(demoMeetingId),
    limitError: DAILY_LIMIT_MESSAGE,
  })
  // The database was told, and this is the one thing here not to take on trust.
  if (meetingId !== null && !isDemoMeetingId(demoMeetingId, meetingId)) {
    const taken = await advanceUnattended(meetingId, deps, busy)
    if (taken) return { kind: 'step', ...taken }
  }
  const idle: SweepOutcome = { kind: meetingId === null ? 'idle' : 'no-step' }
  const purged = settings.purgeDays ? await purgeOneExpired(deps, demoMeetingId, settings.purgeDays) : null
  return purged ?? idle
}

/**
 * Delete one meeting past its retention days (ADR-0017), through the same delete as the admin
 * route, with its blocker and its fence. Irreversible and unattended, so what the database
 * chose is looked at again by what it says it is, before anything is touched: another reader's
 * mistake, a wrong clock or a wrong demo id stops here. Null when nothing has expired.
 */
export async function purgeOneExpired(deps: PipelineDeps, demoMeetingId: unknown, days: number): Promise<SweepOutcome | null> {
  const demoId = demoIdOf(demoMeetingId)
  if (demoId === null) return null
  // A mistyped id is well formed, leaves out nothing, and would leave the real demo to expire.
  if (!await deps.meetings.get(demoId)) return { kind: 'purge-no-demo' }
  const id = await deps.pipeline.nextExpired({ days, excludeId: demoId })
  if (id === null) return null
  if (isDemoMeetingId(demoMeetingId, id)) return { kind: 'purge-left' }
  const meeting = await deps.meetings.get(id)
  if (!meeting || !isPastRetention(meeting.createdAt, days, (deps.now ?? Date.now)())) return { kind: 'purge-left' }

  const outcome = await deleteMeeting(id, {
    meetings: deps.meetings,
    pipeline: deps.pipeline,
    removeData: (meetingId, audioKey) => removeDataWith(deps, meetingId, audioKey),
    now: deps.now,
  })
  return { kind: outcome.kind === 'deleted' ? 'purged' : 'purge-left' }
}

let purgeNoticeGiven = false

/** Once in an isolate, so a setting left wrong is not a line in every one of 288 ticks a day. */
function oncePerIsolate(line: string): string | null {
  if (purgeNoticeGiven) return null
  purgeNoticeGiven = true
  return line
}

/**
 * Why a retention setting that is not empty does nothing, or null. A person who set it believes
 * it is on. Names the settings and no value.
 */
function purgeOffNotice(setting: unknown, days: number | null): string | null {
  if (days !== null) return null
  const { days: asked, unusable } = readRetentionDays(setting)
  if (!unusable && asked === null) return null
  return oncePerIsolate(unusable
    ? '[meetmind] sweep: NUXT_RETENTION_PURGE_DAYS is not a positive whole number, so nothing is purged. See ADR-0017.'
    : '[meetmind] sweep: NUXT_PUBLIC_DEMO_MEETING_ID is not a meeting id, so nothing is purged, since the demo could not be left out. See ADR-0017.')
}

/**
 * What a tick says: one line when something happened, and nothing for a tick with nothing to
 * do, of which there are up to 288 a day. A failure gets the kind of error and no more:
 * its message can hold a provider's reply, a transcript's words or a stored error, and
 * what went wrong with a step is on its run's row.
 */
export async function reportTick(work: () => Promise<SweepOutcome>, notice: () => string | null = () => null): Promise<void> {
  let outcome: SweepOutcome
  try {
    outcome = await work()
  }
  catch (err) {
    // Said once for this isolate already, with the names of what is missing.
    if (isDriverRefusal(err)) return
    console.warn(`[meetmind] sweep failed: ${err instanceof Error ? err.name : 'unknown error'}`)
    return
  }
  if (outcome.kind === 'step') {
    console.info(`[meetmind] sweep: ${outcome.step} step, ${outcome.outcome}`)
    return
  }
  if (outcome.kind === 'purged') {
    console.info('[meetmind] sweep: deleted one meeting past its retention days')
    return
  }
  // Only with no line of its own to say: this waits for such a tick, of which there are many.
  const line = outcome.kind === 'purge-no-demo'
    ? oncePerIsolate('[meetmind] sweep: NUXT_PUBLIC_DEMO_MEETING_ID names no meeting, so nothing is purged, since the demo could not be left out. See ADR-0017.')
    : notice()
  if (line) console.warn(line)
}

/**
 * The event a scheduled invocation stands in for, which is not a request: only `context`
 * exists, with what `useRuntimeConfig(event)` and the driver gate read in it, and anything
 * reading more fails where it reads, rather than finding `undefined` and carrying on.
 * `cloudflare` is what Nitro's own `runCronTasks` hands a task, and what the gate reads as
 * a request's `event.context.cloudflare`, so a tick is judged as a Worker by the same signal.
 * That is decided per invocation, as for a request (ADR-0016): `useRuntimeConfig()` with no
 * event is what was read when the isolate loaded, before a Worker has its settings.
 */
export function scheduledEvent(cloudflare: { env: unknown, context: unknown }): H3Event {
  const context = { nitro: {}, cloudflare }
  return new Proxy({ context }, {
    get(target, key) {
      if (key === 'context') return target.context
      throw new Error(`A scheduled invocation has no request, and something read event.${String(key)}`)
    },
  }) as unknown as H3Event
}

/**
 * What the hook calls: one tick, which cannot throw, under the same gate as any request. The
 * gate is outside {@link withoutLogs}, since its refusal is the one line that must be read.
 */
export async function runScheduledTick(cloudflare: { env: unknown, context: unknown }): Promise<void> {
  let notice: () => string | null = () => null
  await reportTick(async () => {
    const event = scheduledEvent(cloudflare)
    const deps = usePipelineDeps(event)
    const config = useRuntimeConfig(event)
    const { demoMeetingId } = config.public
    const purgeDays = purgeDaysInEffect(config.retentionPurgeDays, demoMeetingId)
    notice = () => purgeOffNotice(config.retentionPurgeDays, purgeDays)
    return withoutLogs(() => sweepOnce(deps, { demoMeetingId, purgeDays }))
  }, () => notice())
}
