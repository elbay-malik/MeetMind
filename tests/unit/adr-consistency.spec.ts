import { readdir, readFile } from 'node:fs/promises'
import { relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const adrDir = fileURLToPath(new URL('../../docs/adr/', import.meta.url))

/**
 * The method a route file under server/api answers and its path, as Nitro reads the name:
 * the method is optional (with none, the file answers every verb) and an environment can
 * follow it. Null for a GET, which is the only kind the ADR-0015 table leaves out.
 */
function routeFile(fileName: string): { method: string, stem: string } | null {
  const name = /^(.+?)(?:\.(connect|delete|get|head|options|patch|post|put|trace))?(?:\.(?:dev|prod|prerender))?\.[cm]?[jt]s$/.exec(fileName)
  if (!name || name[2] === 'get') return null
  return { method: (name[2] ?? 'all').toUpperCase(), stem: name[1]! }
}

async function adr(number: string): Promise<string> {
  const name = (await readdir(adrDir)).find(file => file.startsWith(`${number}-`))
  expect(name, `no ADR ${number}`).toBeTruthy()
  return readFile(`${adrDir}${name}`, 'utf8')
}

describe('ADRs changed by ADR-0013', () => {
  it('every ADR it names in its header says so in its own status', async () => {
    const header = /^- \*\*Supersedes:\*\* (.*)$/m.exec(await adr('0013'))?.[1]
    expect(header, 'could not find the header line of ADR-0013').toBeTruthy()
    const named = [...new Set([...header!.matchAll(/ADR-(\d{4})/g)].map(m => m[1]!))]
    expect(named.length).toBeGreaterThan(0)
    const silent: string[] = []
    for (const number of named) {
      const status = /^- \*\*Status:\*\* (.*)$/m.exec(await adr(number))?.[1] ?? ''
      if (!status.includes('ADR-0013')) silent.push(number)
    }
    expect(silent).toEqual([])
  })

  it('names ADR-0010, whose reason for rate limiting was the search route', async () => {
    expect(await adr('0013')).toMatch(/^- \*\*Supersedes:\*\* .*ADR-0010/m)
  })

  it('leaves no ADR calling the removed search endpoint a live risk', async () => {
    expect(await adr('0010')).not.toMatch(/already flags the open search endpoint/)
  })
})

describe('ADRs changed by ADR-0014', () => {
  it('every ADR it names in its header says so in its own status', async () => {
    const header = /^- \*\*Supersedes:\*\* (.*)$/m.exec(await adr('0014'))?.[1]
    expect(header, 'could not find the header line of ADR-0014').toBeTruthy()
    const named = [...new Set([...header!.matchAll(/ADR-(\d{4})/g)].map(m => m[1]!))]
    expect(named).toEqual(expect.arrayContaining(['0004', '0007', '0008', '0012', '0013']))
    const silent: string[] = []
    for (const number of named) {
      const status = /^- \*\*Status:\*\* (.*)$/m.exec(await adr(number))?.[1] ?? ''
      if (!status.includes('ADR-0014')) silent.push(number)
    }
    expect(silent).toEqual([])
  })

  it('closes the provider fallback ADR-0004 deferred, where a reader of it will land', async () => {
    const passage = (await adr('0004')).split('\n- **').find(item => item.startsWith('Gemini as a fallback provider'))
    expect(passage?.replace(/\s+/g, ' ')).toMatch(/Closed on .* by \[ADR-0014\]/)
  })

  it('marks the decision it supersedes where a reader of ADR-0007 will land', async () => {
    const text = await adr('0007')
    const decision = text.slice(text.indexOf('### 1.'), text.indexOf('### 2.'))
    expect(decision).toMatch(/Superseded on .* by \[ADR-0014\]/)
  })

  it('claims only the disclosure of a question that the README really makes', async () => {
    const flat = (text: string) => text.replace(/\s+/g, ' ')
    expect(flat(await adr('0014'))).toContain('The upload page, the question form and the README say so.')
    const readme = await readFile(fileURLToPath(new URL('../../README.md', import.meta.url)), 'utf8')
    expect(flat(readme)).toContain('transcripts and questions go to Groq and Cloudflare')
  })

  it('does not call a lone oversize segment the only way past the input limit', async () => {
    const flat = (text: string) => text.replace(/^\s*\*\s?/gm, '').replace(/\s+/g, ' ')
    const source = (path: string) => readFile(fileURLToPath(new URL(`../../${path}`, import.meta.url)), 'utf8')
    const absolute = /only (a )?(lone|single)[^.]*segment/i
    const places = {
      'ADR-0014': flat(await adr('0014')),
      'windows.ts': flat(await source('server/utils/qa/windows.ts')),
      'embedder.ts': flat(await source('server/utils/qa/embedder.ts')),
    }
    for (const [place, text] of Object.entries(places)) expect(text, place).not.toMatch(absolute)
    // Its exception stays named where the bound is explained.
    expect(places['ADR-0014']).toContain('U+FDFA')
    expect(places['windows.ts']).toContain('U+FDFA')
  })

  it('leaves no ADR calling the dropped function something that stays', async () => {
    expect((await adr('0008')).split('\n').find(line => line.startsWith('- **Status:**')))
      .not.toMatch(/stays unused/)
  })
})

describe('ADRs changed by ADR-0016', () => {
  it('every ADR it names in its header says so in its own status', async () => {
    const header = /^- \*\*Supersedes:\*\* (.*)$/m.exec(await adr('0016'))?.[1]
    expect(header, 'could not find the header line of ADR-0016').toBeTruthy()
    const named = [...new Set([...header!.matchAll(/ADR-(\d{4})/g)].map(m => m[1]!))]
    expect(named).toContain('0015')
    const silent: string[] = []
    for (const number of named) {
      const status = /^- \*\*Status:\*\* (.*)$/m.exec(await adr(number))?.[1] ?? ''
      if (!status.includes('ADR-0016')) silent.push(number)
    }
    expect(silent).toEqual([])
  })

  it('tells whoever deploys the same nine settings as the gate, in the ADR and the README', async () => {
    const { REQUIRED_SETTINGS } = await import('../../server/utils/drivers')
    const readme = await readFile(fileURLToPath(new URL('../../README.md', import.meta.url)), 'utf8')
    const section = readme.split('### What a deployment needs')[1]!.split('\n### ')[0]!
    const decision = await adr('0016')
    for (const name of Object.values(REQUIRED_SETTINGS).flatMap(group => Object.keys(group))) {
      expect(section).toContain(name)
      expect(decision).toContain(name)
    }
    expect(section).toContain('NUXT_ALLOW_LOCAL_DRIVERS')
  })

  // It has run under local workerd and nowhere else, and it should keep saying so.
  it('says what waits for Phase 13, and claims nothing measured on a deployed Worker', async () => {
    const flat = (await adr('0016')).replace(/\s+/g, ' ')
    expect(flat).toContain('## What stays unproven until Phase 13')
    expect(flat).toContain('No deployed Worker has run any of this')
  })
})

describe('ADRs changed by ADR-0015', () => {
  it('every ADR it names in its header says so in its own status', async () => {
    const header = /^- \*\*Supersedes:\*\* (.*)$/m.exec(await adr('0015'))?.[1]
    expect(header, 'could not find the header line of ADR-0015').toBeTruthy()
    const named = [...new Set([...header!.matchAll(/ADR-(\d{4})/g)].map(m => m[1]!))]
    expect(named).toEqual(expect.arrayContaining(['0010', '0013']))
    const silent: string[] = []
    for (const number of named) {
      const status = /^- \*\*Status:\*\* (.*)$/m.exec(await adr(number))?.[1] ?? ''
      if (!status.includes('ADR-0015')) silent.push(number)
    }
    expect(silent).toEqual([])
  })

  it('tells a reader of ADR-0013 that registration closed, above what says it is open', async () => {
    const text = await adr('0013')
    expect(text.indexOf('[ADR-0015](0015-invite-only-uploads.md) closed registration')).toBeGreaterThan(-1)
    expect(text.indexOf('[ADR-0015](0015-invite-only-uploads.md) closed registration')).toBeLessThan(text.indexOf('registration is still'))
  })

  it('leaves no ADR calling registration what rate limiting has left to cover', async () => {
    expect((await adr('0010')).replace(/\s+/g, ' ')).not.toMatch(/left is open registration/)
  })

  describe('the operator creating the demo', () => {
    const flat = (text: string) => text.replace(/\s+/g, ' ')
    const procedure = async () => flat((await adr('0015')).split('## Creating the demo meeting')[1]!.split('\n## ')[0]!)

    // README step 3's rule covers meetings/, which is where the demo's audio lives too.
    it('is told that the demo\'s audio expires with the bucket\'s lifecycle rule, and what to do about it', async () => {
      const text = await procedure()
      expect(text).toContain('`expire-meeting-audio-30d`')
      expect(text).toContain('`wrangler r2 object put')
      expect(text).toContain('Download audio')
    })

    it('hears it from the README too, which tells them to add the rule', async () => {
      const readme = await readFile(fileURLToPath(new URL('../../README.md', import.meta.url)), 'utf8')
      const section = flat(readme.slice(readme.indexOf('Set `NUXT_PUBLIC_DEMO_MEETING_ID`'), readme.indexOf('## Architecture Decision Records')))
      expect(section).toMatch(/audio expires/)
    })

    // A dashboard variable is deleted by the next `wrangler deploy`, since wrangler.jsonc does
    // not list it, and that would take away the demo link and the read-only guard together.
    it('is told how to set the demo\'s id, so an ordinary deploy cannot delete it', async () => {
      const text = await procedure()
      expect(text).toContain('`wrangler secret put NUXT_PUBLIC_DEMO_MEETING_ID`')
      expect(text).toMatch(/not as a dashboard variable/i)
      expect(text).toContain('`wrangler secret delete NUXT_PUBLIC_DEMO_MEETING_ID`')
    })

    it('lists it among the limits this decision accepts', async () => {
      expect(flat((await adr('0015')).split('## Consequences')[1]!)).toContain('**The demo\'s audio expires like any other.**')
    })
  })

  it.each([
    ['retry.post.ts', 'POST'],
    ['retry.delete.ts', 'DELETE'],
    // With no method, Nitro answers every verb, POST included.
    ['retry.ts', 'ALL'],
    ['retry.head.ts', 'HEAD'],
    ['retry.options.ts', 'OPTIONS'],
    ['retry.connect.ts', 'CONNECT'],
    ['retry.trace.ts', 'TRACE'],
    ['retry.post.prod.ts', 'POST'],
    ['retry.prod.ts', 'ALL'],
    ['retry.post.mjs', 'POST'],
  ])('counts %s as a route to examine, one that answers %s', (file, method) => {
    expect(routeFile(file)).toEqual({ method, stem: 'retry' })
  })

  it.each(['retry.get.ts', 'retry.get.prod.ts'])('leaves %s out, as a GET', (file) => {
    expect(routeFile(file)).toBeNull()
  })

  it('records a guard for every route that is not a GET, so a new one cannot go unexamined', async () => {
    const apiDir = fileURLToPath(new URL('../../server/api/', import.meta.url))
    const files = (await readdir(apiDir, { recursive: true, withFileTypes: true })).filter(f => f.isFile())
    const routes = files.flatMap((file) => {
      const route = routeFile(file.name)
      if (!route) return []
      const dir = relative(apiDir, file.parentPath)
      const segments = [...dir.split('/'), route.stem].filter(segment => segment && segment !== 'index')
      const path = segments.map(segment => segment.replace(/^\[(.+)\]$/, ':$1')).join('/')
      return [`${route.method} /api/${path}`]
    })
    // Guard the guard: a walk that matched nothing would pass forever.
    expect(routes).toContain('POST /api/meetings')
    expect(routes).toContain('DELETE /api/meetings/:id')
    expect(routes).toContain('PUT /api/uploads/:token')
    expect(routes.length).toBeGreaterThanOrEqual(9)

    const table = (await adr('0015')).split('## What guards each route')[1]!.split('\n## ')[0]!
    const rows = table.split('\n').filter(line => line.startsWith('| `'))
    const missing = routes.filter(route => !rows.some(row => row.startsWith(`| \`${route}\` |`)))
    expect(missing).toEqual([])
  })
})

describe('what the docs say about a built server (ADR-0016)', () => {
  const inRepo = (path: string) => readFile(fileURLToPath(new URL(`../../${path}`, import.meta.url)), 'utf8')

  // `nuxt preview` loads .env into the server it starts, and this repo's .env has every setting,
  // so believing it refuses is how real data gets written by accident.
  it('does not tell anyone that `pnpm preview` refuses, or that nothing reads a dotenv file', async () => {
    const readme = await inRepo('README.md')
    expect(readme).not.toMatch(/`pnpm preview`[^\n]*\brefuse/)
    expect(readme).toMatch(/`pnpm preview`[^.]*\bloads `\.env`/)
    expect(await adr('0016')).not.toMatch(/a built server\s+reads no dotenv file/)
    expect(await inRepo('tests/e2e/helpers/local-drivers.ts')).not.toMatch(/a built server\s+(?:\*\s+)?reads no dotenv/)
  })

  it('leaves no test job or harness depending on it, since it would take .env', async () => {
    for (const path of ['scripts/ci-local.sh', '.github/workflows/ci.yml', 'tests/e2e/helpers/local-drivers.ts', 'tests/e2e/driver-gate.spec.ts']) {
      expect(await inRepo(path), path).not.toMatch(/(?:pnpm|nuxt) preview/)
    }
  })
})
