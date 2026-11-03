// `pnpm deploy:worker`: builds for Workers, refuses a build that is not one or that still has the
// wasm among its assets, runs wrangler deploy, and puts the Node build back even on failure. It
// changes the live Worker. See README's "Deploying the Worker" for what comes before and after.
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { deployWorker, workerBuildProblem } from './lib/deploy-worker.mjs'

const rootDir = fileURLToPath(new URL('..', import.meta.url))

process.exitCode = await deployWorker({
  run(command, args, env) {
    const { status, error } = spawnSync(command, args, { cwd: rootDir, stdio: 'inherit', env: { ...process.env, ...env } })
    if (error) throw error
    return status ?? 1
  },
  problem: () => workerBuildProblem(rootDir),
  log: console.log,
})
