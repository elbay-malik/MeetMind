// Puts the installed ffmpeg wasm in the private bucket, where the route serves it from on a
// Worker (ADR-0018). A step of the first deploy, and of every upgrade of @ffmpeg/core: run it
// BEFORE deploying the new version, and leave the old key there so a rollback still finds its
// file. Changes the real bucket. Nothing else runs this, and the only test that does has a stand-in for pnpm.
//
// Usage: pnpm upload:ffmpeg-wasm
import { spawnSync } from 'node:child_process'
import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const BUCKET = 'meet-mind'
const rootDir = fileURLToPath(new URL('..', import.meta.url))
const coreDir = join(rootDir, 'node_modules/@ffmpeg/core')

const installed = JSON.parse(readFileSync(join(coreDir, 'package.json'), 'utf8')).version
const source = readFileSync(join(rootDir, 'shared/utils/ffmpeg-core.ts'), 'utf8')
const constant = /^export const FFMPEG_CORE_VERSION = '([^']+)'$/m.exec(source)?.[1]
if (constant !== installed) {
  console.error(`FAIL: shared/utils/ffmpeg-core.ts says ${constant}, and @ffmpeg/core ${installed} is installed. The route would serve another version's file.`)
  process.exit(1)
}

const file = join(coreDir, 'dist/esm/ffmpeg-core.wasm')
const key = `assets/ffmpeg/${installed}/ffmpeg-core.wasm`
console.log(`uploading ${statSync(file).size} bytes to ${BUCKET}/${key}`)
const { status, error } = spawnSync('pnpm', ['exec', 'wrangler', 'r2', 'object', 'put', `${BUCKET}/${key}`, '--file', file, '--content-type', 'application/wasm', '--remote'], { cwd: rootDir, stdio: 'inherit' })
if (error) throw error
process.exit(status ?? 1)
