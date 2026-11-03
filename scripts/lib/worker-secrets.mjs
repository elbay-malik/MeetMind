// What `pnpm secrets:worker` sends, apart from sending it, so a test can hold it with no wrangler
// and no real .env: tests/unit/deploy-scripts.spec.ts.

/**
 * Every secret a deployment takes from .env, and nothing else goes. In particular not the
 * wrangler token, the database URL or anything left over in that file, none of which a Worker
 * needs. Nor NUXT_PUBLIC_DEMO_MEETING_ID: while it names a meeting that meeting's pipeline
 * refuses, so it is set by hand once the demo is finished (ADR-0015).
 */
export const WORKER_SECRET_NAMES = [
  'NUXT_GROQ_API_KEY',
  'NUXT_WORKERS_AI_ACCOUNT_ID',
  'NUXT_WORKERS_AI_API_TOKEN',
  'NUXT_SUPABASE_URL',
  'NUXT_SUPABASE_SERVICE_KEY',
  'NUXT_R2_ACCOUNT_ID',
  'NUXT_R2_ACCESS_KEY_ID',
  'NUXT_R2_SECRET_ACCESS_KEY',
  'NUXT_R2_BUCKET',
  'NUXT_INVITE_CODE',
  'NUXT_R2_RETENTION_DAYS',
  'NUXT_ADMIN_TOKEN',
]

/**
 * One `NAME=value` a line, as dotenv reads the simple cases: a comment or blank line is
 * skipped, surrounding quotes go, and unquoted text stops at ` #`. Nothing is expanded. Not
 * `node:util`'s parseEnv, which takes the line after an empty value as part of it (Node 24).
 */
function readEnvFile(text) {
  const env = {}
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([\w.-]+)\s*=\s*(.*?)\s*$/.exec(line)
    if (!match) continue
    const [, name, raw] = match
    const quoted = /^(["'])(.*)\1$/.exec(raw)
    env[name] = quoted ? quoted[2] : raw.replace(/\s+#.*$/, '').replace(/^#.*$/, '')
  }
  return env
}

/** The JSON wrangler is given, holding those keys alone. Throws naming what is missing, and never a value. */
export function workerSecretsPayload(envText) {
  const env = readEnvFile(envText)
  const missing = WORKER_SECRET_NAMES.filter(name => !env[name]?.trim())
  if (missing.length > 0) throw new Error(`.env has no value for ${missing.join(', ')}, so nothing was sent.`)
  return JSON.stringify(Object.fromEntries(WORKER_SECRET_NAMES.map(name => [name, env[name]])))
}

/**
 * Send them, and print the names only. `run` is given the JSON on stdin, never a file, and
 * answers an exit code. Answers this process's own.
 */
export function pushWorkerSecrets({ envText, run, log }) {
  let payload
  try {
    payload = workerSecretsPayload(envText)
  }
  catch (err) {
    log(`FAIL: ${err.message}`)
    return 1
  }
  log(`Sending ${WORKER_SECRET_NAMES.length} secrets by name:`)
  for (const name of WORKER_SECRET_NAMES) log(`  ${name}`)
  const code = run('pnpm', ['exec', 'wrangler', 'secret', 'bulk'], payload)
  if (code !== 0) log(`FAIL: wrangler secret bulk exited with ${code}.`)
  return code
}
