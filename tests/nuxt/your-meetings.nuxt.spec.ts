import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { mountSuspended, registerEndpoint } from '@nuxt/test-utils/runtime'
import MeetingsPage from '~/pages/meetings/index.vue'
import MeetingLinkNotice from '~/components/MeetingLinkNotice.vue'
import { LOCAL_MEETINGS_KEY } from '~/utils/local-meetings'

const ID = '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d'
const ENTRY = { id: ID, title: 'Weekly sync', createdAt: '2026-11-01T10:00:00.000Z' }

beforeEach(() => localStorage.clear())
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('the Your meetings page', () => {
  it('lists what this browser remembers, linking to the meeting', async () => {
    localStorage.setItem(LOCAL_MEETINGS_KEY, JSON.stringify([ENTRY]))
    const page = await mountSuspended(MeetingsPage)
    await flushPromises()
    expect(page.text()).toContain('Weekly sync')
    expect(page.find(`a[href="/meetings/${ID}/progress"]`).exists()).toBe(true)
  })

  it('never asks the server for a list', async () => {
    const fetching = vi.fn(() => ({ meetings: [] }))
    registerEndpoint('/api/meetings', { method: 'GET', handler: fetching })
    await mountSuspended(MeetingsPage)
    await flushPromises()
    expect(fetching).not.toHaveBeenCalled()
  })

  it('says plainly when there is nothing here, and where the list lives', async () => {
    const page = await mountSuspended(MeetingsPage)
    await flushPromises()
    expect(page.text()).toContain('No meetings uploaded from this browser')
    expect(page.text()).toContain('only in this browser')
  })

  it('renders corrupt storage as an empty list', async () => {
    localStorage.setItem(LOCAL_MEETINGS_KEY, '{not json')
    const page = await mountSuspended(MeetingsPage)
    await flushPromises()
    expect(page.text()).toContain('No meetings uploaded from this browser')
  })

  it('says so when storage is refused, rather than claiming the list is empty', async () => {
    vi.spyOn(window, 'localStorage', 'get').mockImplementation(() => {
      throw new DOMException('denied', 'SecurityError')
    })
    const page = await mountSuspended(MeetingsPage)
    await flushPromises()
    expect(page.text()).toContain('not letting MeetMind store anything')
    expect(page.text()).not.toContain('No meetings uploaded from this browser')
  })
})

describe('MeetingLinkNotice', () => {
  const mount = () => mountSuspended(MeetingLinkNotice, { props: { meetingId: ID } })
  const copyButton = (page: Awaited<ReturnType<typeof mount>>) =>
    page.findAll('button').find(b => b.text().includes('Copy link'))!

  it('copies the meeting page\'s full URL, not the page it is shown on', async () => {
    const writeText = vi.fn(async () => {})
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } })
    const page = await mount()
    await copyButton(page).trigger('click')
    await flushPromises()
    expect(writeText).toHaveBeenCalledWith(`${window.location.origin}/meetings/${ID}`)
    expect(page.find('[role="status"]').text()).toBe('Link copied.')
  })

  it('selects the link for copying by hand when the clipboard is refused', async () => {
    vi.stubGlobal('navigator', { ...navigator, clipboard: undefined })
    const page = await mount()
    const select = vi.spyOn(HTMLInputElement.prototype, 'select')
    await copyButton(page).trigger('click')
    await flushPromises()
    expect(select).toHaveBeenCalled()
    expect(page.find('[role="status"]').text()).toContain('Could not copy automatically')
  })

  it('warns that anyone with the link can read the meeting', async () => {
    const page = await mount()
    expect(page.text()).toContain('Anyone with this link')
    expect((page.find('input').element as HTMLInputElement).value).toBe(`${window.location.origin}/meetings/${ID}`)
  })
})

describe('useMeetingUpload', () => {
  /** An XHR whose PUT fails, so the only thing a success path can do has not run. */
  class FailingXhr {
    upload = {}
    onerror: (() => void) | null = null
    open() {}
    setRequestHeader() {}
    send() {
      this.onerror?.()
    }

    abort() {}
  }

  registerEndpoint('/api/meetings', {
    method: 'POST',
    handler: () => ({
      meeting: { ...ENTRY, audioKey: 'meetings/x/audio.ogg' },
      upload: { url: '/put', headers: {} },
    }),
  })

  const job = {
    audio: new Blob(['x']),
    meta: { title: 'Weekly sync', sourceFileName: 'a.mp4', sourceBytes: 1, sourceMime: null, durationSec: null },
  }

  it('remembers a meeting as soon as it registers, even when the upload then fails', async () => {
    vi.stubGlobal('XMLHttpRequest', FailingXhr)
    const { useMeetingUpload } = await import('~/composables/useMeetingUpload')
    const uploader = useMeetingUpload()
    expect(await uploader.upload(job)).toBeNull()
    expect(uploader.state.status).toBe('error')
    expect(JSON.parse(localStorage.getItem(LOCAL_MEETINGS_KEY)!)).toEqual([ENTRY])
  })

  it('does not let a refused storage stop the upload', async () => {
    vi.spyOn(window, 'localStorage', 'get').mockImplementation(() => {
      throw new DOMException('denied', 'SecurityError')
    })
    vi.stubGlobal('XMLHttpRequest', FailingXhr)
    const { useMeetingUpload } = await import('~/composables/useMeetingUpload')
    const uploader = useMeetingUpload()
    await uploader.upload(job)
    // Reached the PUT, whose failure is this stub's own, rather than stopping at storage.
    expect(uploader.state.error).toBe('Network error while uploading audio')
  })
})
