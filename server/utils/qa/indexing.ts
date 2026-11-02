import type { SearchIndexStatus, TranscriptSegment } from '#shared/types/meeting'
import type { StoredWindowKey, TranscriptIndexRepository } from '../db/windows'
import { planEmbeddingBatches, type Embedder } from './embedder'
import { planWindows, type TranscriptWindow } from './windows'

/** Stored windows that exactly match what the current transcript plans, for this model. */
function currentIndexes(plan: TranscriptWindow[], keys: StoredWindowKey[], model: string): Set<number> {
  const stored = new Map(keys.map(k => [k.idx, k]))
  const current = new Set<number>()
  for (const window of plan) {
    const key = stored.get(window.idx)
    if (key && key.contentHash === window.contentHash && key.model === model) current.add(window.idx)
  }
  return current
}

/**
 * Where a meeting's index stands, from the plan and what is stored. Pure, so
 * the route and its tests share one definition of "ready".
 */
export function indexStatus(
  plan: TranscriptWindow[],
  keys: StoredWindowKey[],
  model: string,
): SearchIndexStatus {
  const indexedCount = currentIndexes(plan, keys, model).size
  const windowCount = plan.length
  // Stored windows the plan no longer contains (a shorter replacement
  // transcript) or from another model also make the index not-ready: search
  // would still see them until indexing removes them.
  const planned = new Set(plan.map(w => w.idx))
  const leftovers = keys.some(k => !planned.has(k.idx) || k.model !== model)
  const state = indexedCount === windowCount && !leftovers
    ? 'ready'
    : indexedCount === 0 && !keys.some(k => k.model === model) ? 'none' : 'incomplete'
  return { state, windowCount, indexedCount, model }
}

export interface IndexMeetingInput {
  meetingId: string
  segments: TranscriptSegment[]
  embedder: Embedder
  repo: TranscriptIndexRepository
}

/**
 * Bring a meeting's index in line with its current transcript, spending as
 * little of the embedding quota as possible (ADR-0007 decision 5).
 *
 * 1. Plan windows from the transcript.
 * 2. Remove stored windows the plan does not contain. They can never be
 *    current, and leaving them in place would let search return them.
 * 3. Embed only the windows not already stored with the same hash and model.
 * 4. Store each batch as soon as it is embedded, so a run the quota stops
 *    partway keeps everything it already paid for, and the next run resumes
 *    from there instead of starting over.
 *
 * Throws the embedder's error unchanged when a batch fails; whatever was
 * stored before that point stays stored.
 */
export async function indexMeeting(input: IndexMeetingInput): Promise<SearchIndexStatus> {
  const { meetingId, segments, embedder, repo } = input
  const plan = await planWindows(segments)
  const keys = await repo.listKeys(meetingId)

  const planned = plan.map(w => w.idx)
  const stale = keys.filter(k => !planned.includes(k.idx) || k.model !== embedder.model)
  if (stale.length > 0) {
    // Keep only windows that exist in the plan AND belong to this model; a
    // window from another model at a planned index is re-embedded below.
    const keep = keys.filter(k => planned.includes(k.idx) && k.model === embedder.model).map(k => k.idx)
    await repo.deleteExcept(meetingId, keep)
  }

  const current = currentIndexes(plan, keys, embedder.model)
  const pending = plan.filter(w => !current.has(w.idx))

  for (const batch of planEmbeddingBatches(pending, w => w.text)) {
    const vectors = await embedder.embedDocuments(batch.map(w => w.text))
    await repo.upsertWindows(meetingId, batch.map((window, k) => ({
      ...window,
      model: embedder.model,
      embedding: vectors[k]!,
    })))
  }

  return indexStatus(plan, await repo.listKeys(meetingId), embedder.model)
}
