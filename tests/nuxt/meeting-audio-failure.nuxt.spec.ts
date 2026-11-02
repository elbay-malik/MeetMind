import { describe, expect, it } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { mockNuxtImport, mountSuspended, registerEndpoint } from '@nuxt/test-utils/runtime'
import MeetingPage from '~/pages/meetings/[id]/index.vue'

const ID = '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d'
const LOST = 'The audio could not be loaded, so seeking is unavailable.'
const NOT_READY = 'The audio is not ready yet, so this line cannot be played.'

mockNuxtImport('useRoute', () => () => ({ params: { id: ID }, query: {}, path: `/meetings/${ID}`, fullPath: `/meetings/${ID}` }))

const meeting = {
  id: ID,
  title: 'A meeting',
  status: 'ready',
  sourceFileName: 'a.mp4',
  sourceBytes: 1,
  sourceMime: 'video/mp4',
  audioBytes: 1,
  durationSec: 10,
  createdAt: '2026-11-01T00:00:00.000Z',
}
const segment = { idx: 0, startMs: 0, endMs: 1000, text: 'We agreed to ship on Friday.' }

registerEndpoint(`/api/meetings/${ID}`, () => ({ meeting }))
registerEndpoint(`/api/meetings/${ID}/transcript`, () => ({ segments: [segment] }))
registerEndpoint(`/api/meetings/${ID}/summary`, () => ({ summary: null }))
registerEndpoint(`/api/meetings/${ID}/search-index`, () => ({ index: { state: 'ready', windowCount: 1, indexedCount: 1, model: 'stub' } }))

describe('a meeting whose audio cannot be loaded', () => {
  // On day 31 of the demo the object is gone, and it will never be "ready".
  it('keeps saying so when a line is selected, rather than that the audio is not ready yet', async () => {
    const page = await mountSuspended(MeetingPage)
    await page.find('audio').trigger('error')
    await page.find('[data-idx="0"]').trigger('click')
    await flushPromises()
    const said = page.findAll('[role="alert"]').map(a => a.text()).join(' ')
    expect(said).toContain(LOST)
    expect(said).not.toContain(NOT_READY)
  })

  it('still says the audio is not ready when it simply has not loaded yet', async () => {
    const page = await mountSuspended(MeetingPage)
    await page.find('[data-idx="0"]').trigger('click')
    await flushPromises()
    expect(page.findAll('[role="alert"]').map(a => a.text()).join(' ')).toContain(NOT_READY)
  })
})
