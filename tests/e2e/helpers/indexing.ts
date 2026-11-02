import { fetch } from '@nuxt/test-utils/e2e'
import type { IndexingStepResponse, SearchIndexStatus } from '../../../shared/types/meeting'

const post = (id: string) => fetch(`/api/meetings/${id}/search-index`, { method: 'POST' })

/**
 * One step per request until the run is finished or says why it cannot go on, as the
 * progress page does, waiting (shortened here) when told to. Returns the last response,
 * unread, so a spec can look at a refusal's headers and body.
 */
export async function indexUntilStopped(id: string): Promise<Response> {
  for (let i = 0; i < 200; i++) {
    const res = await post(id)
    if (res.status !== 202) return res
    const step = await res.json() as IndexingStepResponse
    if (step.next === 'wait') await new Promise(resolve => setTimeout(resolve, Math.min(step.retryAfterMs ?? 0, 6000) + 20))
  }
  throw new Error(`indexing of ${id} did not finish in 200 steps`)
}

/** Drive indexing to the end. A refusal or failure rejects with its status code and body, like `$fetch` would. */
export async function driveIndexing(id: string): Promise<{ index: SearchIndexStatus }> {
  const res = await indexUntilStopped(id)
  const body = await res.json()
  if (res.status === 200) return body as { index: SearchIndexStatus }
  throw Object.assign(new Error(JSON.stringify(body)), { statusCode: res.status, data: body })
}
