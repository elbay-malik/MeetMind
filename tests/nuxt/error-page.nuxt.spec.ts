import { beforeEach, describe, expect, it } from 'vitest'
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

  it('counts another page\'s failures separately', async () => {
    sessionStorage.setItem('meetmind-error-reloads', JSON.stringify({ path: '/somewhere-else', count: 3 }))
    const page = await shown(503, 'x')
    expect(page.text()).toContain('Trying again in a few seconds.')
    page.unmount()
  })
})
