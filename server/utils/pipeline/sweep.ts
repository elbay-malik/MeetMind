import type { H3Event } from 'h3'
import { meetingIdSchema } from '#shared/schemas/meeting'
import { isDemoMeetingId } from '#shared/utils/meeting'
import { isDriverRefusal } from '../drivers'
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

export interface SweepSettings {
  /** What `NUXT_PUBLIC_DEMO_MEETING_ID` holds, as it stands. */
  demoMeetingId: unknown
}

/** The configured demo as the database can be told it, or null when no meeting can be it. */
function demoIdOf(configured: unknown): string | null {
  const id = String(configured ?? '').trim()
  return meetingIdSchema.safeParse(id).success ? id : null
}

/** One tick: choose a meeting, then take its one step, at most one claim and one provider request. */
export async function sweepOnce(deps: PipelineDeps, { demoMeetingId }: SweepSettings): Promise<SweepOutcome> {
  const { meetingId, busy } = await deps.pipeline.nextForSweep({
    model: deps.embedder.model,
    excludeId: demoIdOf(demoMeetingId),
    limitError: DAILY_LIMIT_MESSAGE,
  })
  if (meetingId === null) return { kind: 'idle' }
  // The database was told, and this is the one thing here not to take on trust.
  if (isDemoMeetingId(demoMeetingId, meetingId)) return { kind: 'no-step' }
  const taken = await advanceUnattended(meetingId, deps, busy)
  return taken ? { kind: 'step', ...taken } : { kind: 'no-step' }
}

/**
 * What a tick says: one line when something happened, and nothing for a tick with nothing to
 * do, of which there are up to 288 a day. A failure gets the kind of error and no more:
 * its message can hold a provider's reply, a transcript's words or a stored error, and
 * what went wrong with a step is on its run's row.
 */
export async function reportTick(work: () => Promise<SweepOutcome>): Promise<void> {
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
  if (outcome.kind === 'step') console.info(`[meetmind] sweep: ${outcome.step} step, ${outcome.outcome}`)
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
  await reportTick(async () => {
    const event = scheduledEvent(cloudflare)
    const deps = usePipelineDeps(event)
    const { demoMeetingId } = useRuntimeConfig(event).public
    return withoutLogs(() => sweepOnce(deps, { demoMeetingId }))
  })
}
