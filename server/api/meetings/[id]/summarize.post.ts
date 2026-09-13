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
 */
const RETRY_COOLDOWN_MS = 30_000

/**
 * A transcript needing more sequential requests than this is rejected before
 * any of them are sent. Nothing bounds chunk count otherwise: a meeting long
 * enough to need dozens of requests would tie up a request handler for
 * minutes and spend the provider's quota on a single caller.
 */
const MAX_CHUNKS = 40

/** Statuses that mean extraction has already happened. */
const PAST_SUMMARY = ['indexing', 'ready']

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
    throw conflict(current.status === 'indexing'
      ? 'Summarisation is already running for this meeting'
      : `Meeting is ${current.status}; it has no transcript ready to summarise`)
  }

  // Fences every write below against a later stale-lease reclaim of THIS same
  // meeting: reclaiming `indexing` writes `indexing` again, which changes
  // `updatedAt` without changing `status`. A plain `from`-only compare-and-swap
  // cannot tell "still mine" from "reclaimed out from under me" in that case;
  // requiring `updatedAt` to still match the value observed right here can.
  const fence = claimed.updatedAt

  try {
    const summary = await useSummarizer(event).summarize({ segments })
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

    // Lost the race: someone else's write landed first (or reclaimed the
    // meeting since). Their result, not ours, is authoritative — the summary
    // this call computed is discarded rather than persisted over theirs.
    const current = await repo.get(id)
    const stored = current ? await summaries.getForMeeting(id) : null
    if (current && stored) return { meeting: current, summary: stored }
    return { meeting: { ...claimed, status: 'ready', failedStage: null }, summary }
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
