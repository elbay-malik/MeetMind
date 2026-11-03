// Drives the real upload flow in headless Chromium: drop a fixture on "/",
// extract audio in-browser, upload it, land on the progress page, check what
// actually reached storage, then watch the page take the meeting to `ready` with
// no click at all. After that: a second tab that watches and takes over, leaving
// and coming back, what a wait and an error look like, a browser with no Web Locks,
// and the public demo. Every claim about driving is checked against the requests
// each tab was seen to send. Phase 3 acceptance check; ADR-0012's step 10 acceptance.
//
// Usage: node scripts/drive-upload.mjs <baseURL> [fixturePath] [dataDir]
//   dataDir: the server's NUXT_DATA_DIR — when given, the stored object is
//   inspected on disk (size, ffprobe if available, and "no video" invariant), and
//   the public demo is checked on a second server over the same data.
// Requires a running server (pnpm dev / preview), and the code it was started
// with in NUXT_INVITE_CODE. BROWSER_CHANNEL=chrome|msedge picks a system browser
// instead of Playwright's bundled Chromium.
import { execFileSync, spawn } from 'node:child_process'
import { copyFileSync, existsSync, mkdtempSync, readdirSync, statSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright-core'
// The same normalization + citation-matching contract reconcile.ts applies
// server-side. A copy, because this is plain Node — but one that
// tests/unit/driver-citation-parity.spec.ts holds to the real implementation,
// rather than the hand-synced block that used to live here and drifted twice.
import { quoteStartsAt } from './lib/citation-match.mjs'

const [
  baseURL = 'http://localhost:3000',
  fixturePath = new URL('../fixtures/fixture-30s-720p.mp4', import.meta.url).pathname,
  dataDir,
] = process.argv.slice(2)

const fail = (msg) => {
  console.error(`FAIL: ${msg}`)
  process.exitCode = 1
}

const inviteCode = process.env.NUXT_INVITE_CODE
if (!inviteCode) {
  console.error('FAIL: set NUXT_INVITE_CODE to the code the server was started with')
  process.exit(1)
}

const ADVANCE = 'POST /advance'
const READ = 'GET /pipeline'
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

async function waitUntil(condition, timeoutMs, message) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await condition()) return
    if (Date.now() >= deadline) throw new Error(message)
    await sleep(50)
  }
}

/** Every request one tab sends about a pipeline, as it goes out. What was sent, not what a page says. */
function requestsOf(page) {
  const log = []
  page.on('request', (request) => {
    const route = /\/api\/meetings\/[0-9a-f-]{36}\/(advance|pipeline|transcribe|summarize|search-index)$/.exec(new URL(request.url()).pathname)
    if (route) log.push({ route: `${request.method()} /${route[1]}`, at: Date.now() })
  })
  const count = name => log.filter(entry => entry.route === name).length
  return { log, count, times: name => log.filter(entry => entry.route === name).map(entry => entry.at) }
}

/** A tab's errors fail the run, and a mismatch between the server's render and the client's is one. */
function failOnPageErrors(page) {
  page.on('pageerror', e => fail(`page error: ${e.message}`))
  page.on('console', (m) => {
    if (m.type() === 'error' && /hydrat/i.test(m.text())) fail(`${new URL(page.url()).pathname}: ${m.text()}`)
  })
}

/**
 * Holds every `POST .../advance` a browser context sends, until told otherwise, so a test can
 * look at a meeting between its steps however fast the stubs are. Holds nothing back from the
 * server's own answers: what is let through goes to the real route.
 *
 * Each of these acts on the newest one held. Any older ones belong to a page that has since
 * gone, and those are let go: a request left held stays pending for ever.
 */
async function gateAdvances(context) {
  let open = false
  let arrivals = 0
  const held = []
  await context.route('**/api/meetings/*/advance', (route) => {
    arrivals++
    if (open) return route.continue()
    held.push(route)
  })
  const quietly = promise => promise.catch(() => {})
  const newest = async () => {
    await waitUntil(() => held.length > 0, 15_000, 'no step is being held')
    const route = held.pop()
    await Promise.all(held.splice(0).map(older => quietly(older.continue())))
    return route
  }
  return {
    held: () => held.length,
    /** How many have reached this gate. Once it has seen one, that one is being held. */
    arrivals: () => arrivals,
    release: async () => quietly((await newest()).continue()),
    answer: async reply => quietly((await newest()).fulfill(reply)),
    abort: async () => quietly((await newest()).abort('failed')),
    open: async () => {
      open = true
      await Promise.all(held.splice(0).map(route => quietly(route.continue())))
    },
  }
}

/** A meeting of the same audio, stored and confirmed, without minutes of extraction per scenario. */
async function seedMeeting(title, audio, base = baseURL) {
  const registered = await fetch(`${base}/api/meetings`, {
    method: 'POST',
    headers: { 'authorization': `Bearer ${inviteCode}`, 'content-type': 'application/json' },
    body: JSON.stringify({ title, sourceFileName: 'meeting.mp4', sourceBytes: 1_000_000, sourceMime: 'video/mp4', durationSec: 30, audioBytes: audio.byteLength }),
  })
  if (!registered.ok) throw new Error(`could not register a meeting: ${registered.status}`)
  const { meeting, upload } = await registered.json()
  const put = await fetch(new URL(upload.url, base), { method: 'PUT', headers: { 'content-type': 'audio/ogg' }, body: audio })
  if (!put.ok) throw new Error(`could not upload to a meeting: ${put.status}`)
  const completed = await fetch(`${base}/api/meetings/${meeting.id}/complete`, { method: 'POST' })
  if (!completed.ok) throw new Error(`could not confirm an upload: ${completed.status}`)
  return meeting.id
}

/** A language and a clock the server cannot know, so a render that assumes them shows up. */
const VISITOR = { locale: 'de-DE', timezoneId: 'Pacific/Auckland' }

const stepper = page => page.getByRole('list', { name: 'Pipeline stages' })
const liveRegion = page => page.locator('[role=status][aria-live=polite]').last()
const pipelineOf = async (id, base = baseURL) => (await fetch(`${base}/api/meetings/${id}/pipeline`)).json()

/**
 * Finished and asked-ready, by what the server stores and by what the page says. Not by the
 * link to ask alone: that comes when the index is complete, which can be before the summary is.
 */
async function expectFinished(page, id, tabName) {
  await liveRegion(page).getByText('Finished. This meeting can be read and asked questions.').waitFor({ timeout: 60_000 })
    .catch(() => fail(`${tabName} never finished: the page may need a click`))
  if (await page.getByRole('link', { name: 'Ask on the meeting page' }).count() !== 1) fail(`${tabName} does not lead on to the meeting`)
  const answer = await pipelineOf(id)
  if (answer.status !== 'ready' || answer.next !== 'done' || answer.index.state !== 'complete') {
    fail(`${tabName}: expected ready with the index complete, saw ${JSON.stringify(answer)}`)
  }
}

/** A second tab of one browser shows the meeting moving, sends no step, and takes over when the first closes. */
async function checkASecondTab(audio) {
  const id = await seedMeeting('Two tabs', audio)
  const url = `${baseURL}/meetings/${id}/progress`
  const tabs = await browser.newContext(VISITOR)
  const gate = await gateAdvances(tabs)

  const first = await tabs.newPage()
  failOnPageErrors(first)
  const firstLog = requestsOf(first)
  await first.goto(url)
  await waitUntil(() => firstLog.count(ADVANCE) === 1, 10_000, 'the first tab did not start driving by itself')
  const heldLocks = await first.evaluate(async () => (await navigator.locks.query()).held.map(lock => lock.name))
  if (!heldLocks.includes(`meeting:${id}`)) fail(`the driving tab holds no lock named for the meeting: ${heldLocks}`)

  const second = await tabs.newPage()
  failOnPageErrors(second)
  const secondLog = requestsOf(second)
  await second.goto(url)
  await second.getByText('Another tab of this browser is doing the work').waitFor({ timeout: 10_000 })
  const queuedLocks = await second.evaluate(async () => (await navigator.locks.query()).pending.map(lock => lock.name))
  if (!queuedLocks.includes(`meeting:${id}`)) fail(`the second tab is not queued for the lock: ${queuedLocks}`)

  // One step at a time, each time looking at what the second tab shows after its next look.
  const shown = [await stepper(second).innerText()]
  for (let tries = 0; shown.length < 3 && tries < 12; tries++) {
    if (gate.held() > 0) await gate.release()
    const looks = secondLog.count(READ)
    await waitUntil(() => secondLog.count(READ) > looks, 9_000, 'the second tab stopped looking')
    await sleep(400)
    const now = await stepper(second).innerText()
    if (now !== shown.at(-1)) shown.push(now)
  }
  if (shown.length < 3) fail(`the second tab did not show the meeting moving: ${JSON.stringify(shown)}`)

  const looks = secondLog.times(READ)
  const gaps = looks.slice(1).map((at, i) => at - looks[i])
  console.log(`second tab: moved ${shown.length - 1} times, ${secondLog.count(READ)} ${READ} every ${gaps.map(gap => (gap / 1000).toFixed(1)).join(', ')} s, ${secondLog.count(ADVANCE)} ${ADVANCE}`)
  if (secondLog.count(ADVANCE) !== 0) fail(`the second tab sent ${secondLog.count(ADVANCE)} ${ADVANCE} while the first was driving`)
  if (gaps.length === 0 || gaps.some(gap => gap < 4_000 || gap > 8_000)) fail(`the second tab's looks were not about 5 s apart: ${gaps}`)
  if (firstLog.count(READ) !== 1) fail(`the driving tab polled as well: ${firstLog.count(READ)} ${READ}`)

  const closedAt = Date.now()
  await first.close()
  await gate.open()
  await waitUntil(() => secondLog.count(ADVANCE) > 0, 10_000, 'the second tab did not take over when the first closed')
  console.log(`closing the driving tab: the other sent its first ${ADVANCE} after ${Date.now() - closedAt} ms`)
  await expectFinished(second, id, 'the tab that took over')
  if (await second.getByText('Another tab of this browser is doing the work').count() !== 0) fail('the tab that took over still says it is only watching')
  console.log(`the tab that took over finished the meeting: ${secondLog.count(ADVANCE)} ${ADVANCE} of its own`)
  await tabs.close()
}

/** Nothing goes out while the page is gone, however it went, and it picks up when it comes back. */
async function checkLeavingAndComingBack(audio) {
  const id = await seedMeeting('Leaving', audio)
  const url = `${baseURL}/meetings/${id}/progress`
  const tabs = await browser.newContext(VISITOR)
  const gate = await gateAdvances(tabs)
  const page = await tabs.newPage()
  failOnPageErrors(page)
  const log = requestsOf(page)
  const advanced = n => waitUntil(() => gate.arrivals() >= n, 15_000, `expected ${n} ${ADVANCE}, saw ${gate.arrivals()}`)
  const heldLocks = () => page.evaluate(async () => (await navigator.locks.query()).held.map(lock => lock.name))

  /** Nothing sent for longer than a watching tab's poll, by what was seen. */
  async function expectSilence(ms, because) {
    const sent = log.log.length
    await sleep(ms)
    console.log(`${because}: ${log.log.length - sent} pipeline requests in ${ms / 1000} s`)
    if (log.log.length !== sent) fail(`${because}: ${JSON.stringify(log.log.slice(sent))}`)
    if ((await heldLocks()).includes(`meeting:${id}`)) fail(`${because}: the page still holds the lock`)
  }

  await page.goto(url)
  await advanced(1)
  await gate.release()
  await advanced(2)

  // A reload mid-way resumes from where it had got to, with no click.
  await page.reload()
  await advanced(3)
  console.log('a reload mid-way asked for the next step by itself:', (await pipelineOf(id)).status)

  // A route change. The step already out is left to finish; nothing new goes.
  await page.getByRole('link', { name: 'Transcript & player' }).click()
  await page.waitForURL(new RegExp(`/meetings/${id}$`), { timeout: 10_000 })
  await gate.release()
  await page.getByRole('heading', { name: 'Ask about this meeting' }).waitFor({ timeout: 10_000 })
  await expectSilence(7_000, 'after a route change')

  const beforeBack = gate.arrivals()
  await page.goBack()
  await advanced(beforeBack + 1)
  console.log('coming back resumed')

  // The back-forward cache. Playwright's Chromium runs with it off, so this sends what the
  // browser would, and it is the page's handlers that are being looked at.
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })))
  await gate.release()
  await expectSilence(6_500, 'after pagehide')
  const beforeShow = gate.arrivals()
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })))
  await advanced(beforeShow + 1)
  console.log('pageshow from the cache resumed')

  // A step is out, so the stepper is spinning, unless the visitor would rather it did not.
  const spin = () => page.evaluate(() => getComputedStyle(document.querySelector('[aria-current=step] .animate-spin')).animationName)
  await page.emulateMedia({ reducedMotion: 'reduce' })
  const reduced = await spin()
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  const normal = await spin()
  console.log(`spinner animation: ${normal}, with reduced motion: ${reduced}`)
  if (reduced !== 'none' || normal === 'none') fail(`reduced motion is not respected: ${normal}, then ${reduced}`)

  // A provider's block, as the server says it: three hours, plainly, with nothing sent.
  const waiting = (ms, status = 'transcribing') => ({ status, progress: { stage: 'transcription', done: 0, total: null, etaSeconds: null }, index: { state: 'unavailable', done: 0, total: null, retryAt: null }, next: 'wait', retryAt: new Date(Date.now() + ms).toISOString(), retryAfterMs: ms })
  const sentBeforeBlock = gate.arrivals()
  await gate.answer({ json: waiting(3 * 60 * 60_000) })
  await page.getByText('Paused: waiting for the provider', { exact: true }).waitFor({ timeout: 5_000 })
  const blockText = await page.getByText(/It carries on by itself in/).innerText()
  console.log('a block of three hours says:', blockText.match(/in [^(]+/)?.[0]?.trim())
  if (!/in (3 hours|2 hours 59 minutes)/.test(blockText)) fail(`the banner does not say how long in hours: ${blockText}`)
  if (await page.locator('[role=status]').filter({ hasText: /\d hour/ }).count() !== 0) fail('a live region holds the countdown')
  await sleep(2_500)
  if (gate.arrivals() !== sentBeforeBlock) fail('a tab told to wait three hours asked again at once')

  // The countdown moves on the screen, and the live region does not say a thing about it.
  await page.reload()
  await advanced(sentBeforeBlock + 1)
  await gate.answer({ json: waiting(40_000) })
  const countdown = page.getByText(/^Next request in \d+ seconds?\.$/)
  await countdown.waitFor({ timeout: 5_000 })
  await liveRegion(page).evaluate((region) => {
    window.liveChanges = 0
    new MutationObserver(() => window.liveChanges++).observe(region, { childList: true, characterData: true, subtree: true })
  })
  const shownThen = await countdown.innerText()
  await sleep(2_300)
  const shownLater = await countdown.innerText()
  const liveChanges = await page.evaluate(() => window.liveChanges)
  console.log(`countdown: "${shownThen}" then "${shownLater}", live region changed ${liveChanges} times`)
  if (shownThen === shownLater) fail('the countdown did not move')
  if (liveChanges !== 0) fail(`the live region changed ${liveChanges} times during a countdown`)

  // A failure stops the asking, and only a click spends the retry. Focus has somewhere to go
  // when the button it was on goes away.
  const offeredAt = gate.arrivals()
  await page.reload()
  await advanced(offeredAt + 1)
  await gate.answer({ json: { ...waiting(0), status: 'failed', next: 'continue', retryAt: null, retryAfterMs: null } })
  const retryButton = page.getByRole('button', { name: 'Try transcription again' })
  await retryButton.waitFor({ timeout: 5_000 })
  await page.getByRole('alert').getByText('Transcription did not finish').waitFor({ timeout: 5_000 })
  await sleep(1_500)
  if (gate.arrivals() !== offeredAt + 1) fail('a failure was followed by a step with no click')
  await retryButton.focus()
  await page.keyboard.press('Enter')
  await advanced(offeredAt + 2)
  await retryButton.waitFor({ state: 'detached', timeout: 5_000 })
  const focused = await page.evaluate(() => document.activeElement?.textContent?.trim())
  console.log(`a retry: a step only after the click, and focus went to "${focused}"`)
  if (focused !== 'Pipeline') fail(`after a retry, focus is on "${focused}"`)

  // The gate's 503: a plain banner, and no hurry.
  const sentBeforeRefusal = gate.arrivals()
  await page.reload()
  await advanced(sentBeforeRefusal + 1)
  const refusedAt = Date.now()
  await gate.answer({ status: 503, headers: { 'retry-after': '1' }, json: { statusCode: 503, message: 'MeetMind is not available at the moment. Try again later.' } })
  await page.getByText('MeetMind is not available at the moment', { exact: true }).waitFor({ timeout: 5_000 })
  await advanced(sentBeforeRefusal + 2)
  console.log(`a 503: asked again after ${Date.now() - refusedAt} ms`)
  if (Date.now() - refusedAt < 4_500) fail('a 503 was followed too soon')

  // A lost connection: not a failure of the meeting, and it comes back by itself.
  const lostAt = Date.now()
  await gate.abort()
  await page.getByText('Cannot reach MeetMind', { exact: true }).waitFor({ timeout: 5_000 })
  if (await page.getByRole('alert').filter({ hasText: /did not finish/ }).count() !== 0) fail('a lost connection was shown as a failure')
  await advanced(sentBeforeRefusal + 3)
  console.log(`a lost connection: asked again after ${Date.now() - lostAt} ms`)

  await gate.open()
  await expectFinished(page, id, 'a page that came back')
  console.log(`left and came back: ${log.count(ADVANCE)} ${ADVANCE}, ${log.count(READ)} ${READ}, and no click on the pipeline`)
  await tabs.close()
}

/** Plain http has no `navigator.locks`. Tabs must still not both drive, and must still take over. */
async function checkNoLockManager(audio) {
  const id = await seedMeeting('No Web Locks', audio)
  const url = `${baseURL}/meetings/${id}/progress`
  const tabs = await browser.newContext(VISITOR)
  await tabs.addInitScript(() => delete Object.getPrototypeOf(navigator).locks)
  const gate = await gateAdvances(tabs)

  const first = await tabs.newPage()
  failOnPageErrors(first)
  const firstLog = requestsOf(first)
  await first.goto(url)
  if (await first.evaluate(() => 'locks' in navigator)) fail('could not take navigator.locks away, so the fallback went untested')
  await waitUntil(() => firstLog.count(ADVANCE) === 1, 10_000, 'with no Web Locks, the first tab did not start driving')

  const second = await tabs.newPage()
  failOnPageErrors(second)
  const secondLog = requestsOf(second)
  await second.goto(url)
  await second.getByText('Another tab of this browser is doing the work').waitFor({ timeout: 10_000 })
  await waitUntil(() => secondLog.count(READ) >= 1, 8_000, 'with no Web Locks, the second tab did not look')
  await sleep(2_000)
  if (secondLog.count(ADVANCE) !== 0) fail(`with no Web Locks, the second tab sent ${secondLog.count(ADVANCE)} ${ADVANCE}`)
  const stored = await second.evaluate(() => JSON.stringify({ ...localStorage }))
  if (stored.includes(id)) fail('the stand-in for the lock left a meeting id in storage')
  console.log(`no Web Locks: second tab ${secondLog.count(READ)} ${READ}, ${secondLog.count(ADVANCE)} ${ADVANCE}`)

  // Leaving fires pagehide, which is how the lease is given back.
  await first.goto('about:blank')
  await gate.open()
  await waitUntil(() => secondLog.count(ADVANCE) > 0, 15_000, 'with no Web Locks, the second tab did not take over')
  await expectFinished(second, id, 'the tab that took over with no Web Locks')
  const leftBehind = await second.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith('meetmind.pipeline-lease')))
  if (leftBehind.length !== 0) fail(`a lease stayed behind: ${leftBehind}`)
  console.log(`no Web Locks: the other tab took over and finished, ${secondLog.count(ADVANCE)} ${ADVANCE}`)
  await tabs.close()
}

/** The demo's `/advance` can only refuse, so a visitor must not send it one. On a server that has one. */
async function checkPublicDemo(audio) {
  const entry = new URL('../.output/server/index.mjs', import.meta.url).pathname
  if (!dataDir || !existsSync(entry)) {
    console.log('public demo not checked: it takes a built server and its data directory')
    return
  }
  const id = await seedMeeting('Public demo', audio)
  const port = await new Promise((resolve, reject) => {
    const probe = createServer()
    probe.once('error', reject)
    probe.listen(0, () => {
      const { port: free } = probe.address()
      probe.close(() => resolve(free))
    })
  })
  const demoBase = `http://localhost:${port}`
  // The same data, and the same blanks as the job's own server, plus the one setting.
  const server = spawn(process.execPath, [entry], {
    stdio: 'ignore',
    env: {
      ...process.env,
      PORT: String(port),
      NUXT_DATA_DIR: dataDir,
      NUXT_ALLOW_LOCAL_DRIVERS: 'true',
      NUXT_UPLOAD_TOKEN_SECRET: 'ci-secret',
      NUXT_PUBLIC_DEMO_MEETING_ID: id,
      NUXT_GROQ_API_KEY: '',
      NUXT_WORKERS_AI_ACCOUNT_ID: '',
      NUXT_WORKERS_AI_API_TOKEN: '',
      NUXT_SUPABASE_URL: '',
      NUXT_SUPABASE_SERVICE_KEY: '',
      NUXT_R2_ACCOUNT_ID: '',
      NUXT_R2_ACCESS_KEY_ID: '',
      NUXT_R2_SECRET_ACCESS_KEY: '',
      NUXT_R2_BUCKET: '',
    },
  })
  try {
    await waitUntil(() => fetch(`${demoBase}/api/health`).then(res => res.ok, () => false), 30_000, 'the demo\'s server did not start')
    const refused = await fetch(`${demoBase}/api/meetings/${id}/advance`, { method: 'POST' })
    if (refused.status !== 403) fail(`this was meant to be the demo, and /advance answered ${refused.status}`)

    const visitor = await browser.newContext(VISITOR)
    const page = await visitor.newPage()
    failOnPageErrors(page)
    const log = requestsOf(page)
    await page.goto(`${demoBase}/meetings/${id}/progress`)
    await page.getByText('This demo meeting is read-only', { exact: true }).waitFor({ timeout: 10_000 })
    await sleep(6_500)
    console.log(`public demo, not finished: ${log.count(ADVANCE)} ${ADVANCE}, ${log.count(READ)} ${READ} in 6.5 s`)
    if (log.log.length !== 0) fail(`the demo's page asked for something: ${JSON.stringify(log.log)}`)
    const locks = await page.evaluate(async () => {
      const { held, pending } = await navigator.locks.query()
      return [...held, ...pending].length
    })
    if (locks !== 0) fail(`the demo's page holds or queues for ${locks} locks`)
    if (await page.getByRole('button', { name: /again|rebuild|carry on|start|resume/i }).count() !== 0) fail('the demo\'s page offers a way to take a step')
    const said = await liveRegion(page).innerText()
    if (!/public demo.*read-only/.test(said)) fail(`the live region says: ${said}`)
    const { status } = await pipelineOf(id, demoBase)
    if (status !== 'uploaded') fail(`the demo moved: ${status}`)
    await visitor.close()
  }
  finally {
    server.kill()
  }
}

const browser = await chromium.launch({
  headless: true,
  ...(process.env.BROWSER_CHANNEL ? { channel: process.env.BROWSER_CHANNEL } : {}),
})
// Clipboard access, for reading back what the Copy link control copied.
const context = await browser.newContext({ ...VISITOR, permissions: ['clipboard-read', 'clipboard-write'] })
const page = await context.newPage()
const consoleLines = []
page.on('console', m => consoleLines.push(`[console:${m.type()}] ${m.text()}`))
failOnPageErrors(page)
// From the upload on. The page drives by itself, so without this it could be past `uploaded`
// before anything below looks.
const firstGate = await gateAdvances(context)
const firstTab = requestsOf(page)
const answers = []
page.on('response', async (response) => {
  if (!/\/advance$/.test(new URL(response.url()).pathname) || response.status() !== 200) return
  answers.push(await response.json().catch(() => null))
})

try {
  await page.goto(`${baseURL}/`, { waitUntil: 'networkidle' })

  // Uploading is invite-only (ADR-0015): a wrong code fails at once, before any
  // recording can be chosen, and the right one opens that step.
  const recordingInputs = page.locator('input[type=file]')
  if (await recordingInputs.count() !== 0) fail('a recording can be chosen before any code is checked')
  const codeField = page.getByLabel('Invite code')
  const wrongCode = 'not-the-invite-code-not-the-invite-code'
  await codeField.fill(wrongCode)
  await page.getByRole('button', { name: 'Continue' }).click()
  await page.getByRole('alert').filter({ hasText: 'valid invite code' }).waitFor({ timeout: 5_000 })
  if (await recordingInputs.count() !== 0) fail('a wrong code still offered a recording to choose')
  console.log('a wrong code was refused at once')

  await codeField.fill(inviteCode)
  await page.getByRole('button', { name: 'Continue' }).click()
  await recordingInputs.waitFor({ state: 'attached', timeout: 5_000 })
  console.log('the right code opened the recording step')

  // Nowhere a later visitor, or a log, could read it back. Page memory only.
  const kept = await page.evaluate(() => JSON.stringify([location.href, { ...localStorage }, { ...sessionStorage }, document.cookie]))
  if (kept.includes(inviteCode) || kept.includes(wrongCode)) fail('an invite code reached the URL, storage or a cookie')
  if (consoleLines.some(line => line.includes(inviteCode) || line.includes(wrongCode))) fail('an invite code reached the console')

  // The file input must be reachable by name, not just by CSS selector.
  const namedInput = page.getByRole('button', { name: 'Choose a meeting recording' })
    .or(page.getByLabel('Choose a meeting recording'))
  if (await namedInput.count() === 0) fail('the recording file input has no accessible name')
  else console.log('file input exposes an accessible name')

  await page.locator('input[type=file]').setInputFiles(fixturePath)
  await page.getByRole('button', { name: 'Extract audio' }).click()
  await page.getByRole('heading', { name: 'Audio ready to upload' }).waitFor({ timeout: 240_000 })
  console.log('extracted:', (await page.locator('p', { hasText: /Compressed to \d/ }).innerText()).replace(/\s+/g, ' '))

  // Picking a DIFFERENT recording must discard the audio already extracted —
  // otherwise the old blob would be stored under the new file's metadata.
  // (Re-picking the same path is a no-op: browsers fire no change event.)
  const readyCard = page.getByRole('heading', { name: 'Audio ready to upload' })
  const decoy = join(mkdtempSync(join(tmpdir(), 'meetmind-drive-')), 'other-recording.mp4')
  copyFileSync(fixturePath, decoy)
  await page.locator('input[type=file]').setInputFiles(decoy)
  try {
    await readyCard.waitFor({ state: 'hidden', timeout: 5_000 })
    console.log('switching recordings cleared the staged audio')
  }
  catch {
    fail('selecting a different file left the previously extracted audio staged')
  }

  // Back to the real fixture, and extract it for the upload below.
  await page.locator('input[type=file]').setInputFiles(fixturePath)
  await page.getByRole('button', { name: 'Extract audio' }).click()
  await readyCard.waitFor({ timeout: 240_000 })

  const title = page.getByRole('textbox', { name: 'Meeting title' })
  console.log('default title:', await title.inputValue())
  await title.fill('Drive-script upload')
  await page.getByRole('button', { name: 'Upload audio & continue' }).click()

  await page.waitForURL(/\/meetings\/[0-9a-f-]{36}\/progress$/, { timeout: 60_000 })
  const meetingId = page.url().match(/meetings\/([0-9a-f-]{36})/)[1]
  console.log('landed on progress page for', meetingId)
  await page.getByRole('heading', { name: 'Drive-script upload' }).waitFor({ timeout: 10_000 })
  const badge = (await page.locator('span', { hasText: /^\s*uploaded\s*$/i }).first().innerText()).trim()
  console.log('status badge:', badge)
  if (!/uploaded/i.test(badge)) fail(`expected status badge "uploaded", saw "${badge}"`)

  const { meeting } = await (await fetch(`${baseURL}/api/meetings/${meetingId}`)).json()
  console.log('meeting row:', JSON.stringify(meeting, null, 2))
  if (meeting.status !== 'uploaded') fail(`row status is ${meeting.status}`)
  if (!meeting.uploadedAt) fail('row has no uploadedAt')

  if (dataDir) {
    const audioRoot = join(dataDir, 'audio')
    const objectPath = join(audioRoot, ...meeting.audioKey.split('/'))
    const size = statSync(objectPath).size
    console.log(`stored object: ${objectPath} (${size} bytes)`)
    if (size !== meeting.audioBytes) fail(`stored ${size} bytes but row says ${meeting.audioBytes}`)

    // Privacy invariant: only audio (and its sidecar) ever lands in storage.
    const files = readdirSync(audioRoot, { recursive: true })
      .filter(f => statSync(join(audioRoot, f)).isFile())
    const offenders = files.filter(f => !/audio\.ogg(\.meta)?$/.test(f))
    console.log(`files in audio store: ${files.length}${offenders.length ? ` — unexpected: ${offenders.join(', ')}` : ''}`)
    if (offenders.length) fail('non-audio files found in the audio store')

    try {
      const probe = execFileSync('ffprobe', [
        '-v', 'error', '-show_entries', 'format=format_name,duration:stream=codec_name,channels,sample_rate',
        '-of', 'default=noprint_wrappers=1', objectPath,
      ]).toString().trim()
      console.log('ffprobe:\n' + probe)
      if (!/codec_name=opus/.test(probe)) fail('stored object is not Opus')
    }
    catch (err) {
      console.log('ffprobe skipped:', err.message.split('\n')[0])
    }
  }

  // Nothing has been clicked since the upload, and from here on nothing is. The page has
  // already read where the meeting stands and asked for its first step, by itself.
  await waitUntil(() => firstTab.count(ADVANCE) === 1, 10_000, 'the page did not ask for a step by itself')
  // One for the page's first render, arriving by client-side navigation, and one by the driver.
  if (firstTab.count(READ) > 2) fail(`expected at most two reads before the first step, saw ${firstTab.count(READ)}`)
  for (const label of ['Start transcription', 'Extract decisions & action items', 'Index for questions', 'Resume transcription', 'Resume extraction']) {
    if (await page.getByRole('button', { name: label }).count() !== 0) fail(`the page still offers "${label}"`)
  }
  console.log('the page asked for its first step with no click')

  await firstGate.open()
  await expectFinished(page, meetingId, 'the driving tab')
  await page.getByRole('heading', { name: 'Transcript' }).waitFor({ timeout: 10_000 })

  // What the driving was, by what actually went out.
  console.log(`no clicks: ${firstTab.count(ADVANCE)} ${ADVANCE}, ${firstTab.count(READ)} ${READ}`)
  for (const route of ['POST /transcribe', 'POST /summarize', 'POST /search-index']) {
    if (firstTab.count(route) !== 0) fail(`the page sent ${route}; only /advance should move a meeting`)
  }
  if (firstTab.count(ADVANCE) < 3) fail(`expected several steps, saw ${firstTab.count(ADVANCE)}`)
  const STATUS_ORDER = ['uploaded', 'transcribing', 'summarizing', 'indexing', 'ready']
  const statuses = answers.map(answer => answer?.status)
  console.log('statuses the steps answered:', [...new Set(statuses)].join(' -> '))
  if (statuses.some((status, i) => STATUS_ORDER.indexOf(status) < STATUS_ORDER.indexOf(statuses[i - 1] ?? 'uploaded'))) {
    fail(`the statuses went backwards: ${statuses.join(', ')}`)
  }
  for (const status of ['transcribing', 'ready']) {
    if (!statuses.includes(status)) fail(`no step answered ${status}: ${statuses.join(', ')}`)
  }
  if (answers.at(-1)?.next !== 'done') fail(`the last step answered ${JSON.stringify(answers.at(-1))}`)

  const { segments } = await (await fetch(`${baseURL}/api/meetings/${meetingId}/transcript`)).json()
  console.log(`transcript stored: ${segments.length} segments`)
  if (!segments.length) fail('transcription produced no segments')

  let previousStart = -1
  for (const [i, segment] of segments.entries()) {
    if (segment.idx !== i) fail(`segment ${i} has idx ${segment.idx}`)
    if (segment.startMs < previousStart) fail('segment start times are not ordered')
    if (segment.endMs < segment.startMs) fail(`segment ${i} ends before it starts`)
    if (!segment.text.trim()) fail(`segment ${i} has no text`)
    previousStart = segment.startMs
  }
  console.log('segments are ordered, gapless and non-empty')

  // The stage list must not claim more or less than the truth, and says so in words.
  const STAGES = ['Audio uploaded', 'Transcribed', 'Summarized', 'Indexed for questions']
  const listText = await stepper(page).locator('li').allInnerTexts()
  const stages = STAGES.filter(label => listText.some(t => t.includes(label) && t.includes('Done')))
  if (stages.length !== STAGES.length) {
    fail(`the pipeline does not say these are done: ${STAGES.filter(l => !stages.includes(l)).join(', ')}`)
  }
  console.log(`pipeline stages done, in words: ${stages.length}/${STAGES.length}`)

  // Completion has to be announced somewhere that stays mounted.
  const announced = await liveRegion(page).innerText()
  if (!/Finished\. This meeting can be read and asked questions\./.test(announced)) {
    fail(`completion was not announced; the live region said: ${announced}`)
  }
  console.log('completion announced to assistive tech')

  // The first segment's timestamp must render in the transcript panel.
  const firstStamp = await page.locator('li span.font-mono').first().innerText()
  console.log('first transcript timestamp rendered as', firstStamp)

  const { summary } = await (await fetch(`${baseURL}/api/meetings/${meetingId}/summary`)).json()
  if (!summary) fail('extraction produced no summary')
  else {
    console.log(`summary stored: ${summary.decisions.length} decisions, ${summary.actionItems.length} action items`)

    // Every citation must point at a segment that exists and begin there, using
    // the same contract reconciliation itself checks against -- see
    // quoteStartsAt in lib/citation-match.mjs.
    const { segments: lines } = await (await fetch(`${baseURL}/api/meetings/${meetingId}/transcript`)).json()
    const byIdx = new Map(lines.map(l => [l.idx, l]))
    for (const item of [...summary.decisions, ...summary.actionItems]) {
      const cited = byIdx.get(item.segmentIdx)
      if (!cited) fail(`an item cites segment ${item.segmentIdx}, which does not exist`)
      // The COMPLETE quote (not just a prefix) via the same rules
      // reconciliation itself checks against.
      else if (!quoteStartsAt(lines, item.segmentIdx, item.quote)) {
        fail(`an item quotes text that does not begin at segment ${item.segmentIdx}`)
      }
    }
    console.log('every citation resolves to a real transcript segment')
  }

  const { meeting: summarized } = await (await fetch(`${baseURL}/api/meetings/${meetingId}`)).json()
  console.log('status after extraction:', summarized.status)
  if (summarized.status !== 'ready') fail(`expected status ready, saw ${summarized.status}`)

  // Questions (ADR-0007): the index got finished along the way. Ask on the meeting page
  // through the real form, and check the cited line against the transcript the server
  // serves, then that clicking it moves the player there.
  const { index } = await (await fetch(`${baseURL}/api/meetings/${meetingId}/search-index`)).json()
  console.log(`search index: ${index.state}, ${index.indexedCount}/${index.windowCount} windows, model ${index.model}`)
  if (index.state !== 'ready' || index.windowCount === 0) fail('indexing did not leave a ready, non-empty index')

  await page.getByRole('link', { name: 'Ask on the meeting page' }).click()
  await page.waitForURL(new RegExp(`/meetings/${meetingId}$`), { timeout: 10_000 })
  const questionBox = page.getByRole('textbox', { name: 'Your question' })
  await questionBox.waitFor({ timeout: 10_000 })
  // The stub transcriber's lines all say what the placeholder stands in for.
  await questionBox.fill('What does the placeholder stand in for?')
  await page.getByRole('button', { name: 'Ask', exact: true }).click()
  const citationButtons = page.locator('section[aria-labelledby="answer-heading"] li button')
  await citationButtons.first().waitFor({ timeout: 30_000 })

  const cited = await citationButtons.evaluateAll(buttons => buttons.map(b => ({
    stamp: b.querySelector('span')?.textContent?.trim(),
    quote: b.querySelector('q')?.textContent?.trim(),
  })))
  console.log(`answer cites ${cited.length} line(s); first: ${cited[0]?.stamp} "${cited[0]?.quote?.slice(0, 50)}…"`)
  const focusedOnAnswer = await page.evaluate(() => document.activeElement?.id === 'answer-heading')
  console.log('focus moved to the answer:', focusedOnAnswer)
  if (!focusedOnAnswer) fail('asking did not move focus to the answer')

  const { segments: servedSegments } = await (await fetch(`${baseURL}/api/meetings/${meetingId}/transcript`)).json()
  for (const c of cited) {
    const line = servedSegments.find(s => quoteStartsAt(servedSegments, s.idx, c.quote ?? ''))
    if (!line) fail(`answer cites a quote that is not in the transcript: "${c.quote}"`)
  }
  console.log('every answer citation is a real transcript line')

  const target = servedSegments.find(s => quoteStartsAt(servedSegments, s.idx, cited.at(-1)?.quote ?? ''))
  // Park the player far from the cited line first. Resetting to 0 would make
  // this check pass without the click doing anything whenever the citation is
  // the first line, which starts at 0:00.
  const parkedAt = await page.evaluate(async (targetSec) => {
    const audio = document.querySelector('audio')
    if (!Number.isFinite(audio.duration)) {
      await new Promise(resolve => audio.addEventListener('loadedmetadata', resolve, { once: true }))
    }
    audio.pause()
    audio.currentTime = targetSec < audio.duration / 2 ? audio.duration - 0.5 : 0
    await new Promise(resolve => setTimeout(resolve, 150))
    return audio.currentTime
  }, target.startMs / 1000)
  if (Math.abs(parkedAt - target.startMs / 1000) < 5) fail('could not park the player away from the cited line, so seeking went untested')
  await citationButtons.last().click()
  await page.waitForTimeout(400)
  const seekedTo = await page.evaluate(() => document.querySelector('audio').currentTime)
  console.log(`clicking the citation moved the player to ${seekedTo.toFixed(2)}s (line starts at ${(target.startMs / 1000).toFixed(2)}s)`)
  if (Math.abs(seekedTo - target.startMs / 1000) > 1.5) fail('clicking an answer citation did not seek to its line')

  // The link to keep is the meeting's own, whichever page copies it.
  await page.getByRole('button', { name: 'Copy link' }).click()
  await page.getByText('Link copied.').waitFor({ timeout: 5_000 })
  const copied = await page.evaluate(() => navigator.clipboard.readText())
  console.log('copied link:', copied)
  if (copied !== `${baseURL}/meetings/${meetingId}`) fail(`Copy link copied ${copied}`)

  // Your meetings (ADR-0013): this browser remembers the upload...
  const listed = page.getByRole('link', { name: /Drive-script upload/ })
  await page.goto(`${baseURL}/meetings`, { waitUntil: 'networkidle' })
  await listed.first().waitFor({ timeout: 10_000 })
  console.log('Your meetings lists the upload')

  // ...and nothing else does. The server's copy of this page holds no id, and the
  // list comes back empty once this browser's storage is gone: the check a list
  // still fed by the server would fail.
  const served = await (await fetch(`${baseURL}/meetings`)).text()
  if (served.includes(meetingId)) fail('the server-rendered meetings page carries the meeting id')
  await page.evaluate(() => localStorage.clear())
  await page.reload({ waitUntil: 'networkidle' })
  if (await listed.count() !== 0) fail('the meeting is still listed with this browser\'s storage cleared')
  console.log('cleared storage, cleared list')

  // Corrupt storage must leave a working page, not an error page.
  await page.evaluate(() => localStorage.setItem('meetmind.your-meetings.v1', '{not json'))
  await page.reload({ waitUntil: 'networkidle' })
  await page.getByText('No meetings uploaded from this browser').waitFor({ timeout: 5_000 })
  console.log('corrupt storage renders as an empty list')

  const audio = new Uint8Array(await (await fetch(`${baseURL}/api/meetings/${meetingId}/audio`)).arrayBuffer())
  await checkASecondTab(audio)
  await checkLeavingAndComingBack(audio)
  await checkNoLockManager(audio)
  await checkPublicDemo(audio)
}
catch (err) {
  fail(err.message)
  console.log('recent console output:\n' + consoleLines.slice(-20).join('\n'))
}
finally {
  await browser.close()
}
console.log(process.exitCode ? '\nRESULT: FAIL' : '\nRESULT: PASS')
