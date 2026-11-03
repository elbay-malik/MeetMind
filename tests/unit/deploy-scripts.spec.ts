import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { deployWorker, workerBuildProblem } from '../../scripts/lib/deploy-worker.mjs'
import { pushWorkerSecrets, WORKER_SECRET_NAMES, workerSecretsPayload } from '../../scripts/lib/worker-secrets.mjs'
import { REQUIRED_SETTINGS } from '../../server/utils/drivers'

const inRepo = (path: string) => readFile(fileURLToPath(new URL(`../../${path}`, import.meta.url)), 'utf8')

const wranglerConfig = async () => JSON.parse((await inRepo('wrangler.jsonc'))
  .split('\n').filter(line => !line.trim().startsWith('//')).join('\n')) as Record<string, unknown>

describe('wrangler.jsonc', () => {
  it('serves on the one host, with neither of the hostnames the rate rule does not cover', async () => {
    const config = await wranglerConfig()
    expect(config.routes).toEqual([{ pattern: 'meetmind.elbaymalik.com', custom_domain: true }])
    expect(config.workers_dev).toBe(false)
    expect(config.preview_urls).toBe(false)
  })

  it('no longer says it is not a deployment', async () => {
    const text = await inRepo('wrangler.jsonc')
    expect(text).not.toMatch(/NOT yet a deployment|nothing here has been published/)
    expect(text).toContain('Do not run `wrangler dev` at the repo root')
  })

  it('uses keys wrangler knows', async () => {
    const schema = await inRepo('node_modules/wrangler/config-schema.json')
    for (const key of ['routes', 'workers_dev', 'preview_urls', 'custom_domain']) expect(schema).toContain(`"${key}"`)
  })
})

describe('infra/r2-cors.json', () => {
  it('adds the deployed origin and keeps localhost, as setting it replaces the whole policy', async () => {
    const { rules } = JSON.parse(await inRepo('infra/r2-cors.json')) as { rules: Array<{ allowed: { origins: string[], methods: string[] } }> }
    expect(rules).toHaveLength(1)
    expect(rules[0]!.allowed.origins).toEqual(['https://meetmind.elbaymalik.com', 'http://localhost:3000'])
    expect(rules[0]!.allowed.methods).toEqual(['PUT'])
    const { routes } = await wranglerConfig() as { routes: Array<{ pattern: string }> }
    expect(rules[0]!.allowed.origins).toContain(`https://${routes[0]!.pattern}`)
  })
})

describe('what warns of wrangler dev at the repo root', () => {
  it.each(['README.md', 'scripts/verify-worker-gate.mjs', 'scripts/verify-worker-sweep.mjs', 'scripts/verify-worker-streams.mjs'])('%s does', async (path) => {
    expect((await inRepo(path)).replace(/\s+/g, ' ').replace(/\/\/ /g, '')).toMatch(/[Nn]ever run `wrangler dev` at the repo root/)
  })

  it.each(['scripts/verify-worker-gate.mjs', 'scripts/verify-worker-sweep.mjs', 'scripts/verify-worker-streams.mjs'])('%s still runs from a temporary copy, with almost nothing in its environment', async (path) => {
    const script = await inRepo(path)
    expect(script).toContain('mkdtemp(')
    expect(script).toContain('cwd: dir')
    expect(script).toContain('env: { PATH: process.env.PATH, HOME: process.env.HOME, WRANGLER_SEND_METRICS: \'false\', NO_COLOR: \'1\' }')
  })
})

describe('whether a build can be deployed', () => {
  let root = ''
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'meetmind-deploy-'))
    await mkdir(join(root, '.output/public/ffmpeg'), { recursive: true })
  })
  afterEach(() => rm(root, { recursive: true, force: true }))

  const build = (preset: string) => writeFile(join(root, '.output/nitro.json'), JSON.stringify({ preset }))

  it.each(['cloudflare-module', 'cloudflare_module'])('takes a %s build with no wasm', async (preset) => {
    await build(preset)
    expect(await workerBuildProblem(root)).toBeNull()
  })

  it.each(['node-server', 'cloudflare-pages', 'cloudflare'])('refuses a %s build', async (preset) => {
    await build(preset)
    expect(await workerBuildProblem(root)).toContain(preset)
  })

  it('refuses a build that still has the wasm among its assets', async () => {
    await build('cloudflare-module')
    await writeFile(join(root, '.output/public/ffmpeg/ffmpeg-core.wasm'), 'x')
    expect(await workerBuildProblem(root)).toContain('ffmpeg-core.wasm')
  })

  it('refuses when there is no finished build at all', async () => {
    expect(await workerBuildProblem(root)).toContain('nitro.json')
    await writeFile(join(root, '.output/nitro.json'), '{not json')
    expect(await workerBuildProblem(root)).toContain('nitro.json')
  })
})

describe('pnpm deploy:worker', () => {
  /** Every command run, with the exit codes it should answer, by what it was. */
  function world(codes: { workerBuild?: number, deploy?: number, nodeBuild?: number, problem?: string | null, throwsOn?: string } = {}) {
    const calls: string[] = []
    const lines: string[] = []
    const run = (command: string, args: string[], env: Record<string, string | undefined>) => {
      const line = [command, ...args].join(' ')
      expect(command).toBe('pnpm')
      if (line === 'pnpm build' && env.NITRO_PRESET === 'cloudflare_module') {
        calls.push('worker build')
        return codes.workerBuild ?? 0
      }
      if (line === 'pnpm build') {
        // Set to nothing, and so not inherited from a shell that exported it.
        expect(Object.keys(env)).toContain('NITRO_PRESET')
        expect(env.NITRO_PRESET).toBeUndefined()
        calls.push('node build')
        return codes.nodeBuild ?? 0
      }
      expect(line).toBe('pnpm exec wrangler deploy')
      calls.push('deploy')
      if (codes.throwsOn === 'deploy') throw new Error('spawn failed')
      return codes.deploy ?? 0
    }
    const problem = vi.fn(async () => codes.problem ?? null)
    return { calls, lines, problem, go: () => deployWorker({ run, problem, log: (line: string) => lines.push(line) }) }
  }

  it('builds for Workers, checks, deploys, and then puts the Node build back', async () => {
    const { calls, problem, go } = world()
    expect(await go()).toBe(0)
    expect(calls).toEqual(['worker build', 'deploy', 'node build'])
    expect(problem).toHaveBeenCalledOnce()
  })

  it('deploys nothing when the build is refused, and still puts the Node build back', async () => {
    const { calls, lines, go } = world({ problem: '.output is a node-server build, not cloudflare_module' })
    expect(await go()).toBe(1)
    expect(calls).toEqual(['worker build', 'node build'])
    expect(lines.join()).toContain('Nothing was deployed')
  })

  it('deploys nothing when the Worker build fails, and answers its code', async () => {
    const { calls, go } = world({ workerBuild: 3 })
    expect(await go()).toBe(3)
    expect(calls).toEqual(['worker build', 'node build'])
  })

  it('puts the Node build back when the deploy fails, and answers the deploy\'s code', async () => {
    const { calls, go } = world({ deploy: 7 })
    expect(await go()).toBe(7)
    expect(calls).toEqual(['worker build', 'deploy', 'node build'])
  })

  it('puts the Node build back even when a command could not be run', async () => {
    const { calls, go } = world({ throwsOn: 'deploy' })
    await expect(go()).rejects.toThrow('spawn failed')
    expect(calls).toEqual(['worker build', 'deploy', 'node build'])
  })

  it('says so when the deploy worked and the Node build then did not', async () => {
    const { lines, go } = world({ nodeBuild: 9 })
    expect(await go()).toBe(9)
    expect(lines.join()).toContain('Run pnpm build')
  })

  it('is the package script', async () => {
    const { scripts } = JSON.parse(await inRepo('package.json')) as { scripts: Record<string, string> }
    expect(scripts['deploy:worker']).toBe('node scripts/deploy-worker.mjs')
    expect(scripts['secrets:worker']).toBe('node scripts/push-worker-secrets.mjs')
  })
})

describe('pnpm secrets:worker', () => {
  const VALUES = Object.fromEntries(WORKER_SECRET_NAMES.map((name: string) => [name, `value-of-${name}`]))
  const envFile = (values: Record<string, string>) => Object.entries(values).map(([name, value]) => `${name}=${value}`).join('\n')
  const NOT_TO_SEND = {
    CLOUDFLARE_API_TOKEN: 'wrangler-token',
    CLOUDFLARE_ACCOUNT_ID: 'account',
    SUPABASE_DB_URL: 'postgresql://user:password@host/db',
    NUXT_GEMINI_API_KEY: 'gemini-key',
    NUXT_SUPABASE_PUBLISHABLE_KEY: 'publishable',
    NUXT_PUBLIC_DEMO_MEETING_ID: '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d',
    NUXT_ALLOW_LOCAL_DRIVERS: 'true',
    NUXT_RETENTION_PURGE_DAYS: '30',
    NUXT_UPLOAD_TOKEN_SECRET: 'local',
  }

  it('names the twelve, which are everything the gate needs and the invite, retention and admin settings', () => {
    expect(WORKER_SECRET_NAMES).toHaveLength(12)
    const gate = Object.values(REQUIRED_SETTINGS).flatMap(group => Object.keys(group))
    expect([...WORKER_SECRET_NAMES].sort()).toEqual([...gate, 'NUXT_INVITE_CODE', 'NUXT_R2_RETENTION_DAYS', 'NUXT_ADMIN_TOKEN'].sort())
  })

  it('every name is a setting the app reads', async () => {
    const config = await inRepo('nuxt.config.ts')
    for (const name of WORKER_SECRET_NAMES) expect(config).toContain(`// ${name}`)
  })

  it('never lists the demo id', () => {
    expect(WORKER_SECRET_NAMES).not.toContain('NUXT_PUBLIC_DEMO_MEETING_ID')
  })

  it('sends those keys and no others, whatever else .env has', () => {
    const sent = JSON.parse(workerSecretsPayload(envFile({ ...NOT_TO_SEND, ...VALUES }))) as Record<string, string>
    expect(sent).toEqual(VALUES)
    for (const value of Object.values(NOT_TO_SEND)) expect(JSON.stringify(sent)).not.toContain(value)
  })

  it('keeps a value whole, as a generated token has = and + and / in it', () => {
    const token = 'Ab+/cd==0123456789abcdefghijklmnop='
    const sent = JSON.parse(workerSecretsPayload(envFile({ ...VALUES, NUXT_ADMIN_TOKEN: token }))) as Record<string, string>
    expect(sent.NUXT_ADMIN_TOKEN).toBe(token)
  })

  it('reads a real file\'s comments, quotes, spaces and blank values as dotenv would', () => {
    const file = [
      '# a comment NUXT_GROQ_API_KEY=not-this',
      '',
      `NUXT_GROQ_API_KEY="quoted value"`,
      `export NUXT_R2_BUCKET='single'`,
      'NUXT_SUPABASE_URL = spaced # and a note',
      'NUXT_R2_ACCOUNT_ID=before#after',
      'NUXT_GEMINI_API_KEY=',
      'SUPABASE_DB_URL=',
      'NUXT_ADMIN_TOKEN=abc=',
      ...WORKER_SECRET_NAMES.filter((name: string) => !['NUXT_GROQ_API_KEY', 'NUXT_R2_BUCKET', 'NUXT_SUPABASE_URL', 'NUXT_R2_ACCOUNT_ID', 'NUXT_ADMIN_TOKEN'].includes(name)).map((name: string) => `${name}=x`),
    ].join('\r\n')
    const sent = JSON.parse(workerSecretsPayload(file)) as Record<string, string>
    expect(sent).toMatchObject({
      NUXT_GROQ_API_KEY: 'quoted value',
      NUXT_R2_BUCKET: 'single',
      NUXT_SUPABASE_URL: 'spaced',
      NUXT_R2_ACCOUNT_ID: 'before#after',
      NUXT_ADMIN_TOKEN: 'abc=',
    })
    expect(Object.keys(sent).sort()).toEqual([...WORKER_SECRET_NAMES].sort())
  })

  it.each(WORKER_SECRET_NAMES as string[])('refuses when %s is missing, and when it is blank', (name) => {
    const { [name]: _gone, ...rest } = VALUES
    expect(() => workerSecretsPayload(envFile(rest))).toThrow(name)
    expect(() => workerSecretsPayload(envFile({ ...VALUES, [name]: '' }))).toThrow(name)
    expect(() => workerSecretsPayload(envFile({ ...VALUES, [name]: '   ' }))).toThrow(name)
  })

  it('names what is missing, and prints no value doing it', () => {
    const lines: string[] = []
    const run = vi.fn(() => 0)
    const { NUXT_ADMIN_TOKEN: _gone, ...rest } = VALUES
    expect(pushWorkerSecrets({ envText: envFile({ ...rest, ...NOT_TO_SEND }), run, log: (line: string) => lines.push(line) })).toBe(1)
    expect(run).not.toHaveBeenCalled()
    expect(lines.join()).toContain('NUXT_ADMIN_TOKEN')
    expect(lines.join()).not.toContain('value-of-')
    expect(lines.join()).not.toContain('wrangler-token')
  })

  it('pipes them to wrangler on stdin, and prints the names alone', () => {
    const lines: string[] = []
    const run = vi.fn((_command: string, _args: string[], _input: string) => 0)
    expect(pushWorkerSecrets({ envText: envFile({ ...NOT_TO_SEND, ...VALUES }), run, log: (line: string) => lines.push(line) })).toBe(0)
    expect(run).toHaveBeenCalledOnce()
    const [command, args, input] = run.mock.calls[0]!
    expect([command, ...args]).toEqual(['pnpm', 'exec', 'wrangler', 'secret', 'bulk'])
    expect(JSON.parse(input)).toEqual(VALUES)
    for (const name of WORKER_SECRET_NAMES) expect(lines.join('\n')).toContain(name)
    expect(lines.join('\n')).not.toContain('value-of-')
    expect(lines.join('\n')).not.toContain('NUXT_PUBLIC_DEMO_MEETING_ID')
  })

  it('answers wrangler\'s failure', () => {
    expect(pushWorkerSecrets({ envText: envFile(VALUES), run: () => 4, log: () => {} })).toBe(4)
  })

  it('reads .env and gives it to nothing but this', async () => {
    const script = await inRepo('scripts/push-worker-secrets.mjs')
    expect(script).toContain('readFileSync(join(rootDir, \'.env\')')
    expect(script).toContain('input,')
    expect(script).not.toMatch(/secret', 'bulk', /)
  })
})
