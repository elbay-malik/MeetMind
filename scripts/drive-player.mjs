// Drives the transcript-and-player screen in headless Chromium: a real audio
// element, real seeking, real focus handling. None of that is observable from
// unit tests.
//
// It does NOT prove range support. The generated fixture (scripts/make-fixture.sh;
// not committed) yields ~70 KB of audio,
// which Chromium downloads in full and then seeks within from memory, so seeking
// looks fine even against a server that ignores Range entirely — verified by
// breaking the route deliberately and watching this script still pass. Range
// correctness is asserted at the HTTP level in tests/e2e/audio-api.spec.ts,
// which does fail against that same break.
//
// Usage: node scripts/drive-player.mjs <baseURL> <meetingId>
// Requires a running server with a transcribed meeting.
import { chromium } from 'playwright-core'

const [baseURL = 'http://localhost:3000', meetingId] = process.argv.slice(2)
if (!meetingId) {
  console.error('usage: node scripts/drive-player.mjs <baseURL> <meetingId>')
  process.exit(2)
}

const fail = (msg) => {
  console.error(`FAIL: ${msg}`)
  process.exitCode = 1
}

const browser = await chromium.launch({
  headless: true,
  ...(process.env.BROWSER_CHANNEL ? { channel: process.env.BROWSER_CHANNEL } : {}),
})
const page = await browser.newPage()
const ranges = []
page.on('request', (r) => {
  if (r.url().includes('/audio')) ranges.push(r.headers().range ?? '(none)')
})
page.on('pageerror', e => fail(`page error: ${e.message}`))

try {
  await page.goto(`${baseURL}/meetings/${meetingId}`, { waitUntil: 'networkidle' })

  // The element must know how long the audio is; without working range support
  // Chromium reports Infinity here and the scrubber never renders.
  const meta = await page.evaluate(async () => {
    const audio = document.querySelector('audio')
    if (!audio) return null
    if (!Number.isFinite(audio.duration)) {
      await new Promise(resolve => audio.addEventListener('loadedmetadata', resolve, { once: true }))
    }
    return {
      duration: audio.duration,
      seekableRanges: audio.seekable.length,
      seekableEnd: audio.seekable.length ? audio.seekable.end(0) : null,
    }
  })
  if (!meta) throw new Error('no audio element on the page')
  console.log('audio metadata:', JSON.stringify(meta))
  if (!Number.isFinite(meta.duration) || meta.duration <= 0) {
    fail(`duration is ${meta.duration}, so the element never learned how long the audio is`)
  }
  if (!meta.seekableRanges) fail('the browser reports no seekable ranges, so seeking would snap to 0')

  // Clicking a transcript line must move the playhead there.
  const lines = page.locator('ol li button')
  const count = await lines.count()
  console.log(`transcript lines rendered: ${count}`)
  if (count < 2) throw new Error('need at least two transcript lines to test seeking')

  const target = lines.nth(Math.min(3, count - 1))
  const stamp = (await target.innerText()).trim().split(/\s+/)[0]
  await target.click()
  await page.waitForTimeout(400)

  const after = await page.evaluate(() => document.querySelector('audio').currentTime)
  console.log(`clicked line at ${stamp}; player currentTime is now ${after.toFixed(2)}s`)
  if (after <= 0) fail('clicking a transcript line did not move the playhead')

  // That line must now be marked current for assistive technology.
  const current = await page.locator('[aria-current="true"]').count()
  console.log(`lines marked aria-current: ${current}`)
  if (current !== 1) fail(`expected exactly one current line, found ${current}`)

  // Informational only: at this fixture size the browser buffers everything, so
  // the absence of a Range request would not prove anything either way.
  console.log('range headers seen (not asserted):', JSON.stringify(ranges.slice(0, 6)))

  // Following must survive our own scrolling. The old implementation mistook
  // its own smooth scroll for the user taking over and switched follow off.
  const followedAfterAutoScroll = await page.evaluate(async () => {
    const audio = document.querySelector('audio')
    audio.currentTime = 0
    await new Promise(r => setTimeout(r, 300))
    // Nudge the playhead across several lines, as playback would.
    for (const t of [5, 10, 15, 20]) {
      audio.currentTime = t
      await new Promise(r => setTimeout(r, 250))
    }
    // If following were still on, no "Follow playback" button is shown.
    return !document.body.textContent.includes('Follow playback')
  })
  console.log('still following after auto-scroll:', followedAfterAutoScroll)
  if (!followedAfterAutoScroll) fail('the page stopped following playback because of its own scrolling')

  // A real user scroll must stop it, and the control must bring it back. The
  // committed fixture yields a handful of short lines that never overflow the
  // container, so shrink it first — otherwise there is nothing to scroll and
  // the check would pass without exercising anything.
  const scrollable = await page.evaluate(async () => {
    const container = document.querySelector('ol').parentElement
    container.style.maxHeight = '80px'
    container.scrollIntoView({ block: 'center' })
    await new Promise(r => setTimeout(r, 150))
    return container.scrollHeight > container.clientHeight
  })
  // A real wheel over the list, dispatched by the browser as user input. This
  // used to set scrollTop and dispatch a synthetic 'scroll' event — which is
  // precisely what centreOn does itself, so the check could not distinguish a
  // user scroll from a programmatic one the page failed to record.
  if (scrollable) {
    const box = await page.locator('ol').first().locator('..').boundingBox()
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.wheel(0, 400)
    await page.waitForTimeout(250)
  }
  const stoppedThenResumed = await page.evaluate(async (scrollable) => {
    const container = document.querySelector('ol').parentElement
    if (!scrollable) return { scrollable: false, stopped: false, resumed: false, visible: false }
    const stopped = document.body.textContent.includes('Follow playback')
    const button = [...document.querySelectorAll('button')].find(b => b.textContent.includes('Follow playback'))
    button?.click()
    await new Promise(r => setTimeout(r, 250))
    const resumed = !document.body.textContent.includes('Follow playback')
    // Resuming re-centres the active line via centreOn(). This container has
    // no `position` of its own, so an offsetTop-based centring (the old
    // implementation) measured against whatever positioned ancestor was
    // actually nearest — the page, not this container — and could compute a
    // scrollTop that left the active line nowhere near this 80px viewport at
    // all. getBoundingClientRect comparisons must not have that problem: the
    // active line should end up fully inside the container's own bounds.
    const active = document.querySelector('[aria-current="true"]')
    const c = container.getBoundingClientRect()
    const a = active?.getBoundingClientRect()
    const visible = !!a && a.top >= c.top - 1 && a.bottom <= c.bottom + 1
    return { scrollable: true, stopped, resumed, visible }
  }, scrollable)
  if (!stoppedThenResumed.scrollable) fail('could not make the transcript scrollable, so follow behaviour went untested')
  console.log('user scroll stopped following:', stoppedThenResumed.stopped, '| control resumed it:', stoppedThenResumed.resumed)
  if (!stoppedThenResumed.stopped) fail('a user scroll did not stop the transcript following playback')
  if (!stoppedThenResumed.resumed) fail('the Follow playback control did not resume following')
  console.log('active line visible in the (shrunk) container after re-centring:', stoppedThenResumed.visible)
  if (!stoppedThenResumed.visible) fail('resuming follow did not scroll the active line into view within the transcript container')

  // Following playback must not move the page, or the player scrolls out of
  // view. Measured as a delta so an earlier deliberate click is not counted.
  const pageMovement = await page.evaluate(async () => {
    window.scrollTo(0, 0)
    await new Promise(r => setTimeout(r, 100))
    const audio = document.querySelector('audio')
    for (const t of [2, 8, 14, 20]) {
      audio.currentTime = t
      await new Promise(r => setTimeout(r, 200))
    }
    return window.scrollY
  })
  console.log('window scrollY caused by following:', pageMovement)
  if (pageMovement > 0) fail('following playback scrolled the page and pushed the player out of view')

  // Moving within the transcript by keyboard must not move the page.
  //
  // Real key presses, measured from where the page already is. The old version
  // dispatched untrusted KeyboardEvents, whose DEFAULT actions browsers never
  // perform — so the native arrow-key page scroll that move()'s preventDefault
  // exists to stop could not happen, and the check could not fail for the
  // reason it names. It also focused the first line with preventScroll itself,
  // pre-empting the one step that moves the page.
  //
  // Tabbing INTO the list from outside is deliberately not held to this: the
  // browser scrolling a newly focused control into view is what keeps keyboard
  // focus visible, and suppressing it could leave the focused line off-screen.
  // What must not move the page is navigation once focus is already there.
  await page.evaluate(() => {
    document.querySelector('ol').parentElement.scrollIntoView({ block: 'center' })
    document.querySelector('ol li button[tabindex="0"]')?.focus()
  })
  await page.waitForTimeout(150)
  // Record whether each real arrow key reached the window with its default
  // action cancelled. Page movement alone cannot fail this reliably: a native
  // arrow-key scroll moves the focused list first and only chains to the page
  // once neither can move further, so with preventDefault removed from move()
  // the page still measured 0 here in both mid-list and end-of-list runs. The
  // cancelled default IS the behaviour that keeps the page still.
  await page.evaluate(() => {
    window.__arrowKeys = []
    window.addEventListener('keydown', (e) => {
      if (e.key.startsWith('Arrow')) window.__arrowKeys.push(e.defaultPrevented)
    })
  })
  const scrollBefore = await page.evaluate(() => window.scrollY)
  for (let i = 0; i < 5; i++) {
    await page.keyboard.press('ArrowDown')
    await page.waitForTimeout(80)
  }
  const arrowKeys = await page.evaluate(() => window.__arrowKeys)
  console.log(`arrow keys handled with their default cancelled: ${arrowKeys.filter(Boolean).length}/${arrowKeys.length}`)
  if (arrowKeys.length === 0) fail('no arrow key reached the page, so keyboard navigation went untested')
  else if (!arrowKeys.every(Boolean)) fail('an arrow key inside the transcript was left to scroll natively')
  const keyboardMovement = Math.abs(await page.evaluate(() => window.scrollY) - scrollBefore)
  console.log('window scrollY caused by keyboard navigation:', keyboardMovement)
  if (keyboardMovement > 0) fail('keyboard navigation scrolled the page out from under the player')

  // Every summary item shows its supporting quote. It is the only way a reader
  // can notice a real quote paired with a claim it does not support, and it
  // used to be stored and never rendered at all.
  const quotes = await page.evaluate(() => {
    const items = [...document.querySelectorAll('ul li button')]
    return { items: items.length, withQuote: items.filter(b => b.querySelector('q')?.textContent.trim()).length }
  })
  console.log(`summary items: ${quotes.items}, showing their quote: ${quotes.withQuote}`)
  if (quotes.items === 0) fail('no summary items rendered, so quote rendering went untested')
  else if (quotes.withQuote !== quotes.items) fail('a summary item is rendered without its supporting quote')

  // The transcript must be one tab stop, not one per line.
  const tabbable = await page.locator('ol li button[tabindex="0"]').count()
  console.log(`transcript tab stops: ${tabbable}`)
  if (tabbable !== 1) fail(`expected exactly 1 tab stop in the transcript, found ${tabbable}`)

  // Arrow keys must move focus to the NEXT line. The old check only asserted
  // that focus was on SOME line afterwards — true before the key press too,
  // since focusing the target already put it on one, so deleting the focus
  // move from onKeydown left it passing.
  await target.focus()
  const beforeIdx = Number(await page.evaluate(() => document.activeElement?.getAttribute('data-idx')))
  await page.keyboard.press('ArrowDown')
  const afterIdx = Number(await page.evaluate(() => document.activeElement?.getAttribute('data-idx')))
  console.log(`ArrowDown moved focus from line ${beforeIdx} to line ${afterIdx}`)
  if (afterIdx !== Math.min(beforeIdx + 1, count - 1)) {
    fail(`ArrowDown should move focus to line ${beforeIdx + 1}, but it is on ${afterIdx}`)
  }
}
catch (err) {
  fail(err.message)
}
finally {
  await browser.close()
}
console.log(process.exitCode ? '\nRESULT: FAIL' : '\nRESULT: PASS')
