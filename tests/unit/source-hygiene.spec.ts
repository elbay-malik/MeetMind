import { readdir, readFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
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

const REAL_DRIVER = /\bcreate(?:Groq|WorkersAi|R2|Supabase)[A-Z]\w*\s*\(/
const STAND_IN = /\bcreate(?:Stub|Local)[A-Z]\w*\s*\(/
const STAND_IN_MODULE = /(?:^|\/)(?:stub[\w-]*|local|[\w-]+-local)$/

/** Comments can name a constructor, and so can its own definition. Neither builds anything. */
function withoutCommentsOrDefinitions(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/\bfunction\s+create\w+/g, '')
}

/** The call starting at `start`, to its closing parenthesis. Strings here hold no parentheses that matter. */
function callAt(source: string, start: number): string {
  let depth = 0
  for (let i = source.indexOf('(', start); i < source.length; i++) {
    if (source[i] === '(') depth++
    if (source[i] === ')' && --depth === 0) return source.slice(start, i + 1)
  }
  return source.slice(start)
}

/**
 * Where a stub or local driver is built other than through `selectDriver`, or a real
 * driver is. ADR-0016 holds only if nothing can get to one without going through the gate:
 * inside its `local` branch for a stand-in, and its `real` one for a real driver. Going by
 * what the source does, and not by a list of allowed files, so a new provider is covered.
 */
function driversBuiltOutsideTheGate(files: Record<string, string>): string[] {
  const offenders: string[] = []
  for (const [file, raw] of Object.entries(files)) {
    const source = withoutCommentsOrDefinitions(raw)
    let outside = source
    for (const match of source.matchAll(/\bselectDriver(?:<[^(]*>)?\(/g)) {
      const call = callAt(source, match.index)
      const [beforeLocal = '', afterLocal = ''] = call.split(/\blocal:/)
      if (STAND_IN.test(beforeLocal)) offenders.push(`${file}: a stand-in in the real branch`)
      if (REAL_DRIVER.test(afterLocal)) offenders.push(`${file}: a real driver in the local branch`)
      outside = outside.replace(call, '')
    }
    if (STAND_IN.test(outside)) offenders.push(`${file}: a stand-in built outside selectDriver`)
    if (REAL_DRIVER.test(outside)) offenders.push(`${file}: a real driver built outside selectDriver`)

    // An alias or a namespace import would get past the patterns above, and nothing but a
    // selection module, or a local driver sharing a helper, has any use for one of these.
    const isStandIn = STAND_IN_MODULE.test(file.replace(/\.ts$/, ''))
    if (isStandIn || raw.includes('selectDriver')) continue
    for (const [, clause, from] of raw.matchAll(/^import\s+(.+?)\s+from\s+'([^']+)'/gm)) {
      if (STAND_IN_MODULE.test(from!) && !clause!.startsWith('type ')) offenders.push(`${file}: imports ${from}`)
    }
  }
  return offenders
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

  describe('the driver gate', () => {
    const serverDir = join(rootDir, 'server')

    /** From the disk, not from git: a file not committed yet is the likeliest to get this wrong. */
    async function serverSources(): Promise<Record<string, string>> {
      const files: Record<string, string> = {}
      for (const entry of await readdir(serverDir, { recursive: true, withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.endsWith('.ts')) continue
        const path = join(entry.parentPath, entry.name)
        files[relative(rootDir, path)] = await readFile(path, 'utf8')
      }
      return files
    }

    it('builds every stub, local driver and real driver through it', async () => {
      const files = await serverSources()
      expect(driversBuiltOutsideTheGate(files)).toEqual([])
      // Guard the guard: the tree really does pass through it, in the modules that select.
      const calls = Object.values(files).join('\n').match(/\bselectDriver</g) ?? []
      expect(calls.length).toBeGreaterThanOrEqual(12)
      for (const file of ['db', 'storage', 'transcription', 'summary', 'qa']) {
        expect(files[join('server', 'utils', file, 'index.ts')]).toContain('selectDriver<')
      }
    })

    const gate = (real: string, local: string) => `selectDriver<T>(event, 'groq', {
      real: config => ${real},
      local: config => ${local},
    })`

    it.each([
      ['a stub with no gate', 'return createStubTranscriber({})'],
      ['a local store with no gate', 'const repo = createLocalMeetingRepository({ dataDir })'],
      ['a real driver with no gate', 'return createGroqTranscriber({ apiKey })'],
      ['a stand-in as what the gate falls back to', `try { ${gate('createGroqTranscriber({})', 'createStubTranscriber({})')} } catch { return createStubTranscriber({}) }`],
      ['a stand-in in the real branch', gate('createStubTranscriber({})', 'createStubTranscriber({})')],
      ['a real driver in the local branch', gate('createGroqTranscriber({})', 'createGroqTranscriber({})')],
    ])('notices %s', (_name, body) => {
      expect(driversBuiltOutsideTheGate({ 'server/utils/new-provider/index.ts': body })).toHaveLength(1)
    })

    it.each([
      ['under an alias', 'import { createStubEmbedder as embedder } from \'./stub\''],
      ['under a namespace', 'import * as stubs from \'../qa/stub-answerer\''],
      ['a local store', 'import { createLocalSlotRepository as slots } from \'./db/slots-local\''],
    ])('notices one imported %s', (_name, statement) => {
      expect(driversBuiltOutsideTheGate({ 'server/utils/new-provider.ts': statement })).toHaveLength(1)
    })

    it.each([
      ['the gate used as it should be', gate('createGroqTranscriber({})', 'createStubTranscriber({ flag: !!config.x })')],
      ['a nested call in a branch', gate('createGroqAnswerer({ pacer: pacer(event) })', 'createStubAnswerer({ pacer: config.y ? pacer(event) : undefined })')],
      ['its name in a comment', '// createStubTranscriber() is built in the gate\n/* createLocalMeetingRepository() too */'],
      ['its definition', 'export function createStubTranscriber(options) { return options }'],
      ['a type from a local driver', 'import type { LocalAudioStore } from \'./local\''],
    ])('accepts %s', (_name, body) => {
      expect(driversBuiltOutsideTheGate({ 'server/utils/new-provider/index.ts': body })).toEqual([])
    })

    it('accepts a local driver sharing a helper with another', () => {
      expect(driversBuiltOutsideTheGate({ 'server/utils/db/new-local.ts': 'import { serialize } from \'./local\'' })).toEqual([])
    })
  })
})
