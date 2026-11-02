import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { mountSuspended, registerEndpoint } from '@nuxt/test-utils/runtime'
import MeetingsPage from '~/pages/meetings/index.vue'
import MeetingLinkNotice from '~/components/MeetingLinkNotice.vue'
import { LOCAL_MEETINGS_KEY } from '~/utils/local-meetings'

const ID = '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d'
const ENTRY = { id: ID, title: 'Weekly sync', createdAt: '2026-11-01T10:00:00.000Z' }

/** Reads work and writes do not: a full disk, or an origin out of quota. */
function refuseWrites() {
  const real = localStorage
  vi.spyOn(window, 'localStorage', 'get').mockReturnValue({
    getItem: (key: string) => real.getItem(key),
    setItem: () => {
      throw new DOMException('full', 'QuotaExceededError')
    },
    removeItem: (key: string) => real.removeItem(key),
  } as unknown as Storage)
}

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

describe('removing a row from Your meetings', () => {
  const removeButton = (page: Awaited<ReturnType<typeof mountSuspended>>) =>
    page.find('button[aria-label="Remove Weekly sync from this list"]')

  /** happy-dom has no window.confirm to spy on. */
  function answerConfirm(answer: boolean) {
    const confirm = vi.fn((_message: string) => answer)
    Object.defineProperty(window, 'confirm', { value: confirm, configurable: true })
    return confirm
  }

  beforeEach(() => localStorage.setItem(LOCAL_MEETINGS_KEY, JSON.stringify([ENTRY])))

  it('forgets the link once confirmed, saying the meeting itself stays', async () => {
    const confirm = answerConfirm(true)
    const page = await mountSuspended(MeetingsPage)
    await flushPromises()
    await removeButton(page).trigger('click')
    expect(confirm.mock.calls[0]![0]).toContain('not deleted')
    expect(page.text()).not.toContain('Weekly sync')
    expect(page.text()).toContain('No meetings uploaded from this browser')
    expect(JSON.parse(localStorage.getItem(LOCAL_MEETINGS_KEY)!)).toEqual([])
  })

  it('keeps the row when the confirmation is declined', async () => {
    answerConfirm(false)
    const page = await mountSuspended(MeetingsPage)
    await flushPromises()
    await removeButton(page).trigger('click')
    expect(page.text()).toContain('Weekly sync')
  })

  it('says so when the removal could not be stored', async () => {
    answerConfirm(true)
    const page = await mountSuspended(MeetingsPage)
    await flushPromises()
    refuseWrites()
    await removeButton(page).trigger('click')
    expect(page.text()).toContain('Weekly sync')
    expect(page.text()).toContain('Could not remove')
  })

  it('labels a row whose upload never finished, and no other', async () => {
    const OTHER = { ...ENTRY, id: ID.replace('9b1', 'ab1'), title: 'Finished one' }
    localStorage.setItem(LOCAL_MEETINGS_KEY, JSON.stringify([{ ...ENTRY, unfinished: true }, OTHER]))
    const page = await mountSuspended(MeetingsPage)
    await flushPromises()
    const rows = page.findAll('li')
    expect(rows.find(r => r.text().includes('Weekly sync'))!.text()).toContain('Upload not finished')
    expect(rows.find(r => r.text().includes('Finished one'))!.text()).not.toContain('Upload not finished')
  })
})

describe('the Your meetings page, when writes are refused and reads are not', () => {
  it('warns, rather than claiming nothing was uploaded', async () => {
    refuseWrites()
    const page = await mountSuspended(MeetingsPage)
    await flushPromises()
    expect(page.text()).toContain('not letting MeetMind store anything')
    expect(page.text()).not.toContain('No meetings uploaded from this browser')
  })

  it('warns when reads are refused and writes are not, rather than claiming the list is empty', async () => {
    vi.spyOn(window, 'localStorage', 'get').mockReturnValue({
      getItem: () => {
        throw new DOMException('denied', 'SecurityError')
      },
      setItem: () => {},
      removeItem: () => {},
    } as unknown as Storage)
    const page = await mountSuspended(MeetingsPage)
    await flushPromises()
    expect(page.text()).toContain('not letting MeetMind store anything')
    expect(page.text()).not.toContain('No meetings uploaded from this browser')
  })

  it('warns and still lists what it already holds', async () => {
    localStorage.setItem(LOCAL_MEETINGS_KEY, JSON.stringify([ENTRY]))
    refuseWrites()
    const page = await mountSuspended(MeetingsPage)
    await flushPromises()
    expect(page.text()).toContain('not letting MeetMind store anything')
    expect(page.text()).toContain('Weekly sync')
  })
})

describe('MeetingLinkNotice', () => {
  const mount = () => mountSuspended(MeetingLinkNotice, { props: { meetingId: ID } })
  const copyButton = (page: Awaited<ReturnType<typeof mount>>) =>
    page.findAll('button').find(b => b.text().includes('Copy link'))!

  it('keeps the status region mounted and empty before any click, so the change is announced', async () => {
    const status = (await mount()).find('[role="status"]')
    expect(status.exists()).toBe(true)
    expect(status.text()).toBe('')
  })

  it('shows the link in a field that cannot be edited', async () => {
    expect((await mount()).find('input').attributes('readonly')).toBeDefined()
  })

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

  describe('on the public demo meeting', () => {
    const setDemo = (id: string) => {
      useRuntimeConfig().public.demoMeetingId = id
    }
    afterEach(() => setDemo(''))

    it.each([ID, ID.toUpperCase()])('does not claim the link is the only way back (%s)', async (demoId) => {
      setDemo(demoId)
      const page = await mount()
      expect(page.text()).toContain('public demo meeting')
      expect(page.text()).not.toContain('only way back')
      expect(page.text()).not.toContain('lose access')
      expect(page.find('input').exists()).toBe(true)
    })

    it('is headed as a link to look at, not one to keep', async () => {
      setDemo(ID)
      const heading = (await mount()).find('h2').text()
      expect(heading).toBe('Link to this meeting')
    })

    it('still warns on any other meeting when a demo is configured', async () => {
      setDemo(ID.replace('9b1', 'ab1'))
      const page = await mount()
      expect(page.text()).toContain('only way back')
      expect(page.text()).not.toContain('public demo meeting')
    })
  })

  describe('when this browser refused to remember a meeting', () => {
    afterEach(() => {
      useNotRememberedMeetings().value = []
    })

    it('alerts on that meeting', async () => {
      useNotRememberedMeetings().value = [ID]
      const alert = (await mount()).find('[role="alert"]')
      expect(alert.text()).toContain('could not add this meeting to Your meetings')
    })

    it('says nothing about any other meeting', async () => {
      useNotRememberedMeetings().value = [ID.replace('9b1', 'ab1')]
      const page = await mount()
      expect(page.text()).not.toContain('could not add this meeting')
      expect(page.find('[role="alert"]').exists()).toBe(false)
    })
  })

  it('says nothing extra about a meeting this browser did remember', async () => {
    const page = await mount()
    expect(page.text()).not.toContain('could not add this meeting')
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

  /** An XHR whose PUT the user cancels. */
  class CancelledXhr extends FailingXhr {
    onabort: (() => void) | null = null
    override send() {
      this.onabort?.()
    }
  }

  /** An XHR whose PUT lands. */
  class SucceedingXhr extends FailingXhr {
    status = 200
    onload: (() => void) | null = null
    override send() {
      this.onload?.()
    }
  }

  /** What the next registrations answer; ENTRY once this runs out. */
  let registrations: (typeof ENTRY | 'refused')[] = []
  const ATTEMPT = (n: number) => ({ ...ENTRY, id: ID.replace(/.$/, String(n)) })

  beforeEach(() => {
    registrations = []
  })

  registerEndpoint('/api/meetings', {
    method: 'POST',
    handler: () => {
      const next = registrations.shift() ?? ENTRY
      if (next === 'refused') throw new Error('registration refused')
      return {
        meeting: { ...next, audioKey: 'meetings/x/audio.ogg' },
        upload: { url: '/put', headers: {} },
      }
    },
  })

  registerEndpoint(`/api/meetings/${ID}/complete`, {
    method: 'POST',
    handler: () => ({ meeting: { ...ENTRY, audioKey: 'meetings/x/audio.ogg' } }),
  })

  const listedIds = () => JSON.parse(localStorage.getItem(LOCAL_MEETINGS_KEY)!).map((m: { id: string }) => m.id)

  const job = {
    audio: new Blob(['x']),
    inviteCode: 'a-code',
    meta: { title: 'Weekly sync', sourceFileName: 'a.mp4', sourceBytes: 1, sourceMime: null, durationSec: null },
  }

  it('remembers a meeting as soon as it registers, even when the upload then fails', async () => {
    vi.stubGlobal('XMLHttpRequest', FailingXhr)
    const { useMeetingUpload } = await import('~/composables/useMeetingUpload')
    const uploader = useMeetingUpload()
    expect(await uploader.upload(job)).toBeNull()
    expect(uploader.state.status).toBe('error')
    expect(JSON.parse(localStorage.getItem(LOCAL_MEETINGS_KEY)!)).toEqual([{ ...ENTRY, unfinished: true }])
  })

  it('clears the unfinished mark when the upload completes', async () => {
    vi.stubGlobal('XMLHttpRequest', SucceedingXhr)
    const { useMeetingUpload } = await import('~/composables/useMeetingUpload')
    expect(await useMeetingUpload().upload(job)).not.toBeNull()
    expect(JSON.parse(localStorage.getItem(LOCAL_MEETINGS_KEY)!)).toEqual([ENTRY])
  })

  it.each([
    ['failed', FailingXhr],
    ['cancelled', CancelledXhr],
  ])('lists one row, not two, when a %s upload is retried', async (_name, Xhr) => {
    vi.stubGlobal('XMLHttpRequest', Xhr)
    registrations = [ATTEMPT(1), ATTEMPT(2)]
    const { useMeetingUpload } = await import('~/composables/useMeetingUpload')
    const uploader = useMeetingUpload()
    await uploader.upload(job)
    await uploader.upload(job)
    expect(listedIds()).toEqual([ATTEMPT(2).id])
  })

  it('keeps the earlier row when the retry cannot even register', async () => {
    vi.stubGlobal('XMLHttpRequest', FailingXhr)
    registrations = [ATTEMPT(1), 'refused', ATTEMPT(3)]
    const { useMeetingUpload } = await import('~/composables/useMeetingUpload')
    const uploader = useMeetingUpload()
    await uploader.upload(job)
    await uploader.upload(job)
    expect(listedIds()).toEqual([ATTEMPT(1).id])
    // The attempt that got no row must not make the next retry lose track of it.
    await uploader.upload(job)
    expect(listedIds()).toEqual([ATTEMPT(3).id])
  })

  it('keeps both rows when the user moved on to another recording', async () => {
    vi.stubGlobal('XMLHttpRequest', FailingXhr)
    registrations = [ATTEMPT(1), ATTEMPT(2)]
    const { useMeetingUpload } = await import('~/composables/useMeetingUpload')
    const uploader = useMeetingUpload()
    await uploader.upload(job)
    uploader.reset()
    await uploader.upload(job)
    expect(listedIds().sort()).toEqual([ATTEMPT(1).id, ATTEMPT(2).id].sort())
  })

  it('keeps the earlier row when the user moves on after a retry that could not register', async () => {
    vi.stubGlobal('XMLHttpRequest', FailingXhr)
    registrations = [ATTEMPT(1), 'refused', ATTEMPT(3)]
    const { useMeetingUpload } = await import('~/composables/useMeetingUpload')
    const uploader = useMeetingUpload()
    await uploader.upload(job)
    await uploader.upload(job)
    uploader.reset()
    await uploader.upload(job)
    expect(listedIds().sort()).toEqual([ATTEMPT(1).id, ATTEMPT(3).id].sort())
  })

  it('tells the meeting\'s notice when the browser refused to remember it', async () => {
    refuseWrites()
    vi.stubGlobal('XMLHttpRequest', FailingXhr)
    const { useMeetingUpload } = await import('~/composables/useMeetingUpload')
    await useMeetingUpload().upload(job)
    const notice = await mountSuspended(MeetingLinkNotice, { props: { meetingId: ID } })
    expect(notice.text()).toContain('could not add this meeting to Your meetings')
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
