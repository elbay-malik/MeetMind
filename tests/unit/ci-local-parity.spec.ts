import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { REQUIRED_SETTINGS } from '../../server/utils/drivers'

const workflowPath = fileURLToPath(new URL('../../.github/workflows/ci.yml', import.meta.url))
const scriptPath = fileURLToPath(new URL('../../scripts/ci-local.sh', import.meta.url))

/**
 * Commands ci.yml runs that scripts/ci-local.sh deliberately does NOT, each
 * with the reason. Anything NOT listed here has to be covered by the local
 * script, or this test fails.
 *
 * The point is that `pnpm ci:local` is a hand-written duplicate of CI, and a
 * hand-written duplicate is exactly where this repo has been bitten before —
 * scripts/lib/citation-match.mjs drifted from reconcile.ts twice before
 * tests/unit/driver-citation-parity.spec.ts pinned it, and
 * server/utils/db/database.types.ts is still hand-written against the
 * migrations. A local CI runner that quietly stops matching CI is worse than
 * no local runner at all, because its green is believed.
 */
const INTENTIONALLY_NOT_REPLICATED: { pattern: RegExp, why: string }[] = [
  {
    pattern: /^pnpm install --frozen-lockfile$/,
    why: 'CI reinstalls per job on a clean runner; the local script installs once, and only when the lockfile is newer than node_modules',
  },
  {
    pattern: /apt-get/,
    why: 'installs ffmpeg on a fresh Ubuntu runner; locally ffmpeg is checked for and the job fails with a brew hint rather than touching the machine',
  },
  {
    pattern: /playwright-core install --with-deps/,
    why: '--with-deps needs sudo on Linux; locally Chromium is checked and installed without it',
  },
  {
    pattern: /^cat server\.log \|\| true$/,
    why: 'the on-failure log dump CI does; locally the log is always written to .data/ci-local/server.log',
  },
  {
    pattern: /^curl -sf http:\/\/localhost:3000\/api\/health/,
    why: 'the readiness poll is reimplemented against a chosen port, since pnpm dev usually holds 3000',
  },
  {
    pattern: /^(for _ in|sleep 1|done|DATA_DIR=|NUXT_DATA_DIR=|MEETING_ID=|test -n "\$MEETING_ID")/,
    why: 'shell plumbing of the browser job, reimplemented around the chosen port and a trap-based cleanup',
  },
  {
    pattern: /^node \.output\/server\/index\.mjs/,
    why: 'the server start is reimplemented with a chosen port and a PID captured for cleanup',
  },
]

/** Every command line ci.yml actually executes, from both `run: x` and `run: |` blocks. */
function ciCommands(yaml: string): string[] {
  const lines = yaml.split('\n')
  const out: string[] = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    const inline = /^\s*-?\s*run:\s*(?!\|)(\S.*)$/.exec(line)
    if (inline) {
      out.push(inline[1]!.trim())
      continue
    }
    if (!/^\s*-?\s*run:\s*\|\s*$/.test(line)) continue
    // A block scalar: take every following line indented deeper than `run:`.
    const baseIndent = line.search(/\S/)
    for (let j = i + 1; j < lines.length; j++) {
      const body = lines[j]!
      if (body.trim() === '') continue
      if (body.search(/\S/) <= baseIndent) break
      out.push(body.trim())
    }
  }
  // Drop pure continuations and shell noise that carry no command of their own.
  return out.filter(c => c !== '' && !c.startsWith('#') && c !== '\\' && !/^[})]/.test(c))
}

/** The commands in a shell function's body, each with its `\\` continuations joined on. */
function shellSteps(body: string): string[] {
  return body.replace(/\\\n\s*/g, ' ').split('\n').map(line => line.trim())
}

/** Every script or pnpm step in a job's body, whatever it is called, so a new driver cannot slip past. */
function failableSteps(body: string): string[] {
  return shellSteps(body).filter(step => /^(\w+=\S*\s+)*(node scripts\/|bash scripts\/|pnpm )/.test(step))
}

const unguarded = (steps: string[]) => steps.filter(step => !step.endsWith('|| return 1'))

describe('ci:local parity with ci.yml', () => {
  it('fails the browser job when a step in it fails', async () => {
    // The job runs as an `if` condition, where bash ignores `set -e`, so a step
    // with no explicit `|| return 1` cannot fail the job. drive-upload and
    // drive-player both failed behind a green result this way.
    const script = await readFile(scriptPath, 'utf8')
    const body = /^run_browser_job\(\) \{\n([\s\S]*?)^\}$/m.exec(script)?.[1]
    expect(body, 'could not find run_browser_job in ci-local.sh').toBeTruthy()
    const steps = failableSteps(body!)
    // At least today's five, so a pattern that stops matching cannot pass on nothing.
    expect(steps.length, 'matched too few steps: the pattern has drifted from the script').toBeGreaterThanOrEqual(5)
    expect(unguarded(steps)).toEqual([])
  })

  it.each([
    ['a new driver', 'node scripts/drive-foo.mjs "$base"'],
    ['a piped driver', 'node scripts/drive-foo.mjs "$base" | tee foo.log'],
    ['a continued driver', 'node scripts/drive-foo.mjs "$base" \\\n    | tee foo.log'],
    ['a driver with an env prefix', 'BASE="$base" node scripts/drive-foo.mjs'],
    ['another pnpm step', 'pnpm exec something'],
  ])('notices %s with no guard', (_name, step) => {
    expect(unguarded(failableSteps(`  ${step}\n`))).toHaveLength(1)
  })

  it('does not count a guarded continuation as unguarded', () => {
    const step = 'node scripts/drive-foo.mjs "$base" \\\n    | tee foo.log || return 1'
    expect(failableSteps(`  ${step}\n`)).toHaveLength(1)
    expect(unguarded(failableSteps(`  ${step}\n`))).toEqual([])
  })

  it('runs only browser drivers whose `fail` fails the run', async () => {
    // Each reports failure by setting the exit code, so without that line every check in it
    // prints FAIL under a job that passes.
    const script = await readFile(scriptPath, 'utf8')
    const body = /^run_browser_job\(\) \{\n([\s\S]*?)^\}$/m.exec(script)![1]!
    const drivers = [...body.matchAll(/^\s*node (scripts\/[\w.-]+\.mjs)/gm)].map(m => m[1]!)
    expect(drivers, 'found no drivers in run_browser_job').toContain('scripts/drive-upload.mjs')
    const advisory: string[] = []
    for (const driver of drivers) {
      const source = await readFile(fileURLToPath(new URL(`../../${driver}`, import.meta.url)), 'utf8')
      if (!/const fail = [^\n]*\n?[^\n]*\n?[^\n]*process\.exitCode = 1/.test(source)) advisory.push(driver)
    }
    expect(advisory).toEqual([])
  })

  it('runs only browser drivers that fail on an uncaught page error', async () => {
    // A page can throw and still render what a driver looks for, so a driver that
    // only logs page errors reports a pass over a broken page.
    const script = await readFile(scriptPath, 'utf8')
    const body = /^run_browser_job\(\) \{\n([\s\S]*?)^\}$/m.exec(script)![1]!
    const drivers = [...body.matchAll(/^\s*node (scripts\/[\w.-]+\.mjs)/gm)].map(m => m[1]!)
    expect(drivers, 'found no drivers in run_browser_job').toContain('scripts/drive-upload.mjs')
    const lenient: string[] = []
    for (const driver of drivers) {
      const source = await readFile(fileURLToPath(new URL(`../../${driver}`, import.meta.url)), 'utf8')
      if (!/page\.on\('pageerror', \w+ => fail\(/.test(source)) lenient.push(driver)
    }
    expect(lenient).toEqual([])
  })

  it('runs every verifying command CI runs, or explains why not', async () => {
    const [yaml, script] = await Promise.all([
      readFile(workflowPath, 'utf8'),
      readFile(scriptPath, 'utf8'),
    ])
    const commands = ciCommands(yaml)
    // Guard the guard: a parser that silently matches nothing would make this
    // test pass forever, which is the failure mode it exists to prevent.
    expect(commands.length, 'parsed no commands out of ci.yml — the parser has drifted').toBeGreaterThan(8)

    const uncovered: string[] = []
    for (const command of commands) {
      if (INTENTIONALLY_NOT_REPLICATED.some(e => e.pattern.test(command))) continue
      // Match on the program plus the script/target it acts on, not the whole
      // line: ports and temp paths legitimately differ locally, the thing
      // being verified does not.
      const target = /(scripts\/[\w.-]+|pnpm [\w:]+)/.exec(command)
      const needle = target ? target[1]! : command
      if (!script.includes(needle)) uncovered.push(`${command}   (looked for: ${needle})`)
    }

    expect(
      uncovered,
      `ci.yml runs these and scripts/ci-local.sh does not — either add them, or add an entry to INTENTIONALLY_NOT_REPLICATED saying why:\n  ${uncovered.join('\n  ')}`,
    ).toEqual([])
  })

  // ci.yml runs nowhere at the moment, so nothing else would notice it drifting: its
  // browser job is a production build on local drivers, which refuses them otherwise.
  it('gives the browser job\'s server the opt-in for local drivers, in both', async () => {
    const [yaml, script] = await Promise.all([readFile(workflowPath, 'utf8'), readFile(scriptPath, 'utf8')])
    expect(yaml).toMatch(/^ {10}NUXT_ALLOW_LOCAL_DRIVERS: 'true'$/m)
    expect(script).toMatch(/^ {2}NUXT_ALLOW_LOCAL_DRIVERS=true NUXT_DATA_DIR=/m)
  })

  // A shell that exported all nine would otherwise put this job past the gate, and its upload
  // into the real database and bucket, as tests/e2e/helpers/local-drivers.ts says of the e2e servers.
  it('blanks every real setting on the browser job\'s server, in both', async () => {
    const [yaml, script] = await Promise.all([readFile(workflowPath, 'utf8'), readFile(scriptPath, 'utf8')])
    const server = shellSteps(script).find(step => step.includes('node .output/server/index.mjs'))
    expect(server, 'could not find the browser job\'s server in ci-local.sh').toBeTruthy()
    const settings = Object.values(REQUIRED_SETTINGS).flatMap(group => Object.keys(group))
    expect(settings).toHaveLength(9)
    for (const setting of settings) {
      expect(server, setting).toMatch(new RegExp(`(?:^|\\s)${setting}=\\s`))
      expect(yaml, setting).toMatch(new RegExp(`^ {10}${setting}: ''$`, 'm'))
    }
  })

  it('declares a command for every job it claims to run', async () => {
    const script = await readFile(scriptPath, 'utf8')
    const declared = /^JOBS=\(([^)]+)\)/m.exec(script)
    expect(declared, 'could not find the JOBS list in ci-local.sh').not.toBeNull()
    const jobs = declared![1]!.trim().split(/\s+/)

    // Same job names as ci.yml, so the summary table can be compared to the
    // GitHub checks list line for line.
    const yaml = await readFile(workflowPath, 'utf8')
    const ciJobs = [...yaml.matchAll(/^ {2}([a-z][a-z0-9_-]*):\n(?= {4}runs-on)/gm)].map(m => m[1]!)
    expect(ciJobs.length, 'parsed no jobs out of ci.yml').toBeGreaterThan(0)
    expect([...jobs].sort()).toEqual([...ciJobs].sort())

    for (const job of jobs) {
      expect(script, `job_command has no branch for "${job}"`).toMatch(new RegExp(`^\\s*${job}\\)`, 'm'))
    }
  })
})
