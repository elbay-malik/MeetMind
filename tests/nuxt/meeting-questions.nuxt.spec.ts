import { describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { mountSuspended, registerEndpoint } from '@nuxt/test-utils/runtime'
import MeetingQuestions from '~/components/MeetingQuestions.vue'

const ID = '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d'

registerEndpoint(`/api/meetings/${ID}/search-index`, () => ({
  index: { state: 'ready', windowCount: 3, indexedCount: 3, model: 'stub' },
}))

/** What the route answers: tests/e2e/embedding-quota.spec.ts holds it to this shape. */
let refusal: { statusCode: number, message: string, data?: { retryAt: string, retryAfterSec: number } }
registerEndpoint(`/api/meetings/${ID}/ask`, {
  method: 'POST',
  handler: (event: { node: { res: { statusCode: number } } }) => {
    event.node.res.statusCode = refusal.statusCode
    return { error: true, statusMessage: 'Answering failed', ...refusal }
  },
})

async function askWith(reply: typeof refusal) {
  refusal = reply
  const wrapper = await mountSuspended(MeetingQuestions, { props: { meetingId: ID } })
  await wrapper.find('input').setValue('What did we decide?')
  await wrapper.find('form').trigger('submit')
  await vi.waitFor(() => expect(wrapper.find('[role="alert"]').exists()).toBe(true))
  await flushPromises()
  return wrapper
}

describe('the question form at the provider\'s daily limit', () => {
  const MESSAGE = 'The free daily limit for indexing and questions has been reached. It resets at 00:00 UTC.'

  const LIMIT = { statusCode: 429, message: MESSAGE, data: { retryAt: '2026-11-03T00:00:00.000Z', retryAfterSec: 3_600 } }

  it('says so in plain words, and when, in an alert', async () => {
    const wrapper = await askWith(LIMIT)
    const alert = wrapper.find('[role="alert"]')
    expect(alert.exists()).toBe(true)
    expect(alert.text()).toContain(MESSAGE)
    expect(alert.text()).toMatch(/Try again at/)
  })

  it('holds the button rather than inviting a repeat of a refusal it knows will come', async () => {
    const wrapper = await askWith(LIMIT)
    expect(wrapper.find('button[type="submit"]').attributes('disabled')).toBeDefined()
    expect(wrapper.text()).toMatch(/Questions can be asked again at/)
  })

  it('stays usable after a refusal that names no time', async () => {
    const wrapper = await askWith({ statusCode: 503, message: 'The embedding service is out of capacity for the moment. Try again shortly.' })
    expect(wrapper.find('[role="alert"]').text()).toContain('out of capacity')
    expect(wrapper.find('button[type="submit"]').attributes('disabled')).toBeUndefined()
    expect(wrapper.text()).not.toMatch(/Questions can be asked again at/)
  })
})

describe('the question card when the index status cannot be read', () => {
  const BROKEN = '1b4e28ba-2fa1-4d3b-a3f5-ef19b5a7633b'
  registerEndpoint(`/api/meetings/${BROKEN}/search-index`, (event: { node: { res: { statusCode: number } } }) => {
    event.node.res.statusCode = 500
    return { error: true, statusCode: 500, statusMessage: 'Server Error' }
  })

  it('says that, rather than blaming a transcript that may be finished', async () => {
    const wrapper = await mountSuspended(MeetingQuestions, { props: { meetingId: BROKEN } })
    await flushPromises()
    expect(wrapper.text()).toContain('Could not check whether this meeting can be asked questions')
    expect(wrapper.text()).not.toContain('once the transcript is ready')
  })
})
