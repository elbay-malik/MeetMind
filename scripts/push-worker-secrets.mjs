// `pnpm secrets:worker`: pipes ONLY the secrets named in scripts/lib/worker-secrets.mjs from .env
// into `wrangler secret bulk`, refuses a missing one, and prints names only. It changes the live
// Worker, and creates a placeholder one if there is none yet.
//
// Never `wrangler secret bulk .env`: that uploads every key in the file, the wrangler token and
// the database URL included. Anything not on the list goes by hand: `wrangler secret put <name>`.
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { pushWorkerSecrets } from './lib/worker-secrets.mjs'

const rootDir = fileURLToPath(new URL('..', import.meta.url))

process.exitCode = pushWorkerSecrets({
  envText: readFileSync(join(rootDir, '.env'), 'utf8'),
  run(command, args, input) {
    // Debug logging and turning off wrangler's sanitising are the only ways it could print a value.
    const env = { ...process.env, WRANGLER_LOG: undefined, WRANGLER_LOG_SANITIZE: undefined }
    const { status, error } = spawnSync(command, args, { cwd: rootDir, input, stdio: ['pipe', 'inherit', 'inherit'], env })
    if (error) throw error
    return status ?? 1
  },
  log: console.log,
})
