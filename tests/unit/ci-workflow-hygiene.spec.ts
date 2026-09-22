import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const workflowPath = fileURLToPath(new URL('../../.github/workflows/ci.yml', import.meta.url))

/**
 * One `- name: …` step of a workflow job, with its own keys and its `run:`
 * block. Parsed by indentation rather than with a YAML library: the point is
 * to read exactly what GitHub reads, and a dependency that normalises the
 * document could paper over the very thing being checked.
 */
interface Step {
  name: string
  /** Whether the step declares `shell:` at all, and to what. */
  shell: string | null
  body: string
}

function parseSteps(yaml: string): Step[] {
  const lines = yaml.split('\n')
  const steps: Step[] = []
  let current: Step | null = null
  for (const line of lines) {
    const started = /^\s*- name:\s*(.+?)\s*$/.exec(line)
    if (started) {
      if (current) steps.push(current)
      current = { name: started[1]!, shell: null, body: '' }
      continue
    }
    if (!current) continue
    // A new list item that is not a `- name:` step ends the current one.
    if (/^\s*- /.test(line)) {
      steps.push(current)
      current = null
      continue
    }
    const shell = /^\s*shell:\s*(.+?)\s*$/.exec(line)
    if (shell) current.shell = shell[1]!
    current.body += `${line}\n`
  }
  if (current) steps.push(current)
  return steps
}

describe('CI workflow hygiene', () => {
  it('gives every piped run step `shell: bash`, so a failing command is not masked by the pipe', async () => {
    // GitHub's default shell for `run` is `bash -e {0}` — WITHOUT `-o
    // pipefail`. In `cmd | tee log`, `$?` is then tee's, which is always 0,
    // so `set -e` never sees the failure. This is not hypothetical: the
    // browser job piped drive-upload.mjs into tee for two phases, and that
    // script reports failure by setting `process.exitCode` rather than
    // throwing, so every assertion in it was advisory. `shell: bash` is the
    // form GitHub documents as `bash --noprofile --norc -eo pipefail {0}`.
    const yaml = await readFile(workflowPath, 'utf8')
    const steps = parseSteps(yaml)
    expect(steps.length, 'no steps parsed — the parser has drifted from the workflow').toBeGreaterThan(0)

    const piped = steps.filter(s => /^[^\n#]*\S\s\|\s*(tee|grep|awk|sed|head|tail|jq|xargs)\b/m.test(s.body))
    // Guard the guard: if nothing matches, this test would pass vacuously
    // forever, including after someone reintroduces exactly the bug it exists
    // to catch.
    expect(piped.length, 'no piped steps found — this check would pass vacuously').toBeGreaterThan(0)

    for (const step of piped) {
      expect(step.shell, `step "${step.name}" pipes a command but does not set \`shell: bash\``).toBe('bash')
    }
  })
})
