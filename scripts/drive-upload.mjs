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
import { readdirSync, statSync } from 'node:fs'
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
  await page.locator('input[type=file]').setInputFiles(fixturePath)
  await page.getByRole('button', { name: 'Extract audio' }).click()
  await page.getByRole('heading', { name: 'Audio ready to upload' }).waitFor({ timeout: 240_000 })
  console.log('extracted:', (await page.locator('p', { hasText: /Compressed to \d/ }).innerText()).replace(/\s+/g, ' '))

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
