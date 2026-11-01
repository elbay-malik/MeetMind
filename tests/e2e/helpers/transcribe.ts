import { fetch } from '@nuxt/test-utils/e2e'
import type { Meeting, TranscriptionStepResponse } from '../../../shared/types/meeting'

/**
 * Drive transcription to the end, as the progress page does: one step per
 * request, waiting (shortened here) when told to. A refusal or failure rejects
 * with its status code and body, like `$fetch` would.
 */
export async function driveTranscription(id: string): Promise<{ meeting: Meeting }> {
  for (let i = 0; i < 50; i++) {
    const res = await fetch(`/api/meetings/${id}/transcribe`, { method: 'POST' })
    const body = await res.json()
    if (res.status === 200) return body as { meeting: Meeting }
    if (res.status !== 202) throw Object.assign(new Error(JSON.stringify(body)), { statusCode: res.status, data: body })
    const step = body as TranscriptionStepResponse
    if (step.next === 'wait') await new Promise(resolve => setTimeout(resolve, Math.min(step.retryAfterMs ?? 0, 6000) + 20))
  }
  throw new Error(`transcription of ${id} did not finish in 50 steps`)
}
