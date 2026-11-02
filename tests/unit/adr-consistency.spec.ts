import { readdir, readFile } from 'node:fs/promises'
import { relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const adrDir = fileURLToPath(new URL('../../docs/adr/', import.meta.url))

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

  it('records a guard for every route that is not a GET, so a new one cannot go unexamined', async () => {
    const apiDir = fileURLToPath(new URL('../../server/api/', import.meta.url))
    const files = (await readdir(apiDir, { recursive: true, withFileTypes: true })).filter(f => f.isFile())
    const routes = files.flatMap((file) => {
      const name = /^(.*)\.(post|put|delete|patch)\.ts$/.exec(file.name)
      if (!name) return []
      const dir = relative(apiDir, file.parentPath)
      const segments = [...dir.split('/'), name[1]!].filter(segment => segment && segment !== 'index')
      const path = segments.map(segment => segment.replace(/^\[(.+)\]$/, ':$1')).join('/')
      return [`${name[2]!.toUpperCase()} /api/${path}`]
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
