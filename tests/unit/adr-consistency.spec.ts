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

describe('ADRs changed by ADR-0017', () => {
  it('every ADR it names in its header says so in its own status', async () => {
    const header = /^- \*\*Supersedes:\*\* (.*)$/m.exec(await adr('0017'))?.[1]
    expect(header, 'could not find the header line of ADR-0017').toBeTruthy()
    const named = [...new Set([...header!.matchAll(/ADR-(\d{4})/g)].map(m => m[1]!))]
    expect(named).toEqual(expect.arrayContaining(['0011', '0012', '0013']))
    const silent: string[] = []
    for (const number of named) {
      const status = /^- \*\*Status:\*\* (.*)$/m.exec(await adr(number))?.[1] ?? ''
      if (!status.includes('ADR-0017')) silent.push(number)
    }
    expect(silent).toEqual([])
  })

  it('marks what it changes where a reader of ADR-0013 will land', async () => {
    const decision = (await adr('0013')).split('### 4.')[1]!.split('### 5.')[0]!.replace(/\s+/g, ' ')
    expect(decision).toContain('Amended by [ADR-0017]')
  })

  it('says it stays off, and what waits for Phase 13', async () => {
    const text = (await adr('0017')).replace(/\s+/g, ' ')
    expect(text).toContain('off until the user turns it on')
    expect(text).toContain('## What stays unproven until Phase 13')
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

describe.each([
  ['0018', '0018-ffmpeg-wasm-from-private-r2.md', ['0009', '0010']],
  ['0019', '0019-demo-question-cap.md', ['0012', '0015']],
])('ADRs changed by ADR-%s', (number, file, amended) => {
  it('every ADR it names in its header says so in its own status', async () => {
    const header = /^- \*\*Supersedes:\*\* (.*)$/m.exec(await adr(number))?.[1]
    expect(header, `could not find the header line of ADR-${number}`).toBeTruthy()
    const named = [...new Set([...header!.matchAll(/ADR-(\d{4})/g)].map(m => m[1]!))]
    expect(named).toEqual(expect.arrayContaining(amended))
    const silent: string[] = []
    for (const other of named) {
      const status = /^- \*\*Status:\*\* (.*)$/m.exec(await adr(other))?.[1] ?? ''
      if (!status.includes(`ADR-${number}`)) silent.push(other)
    }
    expect(silent).toEqual([])
  })

  it('is in the README\'s index', async () => {
    const readme = await readFile(fileURLToPath(new URL('../../README.md', import.meta.url)), 'utf8')
    expect(readme.split('\n').some(line => line.startsWith(`| [${number}](docs/adr/${file})`))).toBe(true)
  })

  it('says what stays unproven, and claims nothing of a deployed Worker', async () => {
    const text = (await adr(number)).replace(/\s+/g, ' ')
    expect(text).toContain('## What stays unproven until deployed')
    expect(text).toContain('**not yet deployed**')
  })
})

describe('what ADR-0019 tells a reader about a stopped extraction', () => {
  it('says a failed one holds the demo\'s questions, in the ADR and the README', async () => {
    const flat = (text: string) => text.replace(/\s+/g, ' ')
    expect(flat(await adr('0019'))).toContain('A meeting that failed at extraction holds the demo\'s questions')
    const readme = await readFile(fileURLToPath(new URL('../../README.md', import.meta.url)), 'utf8')
    expect(flat(readme)).toContain('including one that failed and has not been retried or deleted')
  })

  it('does not claim a stopped row always wants its slots, or that a retry always ends the pause', async () => {
    const flat = (text: string) => text.replace(/\s+/g, ' ')
    const text = flat(await adr('0019'))
    expect(text).not.toMatch(/still wanting its slots/)
    expect(text).not.toContain('then retry or delete it')
    const { tooManyChunksMessage } = await import('../../server/utils/summary/steps')
    expect(tooManyChunksMessage(41)).toContain('This transcript would need')
    expect(text).toContain('`This transcript would need N sequential requests`, `refusedAsTooLong`) cannot be retried')
    expect(text).toContain('only the admin delete ends that pause')
    expect(text).toContain('a tick retries no failed stage')
    expect(text).toContain('with no end and nothing logged')
    const readme = flat(await readFile(fileURLToPath(new URL('../../README.md', import.meta.url)), 'utf8'))
    expect(readme).toContain('No tick retries that one, nothing logs the pause, and a meeting refused as too long can only be deleted.')
  })
})

describe('the first deploy\'s steps', () => {
  const inRepo = (path: string) => readFile(fileURLToPath(new URL(`../../${path}`, import.meta.url)), 'utf8')
  const steps = async () => (await inRepo('README.md')).split('### Deploying the Worker')[1]!.split('\n## ')[0]!.replace(/\s+/g, ' ')

  it('says nothing has been deployed, and nothing claims it has', async () => {
    const text = await steps()
    expect(text).toContain('Nothing has been deployed yet.')
    expect(text).not.toMatch(/is live at|has been deployed to|now deployed/i)
  })

  it('come in the order that works', async () => {
    const text = await steps()
    const order = ['pnpm ci:local', 'pnpm db:migrate', 'pnpm upload:ffmpeg-wasm', 'r2 bucket cors set', 'pnpm secrets:worker', 'pnpm deploy:worker', 'Rate limiting rules', 'reach `ready`', 'wrangler secret put NUXT_PUBLIC_DEMO_MEETING_ID']
    const places = order.map(words => text.indexOf(words))
    expect(places).not.toContain(-1)
    expect(places).toEqual([...places].sort((a, b) => a - b))
  })

  it('name every secret the script sends, and warn off the whole file', async () => {
    const { WORKER_SECRET_NAMES } = await import('../../scripts/lib/worker-secrets.mjs')
    const text = await steps()
    for (const name of WORKER_SECRET_NAMES) expect(text).toContain(`\`${name}\``)
    expect(text).toContain('Never `wrangler secret bulk .env`')
  })

  it('say what must not run during acceptance, and that last_tick_at is no proof', async () => {
    const text = await steps()
    expect(text).toContain('`pnpm test:services`, and a local server on `.env`, must not run during acceptance')
    expect(text).toContain('Past Cron Events is the proof')
    expect(text).toMatch(/`last_tick_at` is not.*`test:services` moves it/)
  })

  it('say how to roll back, and how to stop the ticks', async () => {
    const text = await steps()
    expect(text).toContain('wrangler rollback')
    expect(text).toContain('"crons": []')
  })

  it('stop the ticks with no deploy, which would put back the code just rolled back from', async () => {
    const text = await steps()
    expect(text).not.toMatch(/"crons": \[\]` in `wrangler\.jsonc` and run `pnpm deploy:worker`/)
    expect(text).toContain('set `"crons": []` in `wrangler.jsonc` and run `pnpm exec wrangler triggers deploy`')
    expect(text).toContain('Do not use `pnpm deploy:worker` for this after a rollback')
  })

  it('say a rollback past step 10 loses the demo\'s id, and give a way that does not', async () => {
    const text = await steps()
    expect(text).toContain('`pnpm exec wrangler rollback <version-id>`')
    expect(text).toContain('Once step 10 is done, roll back only to a version created after it.')
    expect(text).toContain('There the demo has no question count, no pause for extraction and no read-only guard')
    expect(text).toContain('`pnpm exec wrangler versions secret list`')
    expect(text).toContain('wrangler refuses `wrangler secret put` while the latest version is not the deployed one')
    expect(text).not.toMatch(/put(ting)? `?NUXT_PUBLIC_DEMO_MEETING_ID`? again/i)
    expect(await adr('0019')).toContain('**A rollback can drop the cap.**')
  })

  it('claim the rate rule\'s bound only with what makes it true, and say what the fallback gives up', async () => {
    const text = await steps()
    expect(text).toContain('so `run_worker_first` in `wrangler.jsonc` keeps everything under `/_nuxt/` away from the Worker, found or not')
    expect(text).toContain('use `/api/`, `/meetings` and `/ffmpeg/`, which gives up that bound')
    expect(text).toContain('`/%5Fnuxt/no-such-file`')
    expect(await adr('0019')).toContain('hold one address to about 86,000 requests a day at the edge')
  })

  it('leave no database backups to configure, and the playbook says why', async () => {
    const playbook = await inRepo('docs/PLAYBOOK.md')
    expect(playbook).not.toMatch(/Configure DB backups|automated DB backups/)
    expect(playbook).toContain('**No database backups for this demo:**')
    expect(playbook).toContain('the demo can be recreated from its recording')
  })

  it('say what licence the ffmpeg core has, as the package declares it, and where its source is', async () => {
    const { FFMPEG_CORE_LICENSE, FFMPEG_CORE_PACKAGE, FFMPEG_CORE_SOURCE_URL, FFMPEG_CORE_VERSION } = await import('../../shared/utils/ffmpeg-core')
    const license = (await inRepo('README.md')).split('\n## License')[1]!.replace(/\s+/g, ' ')
    expect(license).toContain(`\`${FFMPEG_CORE_PACKAGE}\` ${FFMPEG_CORE_VERSION}`)
    expect(license).toContain(`\`${FFMPEG_CORE_LICENSE}\``)
    expect(license).toContain(FFMPEG_CORE_SOURCE_URL)
    expect(license).toContain('not legal advice')
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

  // They are bundled and refused, and ADR-0016 rejects leaving them out at build time, so
  // only the refusal keeps them from running. Said otherwise, a regression there looks harmless.
  it('does not say the stand-ins are absent from a Worker', async () => {
    const row = (await inRepo('README.md')).split('\n').find(line => line.startsWith('| [0016]'))
    expect(row, 'could not find the ADR-0016 row of the index').toBeTruthy()
    expect(row).not.toMatch(/do not exist/)
    expect(row).toMatch(/refused[^|]*on a Worker/)
  })

  it('leaves no test job or harness depending on it, since it would take .env', async () => {
    for (const path of ['scripts/ci-local.sh', '.github/workflows/ci.yml', 'tests/e2e/helpers/local-drivers.ts', 'tests/e2e/driver-gate.spec.ts']) {
      expect(await inRepo(path), path).not.toMatch(/(?:pnpm|nuxt) preview/)
    }
  })
})
