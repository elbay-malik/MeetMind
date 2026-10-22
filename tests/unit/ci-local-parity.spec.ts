import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

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

describe('ci:local parity with ci.yml', () => {
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
