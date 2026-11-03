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

describe('the question form', () => {
  // Someone opening a shared link never sees the upload page's notice.
  it('says where a question goes, before it is sent', async () => {
    const wrapper = await mountSuspended(MeetingQuestions, { props: { meetingId: ID } })
    expect(wrapper.find('form').text()).toContain('Your question is sent to Cloudflare to search this meeting and to Groq to answer it.')
  })
})

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

describe('the question card when the index is not finished', () => {
  const pipelineWith = (state: string) => ({
    status: 'ready',
    progress: { stage: 'search_index', done: 0, total: null, etaSeconds: null },
    index: { state, done: 0, total: null, retryAt: null },
    next: 'done',
    retryAt: null,
    retryAfterMs: null,
  })
  const notFinished = (id: string, state: 'none' | 'incomplete', pipeline: string | null) => {
    registerEndpoint(`/api/meetings/${id}/search-index`, () => ({ index: { state, windowCount: 3, indexedCount: 1, model: 'stub' } }))
    registerEndpoint(`/api/meetings/${id}/pipeline`, (event: { node: { res: { statusCode: number } } }) => {
      if (pipeline) return pipelineWith(pipeline)
      event.node.res.statusCode = 500
      return { error: true, statusCode: 500 }
    })
    return mountSuspended(MeetingQuestions, { props: { meetingId: id } })
  }
  const button = (wrapper: Awaited<ReturnType<typeof notFinished>>) => wrapper.findAll('a').map(a => a.text()).join(' ')

  it.each<[string, string, RegExp, string]>([
    ['b1000000-0000-4000-8000-000000000001', 'building', /moves only while its pipeline page is open/, 'Finish the index on the pipeline page'],
    ['b1000000-0000-4000-8000-000000000002', 'parked', /stopped for now.*daily limit/, 'See when it can carry on'],
    ['b1000000-0000-4000-8000-000000000003', 'held', /another embedding model or an older transcript/, 'Rebuild it on the pipeline page'],
    ['b1000000-0000-4000-8000-000000000004', 'stopped', /will not be tried again by itself/, 'Try again on the pipeline page'],
  ])('%s: says why when the index is %s', async (id, state, words, action) => {
    const wrapper = await notFinished(id, 'incomplete', state)
    await flushPromises()
    expect(wrapper.text()).toMatch(words)
    expect(button(wrapper)).toContain(action)
    expect(wrapper.find('form').exists()).toBe(false)
  })

  it('says one that has not started happens by itself on the pipeline page', async () => {
    const wrapper = await notFinished('b1000000-0000-4000-8000-000000000005', 'none', 'building')
    await flushPromises()
    expect(wrapper.text()).toMatch(/happens by itself while its pipeline page is open/)
    expect(button(wrapper)).toContain('Index it on the pipeline page')
  })

  it('still says what it can when the reason cannot be read', async () => {
    const wrapper = await notFinished('b1000000-0000-4000-8000-000000000006', 'incomplete', null)
    await flushPromises()
    expect(wrapper.text()).toMatch(/index is not finished/)
    expect(button(wrapper)).toContain('Finish the index on the pipeline page')
  })

  it('sends nobody to a page that cannot help, on the public demo', async () => {
    const id = 'b1000000-0000-4000-8000-000000000007'
    useRuntimeConfig().public.demoMeetingId = id
    const wrapper = await notFinished(id, 'incomplete', 'held')
    await flushPromises()
    useRuntimeConfig().public.demoMeetingId = ''
    expect(wrapper.text()).toMatch(/demo meeting's index is not finished/)
    expect(wrapper.findAll('a').length).toBe(0)
  })

  it('reads nothing more for a finished index', async () => {
    const id = 'b1000000-0000-4000-8000-000000000008'
    let reads = 0
    registerEndpoint(`/api/meetings/${id}/search-index`, () => ({ index: { state: 'ready', windowCount: 3, indexedCount: 3, model: 'stub' } }))
    registerEndpoint(`/api/meetings/${id}/pipeline`, () => {
      reads++
      return pipelineWith('complete')
    })
    await mountSuspended(MeetingQuestions, { props: { meetingId: id } })
    await flushPromises()
    expect(reads).toBe(0)
  })
})
