import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { mockNuxtImport, mountSuspended, registerEndpoint } from '@nuxt/test-utils/runtime'
import MeetingPage from '~/pages/meetings/[id]/index.vue'
import ProgressPage from '~/pages/meetings/[id]/progress.vue'
import MeetingQuestions from '~/components/MeetingQuestions.vue'
import { useReadAgain } from '~/composables/useReadAgain'

const ID = '7c9e6679-7425-40de-944b-e07fc1f90ae7'

mockNuxtImport('useRoute', () => () => ({ params: { id: ID }, query: {}, path: `/meetings/${ID}`, fullPath: `/meetings/${ID}` }))

const meeting = { id: ID, title: 'A meeting', status: 'ready', sourceFileName: 'a.mp4', sourceBytes: 1, sourceMime: 'video/mp4', audioBytes: 1, durationSec: 10, createdAt: '2026-11-01T00:00:00.000Z' }
const summary = { provider: 'groq', summary: 'We agreed.', decisions: [], actionItems: [] }
const up = { transcript: false, summary: false, index: true }
const failUnlessUp = (name: keyof typeof up, body: unknown) => (event: { node: { res: { statusCode: number } } }) => {
  if (up[name]) return body
  event.node.res.statusCode = 503
  return { error: true, statusMessage: 'Unavailable' }
}

registerEndpoint(`/api/meetings/${ID}`, () => ({ meeting }))
registerEndpoint(`/api/meetings/${ID}/transcript`, failUnlessUp('transcript', { segments: [{ idx: 0, startMs: 0, endMs: 1000, text: 'We agreed to ship on Friday.' }] }))
registerEndpoint(`/api/meetings/${ID}/summary`, failUnlessUp('summary', { summary }))
registerEndpoint(`/api/meetings/${ID}/search-index`, failUnlessUp('index', { index: { state: 'ready', windowCount: 1, indexedCount: 1, model: 'stub' } }))
registerEndpoint(`/api/meetings/${ID}/pipeline`, () => ({
  status: 'ready',
  progress: { stage: 'search_index', done: 1, total: 1, etaSeconds: null },
  index: { state: 'complete', done: 1, total: 1, retryAt: null },
  next: 'done',
  retryAt: null,
  retryAfterMs: null,
}))

const button = (page: Awaited<ReturnType<typeof mountSuspended>>, alert: string) =>
  page.findAll('[role="alert"]').find((a: { text: () => string }) => a.text().includes(alert))!.find('button')

describe('a finished meeting whose reads failed', () => {
  beforeEach(() => clearNuxtData())

  it('says the transcript could not be loaded, and never that nobody spoke, until a retry brings it back', async () => {
    up.transcript = false
    up.summary = true
    const page = await mountSuspended(MeetingPage)
    expect(page.text()).toContain('The transcript could not be loaded')
    expect(page.text()).not.toContain('No speech was found')
    expect(page.text()).not.toContain('0 transcript segments')
    up.transcript = true
    await button(page, 'The transcript could not be loaded').trigger('click')
    await vi.waitFor(() => expect(page.text()).toContain('We agreed to ship on Friday.'))
    await flushPromises()
    expect(page.text()).not.toContain('The transcript could not be loaded')
    expect(page.text()).toContain('1 transcript segments')
    page.unmount()
  })

  it('says the summary could not be loaded, rather than leaving its card out, until a retry brings it back', async () => {
    up.transcript = true
    up.summary = false
    const page = await mountSuspended(MeetingPage)
    expect(page.text()).toContain('The summary could not be loaded')
    up.summary = true
    await button(page, 'The summary could not be loaded').trigger('click')
    await vi.waitFor(() => expect(page.text()).toContain('We agreed.'))
    await flushPromises()
    expect(page.text()).not.toContain('The summary could not be loaded')
    page.unmount()
  })

  describe('with time passing', () => {
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    })
    afterEach(() => vi.useRealTimers())

    it('reads a failed transcript and summary again by itself once the block has passed', async () => {
      up.transcript = false
      up.summary = false
      const page = await mountSuspended(MeetingPage)
      expect(page.text()).toContain('The transcript could not be loaded')
      up.transcript = true
      up.summary = true
      await vi.advanceTimersByTimeAsync(11_000)
      vi.useRealTimers()
      await vi.waitFor(() => expect(page.text()).toContain('We agreed to ship on Friday.'))
      await vi.waitFor(() => expect(page.text()).toContain('We agreed.'))
      expect(page.text()).not.toContain('could not be loaded')
      page.unmount()
    })

    it('gives up after three when it stays down, and starts over once a read has worked', async () => {
      const failed = ref(true)
      const read = vi.fn(async () => {})
      const page = await mountSuspended(defineComponent({
        setup() {
          useReadAgain(() => failed.value, read)
          return () => h('div')
        },
      }))
      await vi.advanceTimersByTimeAsync(10_999)
      expect(read).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(100_000)
      expect(read).toHaveBeenCalledTimes(3)
      failed.value = false
      await nextTick()
      failed.value = true
      await nextTick()
      await vi.advanceTimersByTimeAsync(11_000)
      expect(read).toHaveBeenCalledTimes(4)
      page.unmount()
      await vi.advanceTimersByTimeAsync(100_000)
      expect(read).toHaveBeenCalledTimes(4)
    })

    it('brings the question form back by itself, where it asked for a reload', async () => {
      up.index = false
      const card = await mountSuspended(MeetingQuestions, { props: { meetingId: ID } })
      expect(card.text()).toContain('Could not check whether this meeting can be asked questions.')
      expect(card.text()).not.toContain('Reload')
      up.index = true
      await vi.advanceTimersByTimeAsync(11_000)
      vi.useRealTimers()
      await vi.waitFor(() => expect(card.find('form').exists()).toBe(true))
      card.unmount()
    })

    it('says so on the Pipeline page too, and reads it again there, though a finished status never moves', async () => {
      up.transcript = false
      up.index = true
      const page = await mountSuspended(ProgressPage)
      expect(page.text()).toContain('The transcript could not be loaded')
      up.transcript = true
      await vi.advanceTimersByTimeAsync(11_000)
      vi.useRealTimers()
      await vi.waitFor(() => expect(page.text()).toContain('We agreed to ship on Friday.'))
      expect(page.text()).not.toContain('The transcript could not be loaded')
      page.unmount()
    })
  })
})
