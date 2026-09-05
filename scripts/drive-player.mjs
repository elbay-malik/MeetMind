// Drives the transcript-and-player screen in headless Chromium: a real audio
// element, real seeking, real focus handling. None of that is observable from
// unit tests.
//
// It does NOT prove range support. The committed fixture yields ~70 KB of audio,
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

  // The transcript must be one tab stop, not one per line.
  const tabbable = await page.locator('ol li button[tabindex="0"]').count()
  console.log(`transcript tab stops: ${tabbable}`)
  if (tabbable !== 1) fail(`expected exactly 1 tab stop in the transcript, found ${tabbable}`)

  // Arrow keys must move within the transcript.
  await target.focus()
  await page.keyboard.press('ArrowDown')
  const focusedIdx = await page.evaluate(() => document.activeElement?.getAttribute('data-idx'))
  console.log(`after ArrowDown, focus is on line index ${focusedIdx}`)
  if (focusedIdx === null) fail('ArrowDown did not move focus within the transcript')
}
catch (err) {
  fail(err.message)
}
finally {
  await browser.close()
}
console.log(process.exitCode ? '\nRESULT: FAIL' : '\nRESULT: PASS')
