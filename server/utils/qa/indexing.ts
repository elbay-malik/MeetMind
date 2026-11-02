import type { SearchIndexStatus } from '#shared/types/meeting'
import type { StoredWindowKey } from '../db/windows'
import type { TranscriptWindow } from './windows'

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
 * How far a meeting's index has got, from the whole plan and what is stored. For a page
 * showing "8 of 12": whether questions can be asked is the marker's to say, not this
 * (`readyWindowCount`), so a meeting indexed before the marker existed reads `ready` here
 * and is told otherwise by the status route.
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
