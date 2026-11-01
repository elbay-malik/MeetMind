// Drives the real upload flow in headless Chromium: drop a fixture on "/",
// extract audio in-browser, upload it, land on the progress page, then check
// what actually reached storage. Phase 3 acceptance check; seed for Phase 12.
//
// Usage: node scripts/drive-upload.mjs <baseURL> [fixturePath] [dataDir]
//   dataDir: the server's NUXT_DATA_DIR — when given, the stored object is
//   inspected on disk (size, ffprobe if available, and "no video" invariant).
// Requires a running server (pnpm dev / preview). BROWSER_CHANNEL=chrome|msedge
// picks a system browser instead of Playwright's bundled Chromium.
import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdtempSync, readdirSync, statSync } from 'node:fs'
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

/** Poll the meeting's real status via the API instead of a transient UI label. */
async function waitForMeetingStatus(meetingId, predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const { meeting } = await (await fetch(`${baseURL}/api/meetings/${meetingId}`)).json()
    if (predicate(meeting.status)) return meeting
    if (Date.now() >= deadline) throw new Error(`timed out waiting for meeting ${meetingId} status`)
    await new Promise(resolve => setTimeout(resolve, 500))
  }
}

const browser = await chromium.launch({
  headless: true,
  ...(process.env.BROWSER_CHANNEL ? { channel: process.env.BROWSER_CHANNEL } : {}),
})
// Clipboard access, for reading back what the Copy link control copied.
const context = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] })
const page = await context.newPage()
const consoleLines = []
page.on('console', m => consoleLines.push(`[console:${m.type()}] ${m.text()}`))
page.on('pageerror', e => consoleLines.push(`[pageerror] ${e.message}`))

try {
  await page.goto(`${baseURL}/`, { waitUntil: 'networkidle' })

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

  // Transcription: on-demand until the pipeline is orchestrated in a later phase.
  const startButton = page.getByRole('button', { name: 'Start transcription' })
  await startButton.waitFor({ timeout: 10_000 })
  await startButton.click()
  await page.getByRole('heading', { name: 'Transcript' }).waitFor({ timeout: 120_000 })

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

  // The stage list must not claim more or less than the truth. Scoped to the
  // FIRST <ol> specifically — the pipeline card, which renders before the
  // transcript card in the DOM — not every <ol> on the page: the transcript
  // is also an ordered list, and a real transcript segment containing the
  // word "Indexing" would otherwise fail this for a reason that has nothing
  // to do with the pipeline.
  const STAGES = ['Audio uploaded', 'Transcribed', 'Summarized']
  const listText = await page.locator('ol').first().locator('li').allInnerTexts()
  const stages = STAGES.filter(label => listText.some(t => t.includes(label)))
  if (stages.length !== STAGES.length) {
    fail(`pipeline is missing stages: ${STAGES.filter(l => !stages.includes(l)).join(', ')}`)
  }
  console.log(`pipeline stages rendered: ${stages.length}/${STAGES.length}`)
  // Nothing indexes anything yet (that is Phase 9) — the pipeline must not
  // claim a stage that does not exist.
  if (listText.some(t => t.includes('Indexing'))) {
    fail('pipeline shows an "Indexing" stage, but nothing indexes anything yet')
  }

  // Completion has to be announced somewhere that stays mounted.
  const announced = await page.locator('[role=status]').allInnerTexts()
  if (!announced.some(t => /Transcription finished with \d+ segments/.test(t))) {
    fail(`completion was not announced; live regions said: ${JSON.stringify(announced)}`)
  }
  console.log('completion announced to assistive tech')

  const { meeting: transcribed } = await (await fetch(`${baseURL}/api/meetings/${meetingId}`)).json()
  console.log('status after transcription:', transcribed.status)
  if (transcribed.status !== 'summarizing') fail(`expected status summarizing, saw ${transcribed.status}`)

  // The first segment's timestamp must render in the transcript panel.
  const firstStamp = await page.locator('li span.font-mono').first().innerText()
  console.log('first transcript timestamp rendered as', firstStamp)

  // Extraction: on demand until the pipeline is orchestrated in a later phase.
  const summaryButton = page.getByRole('button', { name: /Extract decisions/ })
  await summaryButton.waitFor({ timeout: 10_000 })
  await summaryButton.click()
  // Polling the actual meeting status rather than a transient UI label: the
  // "Extracting decisions" text can be briefly absent right after the click,
  // before Vue has even rendered it — a predicate that only checks for its
  // ABSENCE can pass on that very first poll, before extraction has even
  // started, let alone finished.
  await waitForMeetingStatus(meetingId, s => s === 'ready' || s === 'failed', 120_000)

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

  // Questions (ADR-0007): index from the progress page, then ask on the meeting
  // page through the real form, and check the cited line against the transcript
  // the server serves — then that clicking it moves the player there.
  const indexButton = page.getByRole('button', { name: 'Index for questions' })
  await indexButton.waitFor({ timeout: 10_000 })
  await indexButton.click()
  // Right after indexing, the live region announces completion rather than the
  // resting "Ready for questions" text; wait for the next action to appear.
  await page.getByRole('link', { name: 'Ask on the meeting page' }).waitFor({ timeout: 30_000 })
  const indexAnnouncement = (await page.locator('[role="status"]').allTextContents()).join(' ')
  console.log('indexing announced:', /Indexing finished/.test(indexAnnouncement))
  if (!/Indexing finished/.test(indexAnnouncement)) fail('indexing finished without announcing it to assistive tech')
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
}
catch (err) {
  fail(err.message)
  console.log('recent console output:\n' + consoleLines.slice(-20).join('\n'))
}
finally {
  await browser.close()
}
console.log(process.exitCode ? '\nRESULT: FAIL' : '\nRESULT: PASS')
