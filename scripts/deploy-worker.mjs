// `pnpm deploy:worker`: builds for Workers, refuses a build that is not one or that still has the
// wasm among its assets, runs wrangler deploy, and puts the Node build back even on failure or a
// Ctrl-C. It changes the live Worker. See README's "Deploying the Worker" for what comes before
// and after.
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { deployWorker, workerBuildProblem } from './lib/deploy-worker.mjs'

const rootDir = fileURLToPath(new URL('..', import.meta.url))

/** What a shell answers for a command each of these stopped, and the ones to outlast. */
const SIGNAL_CODES = { SIGHUP: 129, SIGINT: 130, SIGTERM: 143 }

let current = null
let interruptedBy = null
let restoring = false

// With no handler a signal ends this process where it stands, and the Node build is never put
// back. So one stops whatever is running, and the steps go on from there to that build, which
// is left alone: Ctrl-C in a terminal reaches it anyway, and only then does the build stay
// behind, which deployWorker says. spawnSync would not do: no handler runs until it returns,
// so a signal to this process alone would wait for wrangler to finish by itself.
for (const signal of Object.keys(SIGNAL_CODES)) {
  process.on(signal, () => {
    interruptedBy ??= signal
    if (!restoring) current?.kill(signal)
  })
}

process.exitCode = await deployWorker({
  run: (command, args, env) => new Promise((resolve, reject) => {
    current = spawn(command, args, { cwd: rootDir, stdio: 'inherit', env: { ...process.env, ...env } })
    current.once('error', reject)
    current.once('close', (status, signal) => resolve(status ?? SIGNAL_CODES[signal] ?? 1))
  }),
  problem: () => workerBuildProblem(rootDir),
  log: console.log,
  interrupted: () => (interruptedBy ? SIGNAL_CODES[interruptedBy] : null),
  restoring: () => {
    restoring = true
  },
})
