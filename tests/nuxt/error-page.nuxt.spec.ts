import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import ErrorPage from '~/error.vue'

const shown = (statusCode: number, statusMessage: string) =>
  mountSuspended(ErrorPage, { props: { error: { statusCode, statusMessage } as never } })

beforeEach(() => sessionStorage.clear())

describe('the error page', () => {
  it('says a meeting is not there, with a way home and nothing to retry', async () => {
    const page = await shown(404, 'Meeting not found')
    expect(page.text()).toContain('Meeting not found')
    expect(page.text()).toContain('Go to the home page')
    expect(page.text()).not.toContain('Try again')
  })

  it('does not repeat what a 404 said about the path', async () => {
    const page = await shown(404, 'Page not found: /<anything>')
    expect(page.find('h1').text()).toBe('Page not found')
  })

  it.each([429, 500, 503])('says a %i is being retried, with no status code or server text', async (status) => {
    const page = await shown(status, 'Could not load meeting: secret detail')
    expect(page.find('h1').text()).toBe('This page could not be loaded')
    expect(page.text()).toContain('Trying again in a few seconds.')
    expect(page.text()).toContain('Try again')
    expect(page.text()).toContain('Go to the home page')
    expect(page.text()).not.toContain('secret detail')
    expect(page.text()).not.toContain(String(status))
    page.unmount()
  })

  it('stops reloading by itself after three tries at one page, and still offers the button', async () => {
    for (let i = 0; i < 3; i++) {
      const page = await shown(503, 'x')
      expect(page.text()).toContain('Trying again in a few seconds.')
      page.unmount()
    }
    const page = await shown(503, 'x')
    expect(page.text()).toContain('Try again in a moment.')
    expect(page.text()).not.toContain('Trying again in a few seconds.')
    expect(page.find('button').exists()).toBe(true)
  })

  it('does not speak of a meeting when the path is not one', async () => {
    const page = await shown(404, 'Page not found: /nope')
    expect(page.text()).toContain('The link may be wrong.')
    expect(page.text()).not.toContain('the meeting may have been deleted')
    page.unmount()
  })

  it('goes home inside the app, as a full page load during the block would leave it', async () => {
    const page = await shown(503, 'x')
    const home = page.findAll('a').find(a => a.text() === 'Go to the home page')!
    expect(home.attributes('href')).toBe('/')
    expect(home.attributes('target')).toBeUndefined()
    page.unmount()
  })

  describe('with time passing', () => {
    let reload: ReturnType<typeof vi.spyOn>
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
      reload = vi.spyOn(window.location, 'reload').mockImplementation(() => {})
    })
    afterEach(() => {
      vi.useRealTimers()
      reload.mockRestore()
    })
    const tryAgain = (page: Awaited<ReturnType<typeof shown>>) => page.findAll('button').find(b => b.text() === 'Try again')!

    it('reloads after the block, and its button waits for that, as a click during the block leaves the app', async () => {
      const page = await shown(503, 'x')
      expect(tryAgain(page).attributes('disabled')).toBeDefined()
      await vi.advanceTimersByTimeAsync(10_999)
      expect(reload).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(1)
      expect(reload).toHaveBeenCalledOnce()
      page.unmount()
    })

    it('offers the button at once when it will not reload by itself', async () => {
      for (let i = 0; i < 3; i++) (await shown(503, 'x')).unmount()
      const page = await shown(503, 'x')
      expect(tryAgain(page).attributes('disabled')).toBeUndefined()
      page.unmount()
    })

    it('forgets the count after a minute, as blocks minutes apart are not one outage', async () => {
      for (let i = 0; i < 3; i++) (await shown(503, 'x')).unmount()
      await vi.advanceTimersByTimeAsync(60_000)
      const page = await shown(503, 'x')
      expect(page.text()).toContain('Trying again in a few seconds.')
      page.unmount()
    })
  })

  it('counts another page\'s failures separately', async () => {
    sessionStorage.setItem('meetmind-error-reloads', JSON.stringify({ path: '/somewhere-else', count: 3, at: Date.now() }))
    const page = await shown(503, 'x')
    expect(page.text()).toContain('Trying again in a few seconds.')
    page.unmount()
  })
})
