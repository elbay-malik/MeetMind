import { isError } from 'h3'
import type { Meeting, MeetingSummary } from '#shared/types/meeting'
import { useMeetingRepository, useSummaryRepository, useTranscriptRepository } from '../../../utils/db'
import { conflict, notFound, requireMeetingId } from '../../../utils/http'
import { useSummarizer } from '../../../utils/summary'
import { SummarizationError } from '../../../utils/summary/summarizer'

/** How long a claim is honoured before another caller may take it over. */
const CLAIM_LEASE_MS = 15 * 60_000

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

  try {
    const summary = await useSummarizer(event).summarize({ segments })
    await summaries.replaceForMeeting(id, summary)

    const updated = await repo.update(id, { status: 'ready', errorMessage: null })
    return { meeting: updated ?? { ...claimed, status: 'ready' }, summary }
  }
  catch (err) {
    // An h3 error already says what it means; do not rewrite it.
    if (isError(err)) {
      await repo.update(id, { status: 'summarizing', errorMessage: null })
      throw err
    }

    const failure = err instanceof SummarizationError ? err : null
    const message = failure?.message ?? (err instanceof Error ? err.message : String(err))
    // Default to retryable. Parking a meeting whose transcript is intact on a
    // terminal status is the worse mistake.
    const retryable = failure ? failure.retryable : true
    await repo.update(id, {
      status: retryable ? 'summarizing' : 'failed',
      errorMessage: message,
    })
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
  const patch = { status: 'indexing' as const, errorMessage: null }
  if (meeting.status === 'summarizing') return repo.claim(meeting.id, 'summarizing', patch)

  const staleSince = Date.now() - CLAIM_LEASE_MS
  if (meeting.status === 'indexing' && new Date(meeting.updatedAt).getTime() < staleSince) {
    return repo.claim(meeting.id, 'indexing', patch)
  }
  // `failed` is recoverable: the transcript is still there and asking again is
  // exactly the retry the status was recorded for.
  if (meeting.status === 'failed') return repo.claim(meeting.id, 'failed', patch)
  return null
}
