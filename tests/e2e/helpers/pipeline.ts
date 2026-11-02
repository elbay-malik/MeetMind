import { fetch } from '@nuxt/test-utils/e2e'
import type { PipelineResponse } from '../../../shared/types/meeting'

/**
 * Far more requests than the fixture takes, and few enough that a loop fails the spec
 * rather than the run: a step-by-step pipeline is only trustworthy if something proves it
 * stops. A `wait` is shortened here, and still counts as a request.
 */
export const STEP_BOUND = 200

/** One step, with its status, so a spec can look at a refusal. */
export const advance = (id: string) => fetch(`/api/meetings/${id}/advance`, { method: 'POST' })

/**
 * What ADR-0012 §1 says a driver does: on `continue` ask again at once, on `wait` sleep
 * until told to, on `done` or `failed` stop. Anything but a 200 rejects, like `$fetch` would.
 * `afterEach` sees every answer, as it comes. Returns every answer, in order.
 */
export async function driveToDone(id: string, afterEach?: (answer: PipelineResponse) => Promise<void> | void): Promise<PipelineResponse[]> {
  const answers: PipelineResponse[] = []
  for (let i = 0; i < STEP_BOUND; i++) {
    const res = await advance(id)
    const body = await res.json()
    if (res.status !== 200) throw Object.assign(new Error(JSON.stringify(body)), { statusCode: res.status, data: body })
    const answer = body as PipelineResponse
    answers.push(answer)
    await afterEach?.(answer)
    if (answer.next === 'done' || answer.next === 'failed') return answers
    if (answer.next === 'wait') await new Promise(resolve => setTimeout(resolve, Math.min(answer.retryAfterMs ?? 0, 6000) + 20))
  }
  throw new Error(`${id} did not finish in ${STEP_BOUND} steps: ${JSON.stringify(answers.slice(-3))}`)
}
