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
