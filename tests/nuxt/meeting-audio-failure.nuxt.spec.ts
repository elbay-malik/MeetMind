import { afterEach, describe, expect, it, vi } from 'vitest'
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

  describe('once the element has really failed', () => {
    afterEach(() => vi.useRealTimers())

    async function failedPage() {
      const page = await mountSuspended(MeetingPage)
      const audio = page.find('audio').element as HTMLAudioElement
      Object.defineProperty(audio, 'error', { configurable: true, value: { code: 2 } })
      const load = vi.spyOn(audio, 'load').mockImplementation(() => {})
      const play = vi.spyOn(audio, 'play').mockResolvedValue()
      return { page, audio, load, play }
    }

    // A range the rate rule blocked leaves it failed after the block has ended.
    it('loads it again when a line is selected, then goes to that line and plays', async () => {
      const { page, audio, load, play } = await failedPage()
      await page.find('audio').trigger('error')
      await page.find('[data-idx="0"]').trigger('click')
      expect(load).toHaveBeenCalledOnce()
      expect(play).not.toHaveBeenCalled()
      Object.defineProperty(audio, 'error', { configurable: true, value: null })
      await page.find('audio').trigger('loadedmetadata')
      await flushPromises()
      expect(play).toHaveBeenCalledOnce()
      expect(page.findAll('[role="alert"]').map(a => a.text()).join(' ')).not.toContain(LOST)
    })

    it('tries once by itself after the block, keeps its place and does not start playing', async () => {
      vi.useFakeTimers()
      const { page, audio, load, play } = await failedPage()
      Object.defineProperty(audio, 'currentTime', { configurable: true, writable: true, value: 42 })
      await page.find('audio').trigger('error')
      vi.advanceTimersByTime(10_999)
      expect(load).not.toHaveBeenCalled()
      vi.advanceTimersByTime(1)
      expect(load).toHaveBeenCalledOnce()
      audio.currentTime = 0
      await page.find('audio').trigger('loadedmetadata')
      expect(audio.currentTime).toBe(42)
      expect(play).not.toHaveBeenCalled()
    })

    it('stops trying by itself after two, though the head of the file keeps loading, and shows it failed', async () => {
      vi.useFakeTimers()
      const { page, load } = await failedPage()
      for (let round = 0; round < 5; round++) {
        await page.find('audio').trigger('error')
        vi.advanceTimersByTime(11_000)
        await page.find('audio').trigger('loadedmetadata')
        await page.find('audio').trigger('canplay')
      }
      await page.find('audio').trigger('error')
      vi.advanceTimersByTime(60_000)
      expect(load).toHaveBeenCalledTimes(2)
      expect(page.findAll('[role="alert"]').map(a => a.text()).join(' ')).toContain(LOST)
    })

    it('tries by itself again once audio has really played', async () => {
      vi.useFakeTimers()
      const { page, load } = await failedPage()
      for (let round = 0; round < 2; round++) {
        await page.find('audio').trigger('error')
        vi.advanceTimersByTime(11_000)
      }
      await page.find('audio').trigger('playing')
      await page.find('audio').trigger('error')
      vi.advanceTimersByTime(11_000)
      expect(load).toHaveBeenCalledTimes(3)
    })

    it('still tries by itself when a click\'s own load fails during the block, and keeps the click\'s line and its wish to play', async () => {
      vi.useFakeTimers()
      const { page, audio, load, play } = await failedPage()
      Object.defineProperty(audio, 'currentTime', { configurable: true, writable: true, value: 0 })
      await page.find('audio').trigger('error')
      await page.find('[data-idx="0"]').trigger('click')
      expect(load).toHaveBeenCalledOnce()
      await page.find('audio').trigger('error')
      vi.advanceTimersByTime(11_000)
      expect(load).toHaveBeenCalledTimes(2)
      await page.find('audio').trigger('loadedmetadata')
      expect(play).toHaveBeenCalledOnce()
    })

    it('resumes playing after the block when the failed seek had asked to play', async () => {
      vi.useFakeTimers()
      const { page, audio, play } = await failedPage()
      Object.defineProperty(audio, 'currentTime', { configurable: true, writable: true, value: 900 })
      Object.defineProperty(audio, 'paused', { configurable: true, value: false })
      await page.find('audio').trigger('error')
      vi.advanceTimersByTime(11_000)
      await page.find('audio').trigger('loadedmetadata')
      expect(audio.currentTime).toBe(900)
      expect(play).toHaveBeenCalledOnce()
    })

    it('keeps the highlight where it was while the element is back at 0 loading', async () => {
      vi.useFakeTimers()
      const { page, audio } = await failedPage()
      Object.defineProperty(audio, 'currentTime', { configurable: true, writable: true, value: 900 })
      await page.find('audio').trigger('error')
      vi.advanceTimersByTime(11_000)
      audio.currentTime = 0
      await page.find('audio').trigger('timeupdate')
      await page.find('audio').trigger('error')
      vi.advanceTimersByTime(11_000)
      await page.find('audio').trigger('loadedmetadata')
      expect(audio.currentTime).toBe(900)
    })
  })
})
