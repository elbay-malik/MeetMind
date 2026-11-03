// What `pnpm deploy:worker` does, apart from running anything, so a test can drive every way
// through it with no wrangler and no Cloudflare: tests/unit/deploy-scripts.spec.ts.
import { access, readFile } from 'node:fs/promises'
import { join } from 'node:path'

/** How nitro.json names the preset that NITRO_PRESET=cloudflare_module builds. */
const WORKER_PRESETS = ['cloudflare-module', 'cloudflare_module']

/**
 * Why this build must not be deployed, or null when it can be. A Node build has no Worker in it,
 * and a wasm left in its assets is over the 25 MiB limit (ADR-0018).
 */
export async function workerBuildProblem(rootDir) {
  let preset
  try {
    preset = JSON.parse(await readFile(join(rootDir, '.output/nitro.json'), 'utf8')).preset
  }
  catch {
    return '.output/nitro.json could not be read, so this is not a finished build'
  }
  if (!WORKER_PRESETS.includes(preset)) return `.output is a ${preset} build, not cloudflare_module`
  const wasm = '.output/public/ffmpeg/ffmpeg-core.wasm'
  const present = await access(join(rootDir, wasm)).then(() => true, () => false)
  if (present) return `${wasm} is among the assets, which it is over the limit for`
  return null
}

/**
 * Build for Workers, refuse what `problem` refuses, deploy, and then put the Node build back,
 * whatever happened: the e2e and browser jobs need it, and a Worker build left behind would
 * invite a `wrangler dev` here. `run` answers an exit code. Answers this process's own.
 */
export async function deployWorker({ run, problem, log }) {
  let code = 1
  try {
    const built = run('pnpm', ['build'], { NITRO_PRESET: 'cloudflare_module' })
    if (built !== 0) {
      log(`FAIL: the Worker build exited with ${built}, so nothing was deployed.`)
      code = built
    }
    else {
      const wrong = await problem()
      if (wrong) {
        log(`FAIL: ${wrong}. Nothing was deployed.`)
      }
      else {
        code = run('pnpm', ['exec', 'wrangler', 'deploy'], {})
        if (code !== 0) log(`FAIL: wrangler deploy exited with ${code}.`)
      }
    }
  }
  finally {
    log('Putting the Node build back.')
    const back = run('pnpm', ['build'], { NITRO_PRESET: undefined })
    if (back !== 0) {
      log(`FAIL: the Node build exited with ${back}. Run pnpm build before the e2e or browser jobs.`)
      if (code === 0) code = back
    }
  }
  return code
}
