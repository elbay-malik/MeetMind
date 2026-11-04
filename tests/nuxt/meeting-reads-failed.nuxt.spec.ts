import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { mockNuxtImport, mountSuspended, registerEndpoint } from '@nuxt/test-utils/runtime'
import MeetingPage from '~/pages/meetings/[id]/index.vue'

const ID = '7c9e6679-7425-40de-944b-e07fc1f90ae7'

mockNuxtImport('useRoute', () => () => ({ params: { id: ID }, query: {}, path: `/meetings/${ID}`, fullPath: `/meetings/${ID}` }))

const meeting = { id: ID, title: 'A meeting', status: 'ready', sourceFileName: 'a.mp4', sourceBytes: 1, sourceMime: 'video/mp4', audioBytes: 1, durationSec: 10, createdAt: '2026-11-01T00:00:00.000Z' }
const summary = { provider: 'groq', summary: 'We agreed.', decisions: [], actionItems: [] }
const up = { transcript: false, summary: false }
const failUnlessUp = (name: keyof typeof up, body: unknown) => (event: { node: { res: { statusCode: number } } }) => {
  if (up[name]) return body
  event.node.res.statusCode = 503
  return { error: true, statusMessage: 'Unavailable' }
}

registerEndpoint(`/api/meetings/${ID}`, () => ({ meeting }))
registerEndpoint(`/api/meetings/${ID}/transcript`, failUnlessUp('transcript', { segments: [{ idx: 0, startMs: 0, endMs: 1000, text: 'We agreed to ship on Friday.' }] }))
registerEndpoint(`/api/meetings/${ID}/summary`, failUnlessUp('summary', { summary }))
registerEndpoint(`/api/meetings/${ID}/search-index`, () => ({ index: { state: 'ready', windowCount: 1, indexedCount: 1, model: 'stub' } }))

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
})
