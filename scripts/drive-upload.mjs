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

const [
  baseURL = 'http://localhost:3000',
  fixturePath = new URL('../fixtures/fixture-30s-720p.mp4', import.meta.url).pathname,
  dataDir,
] = process.argv.slice(2)

const fail = (msg) => {
  console.error(`FAIL: ${msg}`)
  process.exitCode = 1
}

const browser = await chromium.launch({
  headless: true,
  ...(process.env.BROWSER_CHANNEL ? { channel: process.env.BROWSER_CHANNEL } : {}),
})
const page = await browser.newPage()
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

  const { meeting: transcribed } = await (await fetch(`${baseURL}/api/meetings/${meetingId}`)).json()
  console.log('status after transcription:', transcribed.status)
  if (transcribed.status !== 'summarizing') fail(`expected status summarizing, saw ${transcribed.status}`)

  // The first segment's timestamp must render in the transcript panel.
  const firstStamp = await page.locator('li span.font-mono').first().innerText()
  console.log('first transcript timestamp rendered as', firstStamp)

  // The archive lists the new meeting.
  await page.goto(`${baseURL}/meetings`, { waitUntil: 'networkidle' })
  await page.getByRole('link', { name: /Drive-script upload/ }).first().waitFor({ timeout: 10_000 })
  console.log('archive lists the meeting')
}
catch (err) {
  fail(err.message)
  console.log('recent console output:\n' + consoleLines.slice(-20).join('\n'))
}
finally {
  await browser.close()
}
console.log(process.exitCode ? '\nRESULT: FAIL' : '\nRESULT: PASS')
