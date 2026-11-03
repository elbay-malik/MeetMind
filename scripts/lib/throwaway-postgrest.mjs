// A throwaway Postgres with every migration applied and PostgREST in front, so the real Supabase
// drivers can run on this machine. That is not Supabase: its roles and grants are stood in for
// below, in the way a new project has them, and its row cap is set to Supabase's default. Nothing
// here reads .env, and nothing reaches a real project. Needs Docker.
import { execFile, spawn } from 'node:child_process'
import { createHmac } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

const run = promisify(execFile)
const rootDir = fileURLToPath(new URL('../..', import.meta.url))

const POSTGRES_IMAGE = 'pgvector/pgvector:pg17'
const POSTGREST_IMAGE = 'postgrest/postgrest:v12.2.3'
const JWT_SECRET = 'throwaway-jwt-secret-of-at-least-32-characters'

const base64url = value => Buffer.from(value).toString('base64url')

function serviceKey() {
  const unsigned = `${base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))}.${base64url(JSON.stringify({ role: 'service_role' }))}`
  return `${unsigned}.${createHmac('sha256', JWT_SECRET).update(unsigned).digest('base64url')}`
}

/** Feed `input` to a process, since `execFile` cannot, and answer with what it printed. */
function withInput(file, args, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { stdio: ['pipe', 'pipe', 'pipe'] })
    let out = ''
    child.stdout.on('data', chunk => (out += chunk))
    child.stderr.on('data', chunk => (out += chunk))
    child.on('error', reject)
    child.on('exit', code => code === 0 ? resolve(out) : reject(new Error(out)))
    child.stdin.end(input)
  })
}

/**
 * Start one. `name` keeps two runs apart, and `port` is where PostgREST answers on this machine.
 * Answers `{ url, serviceKey, sql, stop }`: `sql` runs text as the owner and answers what it printed.
 */
export async function startThrowawayPostgrest({ name = 'meetmind-postgrest', port = 55435 } = {}) {
  const db = `${name}-db`
  const rest = `${name}-rest`
  const network = `${name}-net`

  const stop = async () => {
    await run('docker', ['rm', '-f', db, rest]).catch(() => {})
    await run('docker', ['network', 'rm', network]).catch(() => {})
  }
  await stop()
  await run('docker', ['network', 'create', network])
  await run('docker', ['run', '-d', '--name', db, '--network', network, '--network-alias', 'db', '-e', 'POSTGRES_PASSWORD=pg', POSTGRES_IMAGE])

  const psql = ['exec', '-i', '-e', 'PGPASSWORD=pg', db, 'psql', '-U', 'postgres', '-h', 'localhost', '-v', 'ON_ERROR_STOP=1', '-q', '-At']
  const sql = text => withInput('docker', psql, text)

  // Over TCP, which the image's temporary server does not answer: see verify-migrations.sh.
  let ready = false
  for (let i = 0; i < 60 && !ready; i++) {
    ready = await sql('select 1').then(() => true, () => false)
    if (!ready) await new Promise(resolve => setTimeout(resolve, 1000))
  }
  if (!ready) {
    await stop()
    throw new Error('Postgres never accepted a query in 60 s')
  }

  // A new Supabase project's roles, and what its default privileges hand out.
  await sql(`
    create role anon nologin;
    create role authenticated nologin;
    create role service_role nologin bypassrls;
    create role authenticator noinherit login password 'pg';
    grant anon, authenticated, service_role to authenticator;
    grant usage on schema public to anon, authenticated, service_role;
    alter default privileges in schema public grant all on tables to service_role;
    alter default privileges in schema public grant execute on functions to anon, authenticated;
  `)
  const migrations = (await readdir(join(rootDir, 'supabase/migrations'))).filter(file => file.endsWith('.sql')).sort()
  for (const file of migrations) await sql(await readFile(join(rootDir, 'supabase/migrations', file), 'utf8'))
  await sql('grant usage on schema extensions to service_role;')

  await run('docker', ['run', '-d', '--name', rest, '--network', network, '-p', `127.0.0.1:${port}:3000`,
    '-e', 'PGRST_DB_URI=postgres://authenticator:pg@db:5432/postgres',
    '-e', 'PGRST_DB_SCHEMAS=public',
    '-e', 'PGRST_DB_ANON_ROLE=anon',
    '-e', `PGRST_JWT_SECRET=${JWT_SECRET}`,
    '-e', 'PGRST_DB_MAX_ROWS=1000',
    POSTGREST_IMAGE])

  const url = `http://127.0.0.1:${port}`
  const key = serviceKey()
  let up = false
  for (let i = 0; i < 60 && !up; i++) {
    up = await fetch(`${url}/sweep_state?select=id`, { headers: { apikey: key, authorization: `Bearer ${key}` } }).then(res => res.ok, () => false)
    if (!up) await new Promise(resolve => setTimeout(resolve, 500))
  }
  if (!up) {
    await stop()
    throw new Error('PostgREST never answered in 30 s')
  }
  // supabase-js puts /rest/v1 on the URL, and PostgREST serves from the root: a caller's proxy, or `restUrl`.
  return { url, serviceKey: key, sql, stop }
}
