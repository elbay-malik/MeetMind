// Drives the cross-meeting search UI in headless Chromium: the archive
// page's search box, results tagged with their real meeting, and clicking a
// result actually seeking a different page's player. None of that is
// observable from unit or e2e tests, which drive the route directly rather
// than a real browser navigating between pages.
//
// Meetings are created and indexed through the real API, the same way the
// e2e suite does it — only the search UI itself is new browser-only
// behaviour worth spending a real page load on; re-driving the upload flow
// here would just re-prove what drive-upload.mjs already does.
//
// Usage: node scripts/drive-search.mjs <baseURL> <dataDir>
//   dataDir: the server's NUXT_DATA_DIR, used to inject distinctive
//   transcripts directly (the stub transcriber's own output differs only by
//   number, which gives search nothing to tell apart — same technique
//   tests/e2e/search-api.spec.ts uses).
// Requires a running server (pnpm dev / preview). BROWSER_CHANNEL=chrome|msedge
// picks a system browser instead of Playwright's bundled Chromium.
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { createStorage } from 'unstorage'
import fsDriver from 'unstorage/drivers/fs'
import { join } from 'node:path'
import { chromium } from 'playwright-core'

const [baseURL = 'http://localhost:3000', dataDir] = process.argv.slice(2)
if (!dataDir) {
  console.error('usage: node scripts/drive-search.mjs <baseURL> <dataDir>')
  process.exit(2)
}

const fail = (msg) => {
  console.error(`FAIL: ${msg}`)
  process.exitCode = 1
}

// A real, decodable audio file, not the synthetic byte pattern the e2e suite
// uses: this script's own <audio> element has to load real metadata for the
// deep-link seek below to mean anything, which no fake bytes would exercise.
// Long enough to cover the target passage at 75s below with room to spare —
// a seek past the audio's own duration would clamp or be ignored, silently
// invalidating the check.
const audioPath = join(mkdtempSync(join(tmpdir(), 'meetmind-drive-search-')), 'fixture.ogg')
execFileSync('ffmpeg', [
  '-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=90',
  '-c:a', 'libopus', '-b:a', '16k', audioPath,
])
const audio = readFileSync(audioPath)

async function indexedMeeting(title, segments) {
  const { meeting, upload } = await (await fetch(`${baseURL}/api/meetings`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      title, sourceFileName: 'meeting.mp4', sourceBytes: 1_000_000,
      sourceMime: 'video/mp4', durationSec: 90, audioBytes: audio.byteLength,
    }),
  })).json()
  // upload.url is a relative path (the upload route lives on this same
  // origin); plain fetch, unlike a browser or @nuxt/test-utils's, has no
  // base URL to resolve it against.
  await fetch(new URL(upload.url, baseURL), { method: 'PUT', headers: { 'content-type': 'audio/ogg' }, body: audio })
  await fetch(`${baseURL}/api/meetings/${meeting.id}/complete`, { method: 'POST' })
  // One step per request (ADR-0012): ask until the transcript is stored.
  for (let step = 0; ; step++) {
    const res = await fetch(`${baseURL}/api/meetings/${meeting.id}/transcribe`, { method: 'POST' })
    if (res.status === 200) break
    if (res.status !== 202 || step === 50) fail(`transcribing ${meeting.id} stopped at HTTP ${res.status}`)
  }

  const storage = createStorage({ driver: fsDriver({ base: join(dataDir, 'db') }) })
  await storage.setItem(`transcripts/${meeting.id}`, segments)

  const { index } = await (await fetch(
    `${baseURL}/api/meetings/${meeting.id}/search-index`, { method: 'POST' },
  )).json()
  if (index.state !== 'ready') fail(`meeting ${meeting.id} did not index cleanly: ${JSON.stringify(index)}`)
  return meeting.id
}

/** Filler far from index 0, so a seek landing near the target proves the deep
 * link actually moved the player rather than merely defaulting to 0:00 (the
 * same "park away from 0:00" precaution drive-upload.mjs's citation check
 * uses, applied here by placing the content away from 0:00 to begin with). */
const filler = tag => Array.from({ length: 15 }, (_, i) => ({
  idx: i, startMs: i * 5_000, endMs: i * 5_000 + 4_800, text: `${tag} general update number ${i}`,
}))

const browser = await chromium.launch({
  headless: true,
  ...(process.env.BROWSER_CHANNEL ? { channel: process.env.BROWSER_CHANNEL } : {}),
})
const page = await browser.newPage()
page.on('pageerror', e => fail(`page error: ${e.message}`))

try {
  const budgetId = await indexedMeeting('Budget review', [
    ...filler('budget'),
    { idx: 15, startMs: 75_000, endMs: 79_800, text: 'We agreed to cut the marketing budget by twenty percent.' },
  ])
  await indexedMeeting('Hiring roundup', [
    ...filler('hiring'),
    { idx: 15, startMs: 75_000, endMs: 79_800, text: 'Priya will interview two candidates for a design role.' },
  ])
  console.log('indexed two meetings:', budgetId)

  await page.goto(`${baseURL}/meetings`, { waitUntil: 'networkidle' })
  await page.getByPlaceholder('e.g. What did we decide about the budget?').fill('What did we decide about the marketing budget?')
  await page.getByRole('button', { name: 'Search' }).click()

  const status = page.locator('[role=status]', { hasText: /result/ })
  await status.waitFor({ timeout: 15_000 })
  console.log('search status announced:', await status.innerText())

  // The two indexed meetings ALSO appear in the plain archive list further
  // down the page, which is not what this is testing — scoped to links that
  // carry a quote (`<q>`), a shape only the search results list has.
  const results = page.locator('a:has(q)').filter({ hasText: 'Budget review' })
  await results.first().waitFor({ timeout: 10_000 })
  const resultText = await results.first().innerText()
  console.log('result text:', resultText.replace(/\s+/g, ' '))
  if (!/marketing budget/.test(resultText)) fail('the budget result does not show the passage that matched')
  if (/Priya|design role/.test(resultText)) fail('the hiring meeting\'s content leaked into the budget result')

  await results.first().click()
  await page.waitForURL(/\/meetings\/[0-9a-f-]{36}\?t=\d+&seg=\d+/, { timeout: 10_000 })
  const url = new URL(page.url())
  const meetingIdInUrl = url.pathname.match(/meetings\/([0-9a-f-]{36})/)[1]
  console.log('followed link to', url.pathname + url.search)
  if (meetingIdInUrl !== budgetId) fail(`followed the result to ${meetingIdInUrl}, not the budget meeting ${budgetId}`)

  const targetStartMs = Number(url.searchParams.get('t'))
  const audioEl = page.locator('audio')
  await audioEl.waitFor({ timeout: 10_000 })
  // The seek runs once metadata loads (app/pages/meetings/[id]/index.vue's
  // onMounted); poll rather than read currentTime immediately.
  let seekedTo = -1
  for (let i = 0; i < 20; i++) {
    seekedTo = await page.evaluate(() => document.querySelector('audio')?.currentTime ?? -1)
    if (Math.abs(seekedTo - targetStartMs / 1000) <= 1.5) break
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  console.log(`deep link seeked the player to ${seekedTo.toFixed(2)}s (target ${(targetStartMs / 1000).toFixed(2)}s)`)
  if (targetStartMs === 0) fail('test fixture put the target at 0:00, which cannot distinguish a real seek from doing nothing')
  if (Math.abs(seekedTo - targetStartMs / 1000) > 1.5) fail('following a search result did not seek the player to the right moment')

  if (!process.exitCode) console.log('RESULT: PASS')
}
catch (err) {
  fail(err.stack ?? String(err))
}
finally {
  await browser.close()
}

if (process.exitCode) console.log('RESULT: FAIL')
