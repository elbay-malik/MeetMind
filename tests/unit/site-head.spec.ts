import { access, readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const inRepo = (path: string) => readFile(fileURLToPath(new URL(`../../${path}`, import.meta.url)), 'utf8')

describe('what a visitor or a link preview sees first', () => {
  it('declares the language, a description, a preview and icons on every page', async () => {
    const config = await inRepo('nuxt.config.ts')
    for (const wanted of ['htmlAttrs: { lang: \'en\' }', 'name: \'description\'', 'property: \'og:title\'', 'property: \'og:description\'', 'property: \'og:image\'']) {
      expect(config).toContain(wanted)
    }
    for (const file of ['public/favicon.ico', 'public/favicon.svg', 'public/apple-touch-icon.png', 'public/og.png']) {
      await access(fileURLToPath(new URL(`../../${file}`, import.meta.url)))
    }
  })

  it('points the preview at the host wrangler.jsonc serves', async () => {
    const host = /"pattern": "([^"]+)"/.exec(await inRepo('wrangler.jsonc'))?.[1]
    expect(await inRepo('nuxt.config.ts')).toContain(`content: 'https://${host}/og.png'`)
  })

  // A meeting's link is the key to it (ADR-0013), so the head names none.
  it('has no og:url', async () => {
    expect(await inRepo('nuxt.config.ts')).not.toContain('property: \'og:url\'')
  })

  it('does not call the home page Upload', async () => {
    expect(await inRepo('app/pages/index.vue')).not.toContain('MeetMind — Upload')
  })

  it('does not promise click-to-seek for a later phase', async () => {
    expect(await inRepo('app/pages/meetings/[id]/progress.vue')).not.toContain('next phase')
  })
})

describe('what the rate rule counts', () => {
  it('opens the demo with a full page load, which reads it in one request', async () => {
    expect(await inRepo('app/pages/index.vue')).toMatch(/:to="`\/meetings\/\$\{demoMeetingId\}`"\s+external/)
  })

  it('does not repeat a blocked read at once, and does repeat other failures', async () => {
    const { PAGE_READ } = await import('../../app/utils/page-read')
    expect(PAGE_READ.retryStatusCodes).not.toContain(429)
    expect(PAGE_READ.retryStatusCodes).toEqual(expect.arrayContaining([500, 502, 503, 504]))
  })

  it.each(['app/pages/meetings/[id]/index.vue', 'app/pages/meetings/[id]/progress.vue', 'app/components/MeetingQuestions.vue'])('%s uses it', async (path) => {
    expect(await inRepo(path)).toContain('PAGE_READ')
  })
})
