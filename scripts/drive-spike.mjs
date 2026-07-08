// Drives /spike/ffmpeg in headless Chrome and prints the measurements table.
// Used to collect the numbers recorded in docs/adr/0002-ffmpeg-spike-results.md.
//
// Usage: node scripts/drive-spike.mjs <baseURL> <runsSpec> [fixturePath]
//   runsSpec: comma-separated run tokens, e.g. "workerfs,workerfs,memfs".
//   Append ":escape" to a token to enable the self-hosted class-worker toggle.
// Requires a running server (pnpm dev or pnpm preview) and system Chrome.
import { chromium } from 'playwright-core'

const [
  baseURL = 'http://localhost:3000',
  runsSpec = 'workerfs',
  fixturePath = new URL('../fixtures/fixture-30s-720p.mp4', import.meta.url).pathname,
] = process.argv.slice(2)
const runs = runsSpec.split(',')

const browser = await chromium.launch({ channel: 'chrome', headless: true })
const page = await browser.newPage()
const consoleLines = []
page.on('console', m => consoleLines.push(`[console:${m.type()}] ${m.text()}`))
page.on('pageerror', e => consoleLines.push(`[pageerror] ${e.message}`))

await page.goto(`${baseURL}/spike/ffmpeg`, { waitUntil: 'networkidle' })

for (const [i, token] of runs.entries()) {
  const [mode, ...flags] = token.split(':')
  const escape = flags.includes('escape')

  const setSwitch = async (sw, want) => {
    const on = (await sw.getAttribute('aria-checked')) === 'true'
    if (on !== want) await sw.click()
  }
  await setSwitch(page.getByRole('switch', { name: /MEMFS copy/ }), mode === 'memfs')
  await setSwitch(page.getByRole('switch', { name: /Self-hosted class worker/ }), escape)

  await page.locator('input[type=file]').setInputFiles(fixturePath)
  await page.getByRole('button', { name: 'Extract audio' }).click()

  const outcome = await Promise.race([
    page.getByRole('link', { name: 'Download output.ogg' })
      .waitFor({ timeout: 240_000 }).then(() => 'done'),
    page.getByText('Extraction failed').waitFor({ timeout: 240_000 }).then(() => 'error'),
  ]).catch(() => 'timeout')

  console.log(`\n=== run ${i + 1}/${runs.length} (${token}) -> ${outcome} ===`)
  if (outcome === 'done') {
    const resultText = await page.locator('p', { hasText: 'Opus 16 kHz mono' }).first().innerText()
    console.log(resultText.replace(/\s+/g, ' ').trim())
  }
  if (outcome === 'error') {
    console.log(await page.getByText('Extraction failed').locator('..').innerText())
  }
  if (outcome === 'timeout') {
    console.log('TIMED OUT waiting for done/error. Recent console output:')
    console.log(consoleLines.slice(-25).join('\n'))
    break
  }
}

// Save the last run's output for external validation (ffprobe etc.)
const savePath = process.env.SPIKE_SAVE_OUTPUT
if (savePath) {
  const downloadPromise = page.waitForEvent('download')
  await page.getByRole('link', { name: 'Download output.ogg' }).click()
  const download = await downloadPromise
  await download.saveAs(savePath)
  console.log(`\noutput saved to ${savePath}`)
}

const tables = await page.locator('pre').allInnerTexts()
console.log('\n=== measurements table ===')
console.log(tables.at(-1) ?? '(none)')

if (consoleLines.length) {
  console.log('\n=== console tail ===')
  console.log(consoleLines.slice(-15).join('\n'))
}

await browser.close()
