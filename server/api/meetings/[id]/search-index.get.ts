import type { SearchIndexStatus } from '#shared/types/meeting'
import { transcriptionFinished } from '#shared/utils/meeting'
import { useMeetingRepository, useTranscriptIndexRepository, useTranscriptRepository } from '../../../utils/db'
import { notFound, requireMeetingId } from '../../../utils/http'
import { useEmbedder } from '../../../utils/qa'
import { readyWindowCount } from '../../../utils/db/windows'
import { indexStatus } from '../../../utils/qa/indexing'
import { planWindows } from '../../../utils/qa/windows'

/**
 * Whether this meeting can be asked questions yet. `ready` is the marker's to say, and
 * the marker is held against a hash of the current transcript, so a replaced one shows
 * up as not ready immediately, without anything having to remember to mark it.
 *
 * A finished index answers from the marker alone. Any other state plans the whole
 * transcript to say how far it has got, which is the one read here that grows with the
 * meeting: only for a meeting that is not ready, and only when a page asks.
 */
export default defineEventHandler(async (event): Promise<{ index: SearchIndexStatus }> => {
  const id = requireMeetingId(event)
  const meeting = await useMeetingRepository(event).get(id)
  if (!meeting) throw notFound('Meeting not found')

  const { model } = useEmbedder(event)
  if (!transcriptionFinished(meeting)) {
    return { index: { state: 'unavailable', windowCount: 0, indexedCount: 0, model } }
  }

  const repo = useTranscriptIndexRepository(event)
  const windowCount = readyWindowCount(await repo.readState(id, model), model)
  if (windowCount !== null) return { index: { state: 'ready', windowCount, indexedCount: windowCount, model } }

  const segments = await useTranscriptRepository(event).listForMeeting(id)
  const status = indexStatus(await planWindows(segments), await repo.listKeys(id), model)
  // Every window stored, and no finished run to say so: a meeting indexed before the
  // marker existed, or a run stopped just short of its last step. A question would be
  // refused, so this does not say ready, and indexing it again spends nothing.
  return { index: status.state === 'ready' ? { ...status, state: 'incomplete' } : status }
})
