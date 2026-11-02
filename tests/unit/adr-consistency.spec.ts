import { readdir, readFile } from 'node:fs/promises'
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
    expect(named).toEqual(expect.arrayContaining(['0007', '0008', '0012', '0013']))
    const silent: string[] = []
    for (const number of named) {
      const status = /^- \*\*Status:\*\* (.*)$/m.exec(await adr(number))?.[1] ?? ''
      if (!status.includes('ADR-0014')) silent.push(number)
    }
    expect(silent).toEqual([])
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
