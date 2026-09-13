import { isError } from 'h3'
import type { Meeting, TranscriptSegment } from '#shared/types/meeting'
import { AUDIO_MIME, MAX_AUDIO_BYTES } from '#shared/utils/meeting'
import { useAudioStore } from '../../../utils/storage'
import { useMeetingRepository, useTranscriptRepository } from '../../../utils/db'
import { conflict, notFound, requireMeetingId } from '../../../utils/http'
import { useTranscriber } from '../../../utils/transcription'
import { TranscriptionError } from '../../../utils/transcription/transcriber'

/**
 * How long a claim is honoured before another caller may take it over. A crash,
 * a deploy or a Workers eviction between claiming and finishing would otherwise
 * leave the meeting in `transcribing` with nothing running and no way back.
 */
const CLAIM_LEASE_MS = 15 * 60_000

/**
 * How long a failure must sit before it can be retried. Matches
 * summarize.post.ts's reasoning: an instant retry after a failure re-hammers
 * whatever just failed (the provider, or storage) immediately again. Same
 * fixed-ceiling caveat as there: a real Groq 429 can ask for longer than this
 * via `Retry-After`, which this route does not currently carry across
 * requests to honour exactly.
 */
const RETRY_COOLDOWN_MS = 60_000

/** Statuses that mean transcription has already happened. */
const PAST_TRANSCRIPTION = ['summarizing', 'indexing', 'ready']

/**
 * Transcribe a meeting's stored audio and persist the segments.
 *
 * Phase 4 has no orchestrator — that is Phase 9 — so this is invoked directly.
 * It is safe to call twice: an already-transcribed meeting returns what it has,
 * and the claim keeps concurrent callers from both spending the provider's quota.
 */
export default defineEventHandler(async (event): Promise<{
  meeting: Meeting
  segments: TranscriptSegment[]
}> => {
  const id = requireMeetingId(event)
  const repo = useMeetingRepository(event)
  const transcripts = useTranscriptRepository(event)

  const meeting = await repo.get(id)
  if (!meeting) throw notFound('Meeting not found')
  if (PAST_TRANSCRIPTION.includes(meeting.status)) {
    return { meeting, segments: await transcripts.listForMeeting(id) }
  }

  const claimed = await claim(repo, meeting)
  if (!claimed) {
    // Lost the race, or the meeting moved on. Re-read rather than guess which.
    const current = await repo.get(id)
    if (!current) throw notFound('Meeting not found')
    if (PAST_TRANSCRIPTION.includes(current.status)) {
      return { meeting: current, segments: await transcripts.listForMeeting(id) }
    }
    throw conflict(describeWhyNotClaimable(current))
  }

  // Fences the writes below against a later stale-lease reclaim of THIS same
  // meeting, the same way summarize.post.ts fences its own final writes: a
  // reclaim writes `transcribing` again, changing `updatedAt` without
  // changing `status`, which a `from`-only compare-and-swap cannot see.
  let fence = claimed.updatedAt

  try {
    const audio = await useAudioStore(event).get(meeting.audioKey, MAX_AUDIO_BYTES)
    if (!audio) {
      throw new TranscriptionError('The meeting audio is missing from storage', 409, false)
    }
    if (audio.size !== meeting.audioBytes) {
      // The object changed after we verified it at upload.
      throw new TranscriptionError(
        `Stored audio is ${audio.size} bytes, expected ${meeting.audioBytes}`, 409, false,
      )
    }

    const result = await useTranscriber(event).transcribe({
      bytes: audio.bytes,
      contentType: audio.contentType ?? AUDIO_MIME,
    })

    // Renew the fence immediately before the one write in this route that is
    // NOT itself claim-gated: replaceForMeeting has no compare-and-swap of its
    // own. transcribe() above is the slow part; re-checking ownership right
    // before writing shrinks "a superseded worker overwrites the reclaimer's
    // transcript" down to the gap between this check and the write (see
    // ADR-0006's honest limit on this — the same one summarize.post.ts has).
    const renewed = await repo.claim(
      id, 'transcribing', { status: 'transcribing', errorMessage: null, failedStage: null }, fence,
    )
    if (!renewed) throw conflict('Lost ownership of this meeting\'s transcription before it could be saved')
    fence = renewed.updatedAt

    await transcripts.replaceForMeeting(id, result.segments)

    // Claim-gated, not a plain update: a straggler from a stale-lease reclaim
    // must not overwrite a meeting another caller already finished or is
    // itself now retrying.
    const updated = await repo.claim(
      id, 'transcribing', { status: 'summarizing', errorMessage: null, failedStage: null }, fence,
    )
    if (updated) return { meeting: updated, segments: result.segments }

    // Lost the race between the renewal above and this write. The transcript
    // this call wrote is real either way, but the meeting's status is not
    // ours to report — read back whatever is authoritative instead of
    // guessing at one.
    const current = await repo.get(id)
    if (!current) throw notFound('Meeting not found')
    return { meeting: current, segments: result.segments }
  }
  catch (err) {
    // An h3 error already says what it means; do not rewrite it as a 500 or
    // record it as a transcription failure. h3 marks these with a static on the
    // class, so its own predicate is the only correct test.
    if (isError(err)) {
      await repo.claim(id, 'transcribing', { status: 'uploaded', errorMessage: null, failedStage: null }, fence)
      throw err
    }

    const transcription = err instanceof TranscriptionError ? err : null
    const message = transcription?.message ?? (err instanceof Error ? err.message : String(err))
    // Default to retryable. A storage or database blip is transient, and the
    // worse mistake is parking a perfectly good meeting on `failed`, which
    // nothing can move again.
    const retryable = transcription ? transcription.retryable : true
    // A quota exhaustion (429) is retryable, but resetting straight to
    // `uploaded` — the friendly reset a transient blip gets — has no cooldown
    // gate at all, since `uploaded` is immediately reclaimable. That would let
    // a client hammer the very quota that just refused it. Route it through
    // `failed` instead, same as a non-retryable failure, purely to get the
    // cooldown; failedStage still says which stage it was so retrying goes
    // through the right route once the cooldown clears.
    const quotaExceeded = transcription?.statusCode === 429
    await repo.claim(id, 'transcribing', {
      status: (retryable && !quotaExceeded) ? 'uploaded' : 'failed',
      errorMessage: message,
      failedStage: (retryable && !quotaExceeded) ? null : 'transcription',
    }, fence)
    throw createError({
      statusCode: transcription?.statusCode ?? 500,
      statusMessage: 'Transcription failed',
      message,
    })
  }
})

/**
 * Take the meeting for transcription, if it is ours to take. Also recovers a
 * claim whose holder is gone: `transcribing` older than the lease is stale,
 * since nothing renews it.
 */
async function claim(
  repo: ReturnType<typeof useMeetingRepository>,
  meeting: Meeting,
): Promise<Meeting | null> {
  // Also clears failedStage: the field means null outside `failed`, and this
  // patch is what takes a meeting out of `failed` on every branch below.
  // Leaving the old stage in place here would show a stale reason for a
  // meeting that is once again actively retrying.
  const patch = { status: 'transcribing' as const, errorMessage: null, failedStage: null }
  if (meeting.status === 'uploaded') return repo.claim(meeting.id, 'uploaded', patch)

  const staleSince = Date.now() - CLAIM_LEASE_MS
  if (meeting.status === 'transcribing' && new Date(meeting.updatedAt).getTime() < staleSince) {
    return repo.claim(meeting.id, 'transcribing', patch)
  }
  // `failed` is recoverable, but only when THIS route caused it: the audio is
  // still there, and asking again is exactly the retry it was recorded for. A
  // failure from summarize.post.ts leaves a valid transcript behind — routing
  // its retry through here would re-run transcription and overwrite it. Also
  // only after a cooldown — an instant retry would re-hammer the same storage
  // or provider call that just failed.
  const cooledDown = Date.now() - new Date(meeting.updatedAt).getTime() >= RETRY_COOLDOWN_MS
  if (meeting.status === 'failed' && meeting.failedStage === 'transcription' && cooledDown) {
    return repo.claim(meeting.id, 'failed', patch)
  }
  return null
}

/** An accurate reason claim() refused, instead of a generic one that reads as
 * "there is no audio" even when the real cause is a cooldown. */
function describeWhyNotClaimable(current: Meeting): string {
  if (current.status === 'transcribing') return 'Transcription is already running for this meeting'
  if (current.status === 'failed' && current.failedStage === 'transcription') {
    const remainingMs = RETRY_COOLDOWN_MS - (Date.now() - new Date(current.updatedAt).getTime())
    const remainingSec = Math.max(1, Math.ceil(remainingMs / 1000))
    return `The last transcription attempt failed recently; wait ${remainingSec}s before retrying`
  }
  return `Meeting is ${current.status}; it has no audio ready to transcribe`
}
