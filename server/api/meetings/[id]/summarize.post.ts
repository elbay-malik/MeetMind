import { isError } from 'h3'
import type { Meeting, MeetingSummary } from '#shared/types/meeting'
import { useMeetingRepository, useSummaryRepository, useTranscriptRepository } from '../../../utils/db'
import { conflict, notFound, requireMeetingId } from '../../../utils/http'
import { useSummarizer } from '../../../utils/summary'
import { CHUNK_BUDGET_TOKENS } from '../../../utils/summary/groq'
import { planChunks } from '../../../utils/summary/plan'
import { SummarizationError } from '../../../utils/summary/summarizer'

/**
 * How long a claim is honoured before another caller may take it over. Sized
 * to the worst case this route can actually take, not a guess: MAX_CHUNKS
 * sequential requests, each retried once (createGroqSummarizer's default
 * maxAttempts), each bounded by its 90s request timeout — 40 * 2 * 90s = 2
 * hours, plus margin. A shorter lease could reclaim a caller that is still
 * legitimately running, and the compare-and-swap below only protects against
 * that up to the fencing check; it cannot undo provider spend already made.
 */
const CLAIM_LEASE_MS = 3 * 60 * 60_000

/**
 * How long a failure must sit before it can be retried. Extraction is several
 * sequential provider requests, not one, so an instant retry after a failure
 * re-hammers the provider with the whole run again immediately.
 *
 * A fixed ceiling, not an exact wait: Groq can return a `Retry-After` longer
 * than this on a 429 (shown to the user in errorMessage), and this route does
 * not currently carry that specific value across requests to honour it
 * exactly — doing so needs a persisted per-failure deadline, which is a
 * bigger change than this fixed cooldown. 60s comfortably covers a per-minute
 * throttle window resetting, which is what Groq's quota errors are.
 */
const RETRY_COOLDOWN_MS = 60_000

/**
 * A transcript needing more sequential requests than this is rejected before
 * any of them are sent. Nothing bounds chunk count otherwise: a meeting long
 * enough to need dozens of requests would tie up a request handler for
 * minutes and spend the provider's quota on a single caller.
 */
const MAX_CHUNKS = 40

/**
 * Statuses whose stored summary is safe to return early. Deliberately
 * `ready` only — NOT `indexing`: a re-transcription cascades away a stale
 * summary's citations but leaves `meeting_summaries` itself in place (see
 * ADR-0006), so a meeting genuinely mid a fresh extraction run can still have
 * an old stored summary sitting there. Treating `indexing` as "done" would
 * hand a concurrent caller that stale row instead of telling it extraction is
 * still running.
 */
const PAST_SUMMARY = ['ready']

/**
 * Extract decisions and action items from a meeting's transcript.
 *
 * Phase 6 has no orchestrator — that is Phase 9 — so this is invoked directly.
 * Safe to call twice: a meeting past extraction returns what it has, and the
 * claim keeps concurrent callers from both spending the provider's quota.
 */
export default defineEventHandler(async (event): Promise<{
  meeting: Meeting
  summary: MeetingSummary
}> => {
  const id = requireMeetingId(event)
  const repo = useMeetingRepository(event)
  const summaries = useSummaryRepository(event)

  const meeting = await repo.get(id)
  if (!meeting) throw notFound('Meeting not found')

  if (PAST_SUMMARY.includes(meeting.status)) {
    const stored = await summaries.getForMeeting(id)
    if (stored) return { meeting, summary: stored }
    // `ready` with no stored summary is a broken invariant, not a live race
    // to arbitrate — nothing in this route ever sets a meeting BACK to
    // `ready` except the write immediately after the summary that makes it
    // true, so falling through here (rather than returning) means claim()
    // below needs to accept `ready` as something worth reclaiming, not that
    // any other caller could legitimately be mid-flight against it.
  }

  const segments = await useTranscriptRepository(event).listForMeeting(id)
  // Refuse before claiming: a meeting with no transcript has nothing to extract
  // and should not be moved out of the state it is in.
  if (segments.length === 0) {
    throw conflict('This meeting has no transcript to summarise yet')
  }

  const chunkCount = planChunks(segments, CHUNK_BUDGET_TOKENS).length
  if (chunkCount > MAX_CHUNKS) {
    throw createError({
      statusCode: 413,
      statusMessage: 'Transcript too long',
      message: `This transcript would need ${chunkCount} sequential requests, over the ${MAX_CHUNKS} limit.`,
    })
  }

  const claimed = await claim(repo, meeting)
  if (!claimed) {
    const current = await repo.get(id)
    if (!current) throw notFound('Meeting not found')
    const stored = await summaries.getForMeeting(id)
    if (stored && PAST_SUMMARY.includes(current.status)) return { meeting: current, summary: stored }
    throw conflict(describeWhyNotClaimable(current))
  }

  // Fences every write below against a later stale-lease reclaim of THIS same
  // meeting: reclaiming `indexing` writes `indexing` again, which changes
  // `updatedAt` without changing `status`. A plain `from`-only compare-and-swap
  // cannot tell "still mine" from "reclaimed out from under me" in that case;
  // requiring `updatedAt` to still match the value observed right here can.
  let fence = claimed.updatedAt

  try {
    const summary = await useSummarizer(event).summarize({ segments })

    // Renew the fence immediately before the one write in this route that
    // is NOT itself claim-gated: replaceForMeeting has no compare-and-swap of
    // its own. summarize() above is the slow part (up to MAX_CHUNKS
    // sequential provider calls); re-checking ownership right before writing
    // shrinks "a superseded worker overwrites the reclaimer's summary" from
    // that whole window down to the gap between this check and the write —
    // not zero, but the closest this route gets without a real transaction
    // (see ADR-0006's honest limit on this).
    const renewed = await repo.claim(
      id, 'indexing', { status: 'indexing', errorMessage: null, failedStage: null }, fence,
    )
    if (!renewed) throw conflict('Lost ownership of this meeting\'s extraction before the summary could be saved')
    fence = renewed.updatedAt

    await summaries.replaceForMeeting(id, summary)

    // Claim-gated, not a plain update: a straggler from a stale-lease reclaim
    // (see claim() below) must not overwrite a meeting another caller already
    // finished. Only a write that lands while the row still shows `indexing`
    // — the state THIS invocation itself claimed, and has not been reclaimed
    // since — takes effect.
    const updated = await repo.claim(
      id, 'indexing', { status: 'ready', errorMessage: null, failedStage: null }, fence,
    )
    if (updated) return { meeting: updated, summary }

    // Lost the race between the renewal above and this write. Only return a
    // result this call can prove is authoritative — actually persisted, and
    // reflected in the meeting's own status — rather than guessing at one.
    const current = await repo.get(id)
    if (current?.status === 'ready') {
      const stored = await summaries.getForMeeting(id)
      if (stored) return { meeting: current, summary: stored }
    }
    throw conflict('Summarisation is already running for this meeting')
  }
  catch (err) {
    // An h3 error already says what it means; do not rewrite it.
    if (isError(err)) {
      await repo.claim(id, 'indexing', { status: 'summarizing', errorMessage: null, failedStage: null }, fence)
      throw err
    }

    const failure = err instanceof SummarizationError ? err : null
    const message = failure?.message ?? (err instanceof Error ? err.message : String(err))
    // Default to retryable. Parking a meeting whose transcript is intact on a
    // terminal status is the worse mistake.
    const retryable = failure ? failure.retryable : true
    // Claim-gated for the same reason as the success path: if another caller
    // already finished (or is itself retrying) while this one was failing,
    // this write must not regress what they did.
    await repo.claim(id, 'indexing', {
      status: retryable ? 'summarizing' : 'failed',
      errorMessage: message,
      failedStage: retryable ? null : 'summarization',
    }, fence)
    throw createError({
      statusCode: failure?.statusCode ?? 500,
      statusMessage: 'Summarisation failed',
      message,
    })
  }
})

/**
 * Take the meeting for extraction, if it is ours to take. Recovers a claim whose
 * holder is gone: `indexing` older than the lease is stale, since nothing
 * renews it.
 */
async function claim(
  repo: ReturnType<typeof useMeetingRepository>,
  meeting: Meeting,
): Promise<Meeting | null> {
  const patch = { status: 'indexing' as const, errorMessage: null, failedStage: null }
  if (meeting.status === 'summarizing') return repo.claim(meeting.id, 'summarizing', patch)

  // Only reached when the caller already confirmed no summary row exists
  // (see PAST_SUMMARY above) — a healthy `ready` meeting never gets here,
  // since that branch returns early. Nothing else can ever put a meeting
  // back in `ready`, so no concurrent worker can be legitimately mid-flight
  // against it; this is a repair, not a race to arbitrate.
  if (meeting.status === 'ready') return repo.claim(meeting.id, 'ready', patch)

  const staleSince = Date.now() - CLAIM_LEASE_MS
  if (meeting.status === 'indexing' && new Date(meeting.updatedAt).getTime() < staleSince) {
    return repo.claim(meeting.id, 'indexing', patch)
  }
  // `failed` is recoverable, but only a failure THIS route caused (a
  // summarisation failure leaves the transcript intact; retrying is exactly
  // what the status was recorded for), and not before a short cooldown — a
  // multi-chunk run failing partway should not be instantly re-hammered.
  const cooledDown = Date.now() - new Date(meeting.updatedAt).getTime() >= RETRY_COOLDOWN_MS
  if (meeting.status === 'failed' && meeting.failedStage === 'summarization' && cooledDown) {
    return repo.claim(meeting.id, 'failed', patch)
  }
  return null
}

/** An accurate reason claim() refused, instead of a generic one that reads as
 * "there is nothing to summarise" even when the real cause is a cooldown. */
function describeWhyNotClaimable(current: Meeting): string {
  if (current.status === 'indexing') return 'Summarisation is already running for this meeting'
  if (current.status === 'failed' && current.failedStage === 'summarization') {
    const remainingMs = RETRY_COOLDOWN_MS - (Date.now() - new Date(current.updatedAt).getTime())
    const remainingSec = Math.max(1, Math.ceil(remainingMs / 1000))
    return `The last extraction failed recently; wait ${remainingSec}s before retrying`
  }
  return `Meeting is ${current.status}; it has no transcript ready to summarise`
}
