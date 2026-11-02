import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'

const rootDir = fileURLToPath(new URL('../..', import.meta.url))
const run = promisify(execFile)

const TAB = 9
const LINE_FEED = 10
const CARRIAGE_RETURN = 13
const DELETE = 127

/** Control characters are invisible in most editors, which is how one survived
 * being read many times. Checked numerically rather than with a regex literal:
 * writing the class as literal characters is the very mistake being guarded
 * against, and doing it in the guard itself is worse than not having one. */
function firstControlCharacter(text: string): { codePoint: number, index: number } | null {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    if (code === TAB || code === LINE_FEED || code === CARRIAGE_RETURN) continue
    if (code < 32 || code === DELETE) return { codePoint: code, index: i }
  }
  return null
}

/** Every file git tracks, so a new source file is covered without being listed
 * here. Split on newlines: a tracked path containing one is quoted by git. */
async function trackedTextFiles(): Promise<string[]> {
  const { stdout } = await run('git', ['ls-files'], { cwd: rootDir, maxBuffer: 32 * 1024 * 1024 })
  return stdout
    .split(String.fromCharCode(LINE_FEED))
    .filter(Boolean)
    .filter(file => /\.(ts|tsx|js|mjs|cjs|vue|json|md|sql|sh|ya?ml|css|html)$/.test(file))
}

/**
 * `reconcile.ts` once held a literal NUL byte as its token separator. It
 * worked, so no test noticed — but git classifies a file containing NUL as
 * BINARY, so that file's diffs rendered as "Binary files differ" and the one
 * place model output becomes stored data was invisible to code review for five
 * rounds of it.
 *
 * These check the property that actually matters — the file stays reviewable
 * as text — rather than that one mistake, so the next exotic separator someone
 * reaches for fails here too.
 */
describe('source hygiene', () => {
  it('has no control characters in any tracked text file', async () => {
    const offenders: string[] = []
    for (const file of await trackedTextFiles()) {
      const text = await readFile(join(rootDir, file), 'utf8').catch(() => null)
      if (text === null) continue
      const found = firstControlCharacter(text)
      if (found) {
        const hex = found.codePoint.toString(16).padStart(4, '0').toUpperCase()
        offenders.push(`${file}: U+${hex} at offset ${found.index}`)
      }
    }
    expect(offenders).toEqual([])
  })

  it('keeps every tracked text file valid UTF-8, so git treats it as text', async () => {
    const offenders: string[] = []
    for (const file of await trackedTextFiles()) {
      const bytes = await readFile(join(rootDir, file)).catch(() => null)
      if (!bytes) continue
      try {
        new TextDecoder('utf-8', { fatal: true }).decode(bytes)
      }
      catch {
        offenders.push(file)
      }
    }
    expect(offenders).toEqual([])
  })

  // ADR-0014: its terms forbid the free tier here, so nothing may depend on it or
  // tell a visitor otherwise. The ADRs and the playbook are history, and tests have to
  // name it to look for it.
  it('names the removed embedding provider nowhere but in the historical record', async () => {
    const offenders: string[] = []
    for (const file of [...await trackedTextFiles(), '.env.example']) {
      if (/^(docs|tests)\/|^pnpm-lock\.yaml$/.test(file)) continue
      const text = await readFile(join(rootDir, file), 'utf8').catch(() => null)
      if (text !== null && /gemini|google/i.test(text)) offenders.push(file)
    }
    expect(offenders).toEqual([])
  })
})
