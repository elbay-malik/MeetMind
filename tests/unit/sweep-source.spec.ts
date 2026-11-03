import { readdir, readFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { SWEEP_PACE } from '../../app/utils/pipeline-view'

/**
 * That no visitor can spend allowance through the sweeper rests on what the source does not do, so
 * this reads it. It also holds what the page says to what wrangler.jsonc makes true.
 * scripts/verify-worker-sweep.mjs shows the same under workerd, for the routes that exist.
 */

const rootDir = fileURLToPath(new URL('../..', import.meta.url))

async function sources(dir: string): Promise<Record<string, string>> {
  const found: Record<string, string> = {}
  const root = join(rootDir, dir)
  for (const entry of await readdir(root, { recursive: true, withFileTypes: true }).catch(() => [])) {
    if (!entry.isFile() || !/\.[cm]?[jt]s$/.test(entry.name)) continue
    const path = join(entry.parentPath, entry.name)
    found[relative(rootDir, path)] = await readFile(path, 'utf8')
  }
  return found
}

const SWEEP_SOURCE = /\bsweep\b|sweepOnce|runScheduledTick|reportTick|advanceUnattended|nextForSweep|pipeline\/sweep|sweep_next_meeting|scheduledEvent/i

describe('no route reaches a sweep', () => {
  it('is mentioned by nothing that answers a request', async () => {
    const answering = { ...await sources('server/api'), ...await sources('server/routes'), ...await sources('server/middleware') }
    // Guard the guard: a walk that found nothing would pass this for ever.
    expect(Object.keys(answering).length).toBeGreaterThanOrEqual(15)
    expect(Object.keys(answering).filter(file => SWEEP_SOURCE.test(answering[file]!))).toEqual([])
  })

  it('has the one way in, the cron\'s hook', async () => {
    const server = await sources('server')
    const callers = Object.keys(server).filter(file => /\brunScheduledTick\(/.test(server[file]!) && !file.endsWith('pipeline/sweep.ts'))
    expect(callers).toEqual(['server/plugins/sweeper.ts'])
    expect(server['server/plugins/sweeper.ts']).toContain('\'cloudflare:scheduled\'')
  })

  it('is imported by its hook and nothing else, under whatever name a caller would give it', async () => {
    const server = await sources('server')
    expect(Object.keys(server).filter(file => /['"][^'"]*\/sweep['"]/.test(server[file]!))).toEqual(['server/plugins/sweeper.ts'])
  })

  it('keeps what takes a step with nobody watching, and what chooses for it, to the sweep', async () => {
    const server = await sources('server')
    const naming = (pattern: RegExp) => Object.keys(server).filter(file => pattern.test(server[file]!)).sort()
    expect(naming(/\badvanceUnattended\b/)).toEqual(['server/utils/pipeline/advance.ts', 'server/utils/pipeline/sweep.ts'])
    expect(naming(/\.(nextForSweep|nextExpired)\(/)).toEqual(['server/utils/pipeline/sweep.ts'])
  })

  it('has one hook in its plugin, on the cron', async () => {
    const plugin = await readFile(join(rootDir, 'server/plugins/sweeper.ts'), 'utf8')
    expect(plugin.match(/hooks\.\w+\([^,]*/g)).toEqual(['hooks.hook(\'cloudflare:scheduled\''])
  })

  it('leaves out Nitro\'s tasks, which would add a route under dev and run on a Node server', async () => {
    const config = await readFile(join(rootDir, 'nuxt.config.ts'), 'utf8')
    expect(config).not.toMatch(/scheduledTasks|tasks:/)
    const server = await sources('server')
    expect(Object.keys(server).filter(file => /\bdefineTask\(|\brunTask\(/.test(server[file]!))).toEqual([])
  })

  it('asks for no retry before anything in the tick can fail', async () => {
    const plugin = await readFile(join(rootDir, 'server/plugins/sweeper.ts'), 'utf8')
    expect(plugin.indexOf('controller.noRetry()')).toBeGreaterThan(-1)
    expect(plugin.indexOf('controller.noRetry()')).toBeLessThan(plugin.indexOf('runScheduledTick({'))
  })
})

describe('the retention purge', () => {
  it('is reached by nothing but the tick, and only the admin route otherwise deletes', async () => {
    const server = await sources('server')
    const purgers = Object.keys(server).filter(file => /\bpurgeOneExpired\(/.test(server[file]!))
    expect(purgers).toEqual(['server/utils/pipeline/sweep.ts'])
    const deleters = Object.keys(server).filter(file => /\bdeleteMeeting\(/.test(server[file]!)).sort()
    expect(deleters).toEqual(['server/api/meetings/[id].delete.ts', 'server/utils/meeting-deletion.ts', 'server/utils/pipeline/sweep.ts'])
    const answering = { ...await sources('server/api'), ...await sources('server/routes'), ...await sources('server/middleware') }
    expect(Object.keys(answering).filter(file => /purge|retention_?purge|nextExpired|next_expired/i.test(answering[file]!))).toEqual([])
  })
})

describe('the cron', () => {
  const wrangler = async () => {
    const text = await readFile(join(rootDir, 'wrangler.jsonc'), 'utf8')
    return JSON.parse(text.split('\n').filter(line => !line.trim().startsWith('//')).join('\n')) as { triggers?: { crons?: string[] } }
  }

  it('runs every 5 minutes, and only that', async () => {
    expect((await wrangler()).triggers?.crons).toEqual(['*/5 * * * *'])
  })

  it('is what the page says it is', () => {
    expect(SWEEP_PACE).toContain('at most one step every 5 minutes')
  })
})

describe('what the documents say the purge and its promise depend on', () => {
  const text = (path: string) => readFile(join(rootDir, path), 'utf8')

  // The page reads no database (ADR-0017), so it cannot know of a demo id naming no meeting, nor of
  // a migration not applied, and an operator told otherwise would not look.
  it('tells the operator the upload page can promise deletion while nothing is deleted', async () => {
    const [readme, env, adr] = await Promise.all([text('README.md'), text('.env.example'), text('docs/adr/0017-retention-purge.md')])
    expect(readme).not.toContain('only while all that is so')
    expect(readme).toContain('it goes on promising deletion in both of those cases')
    expect(env).not.toContain('promises deletion only while it is really on')
    expect(env).toContain('deletes nothing while the page still promises it')
    expect(adr).toContain('A purge migration not applied')
  })

  it('says what a migration not applied logs, which is no reason', async () => {
    const readme = await text('README.md')
    expect(readme).not.toContain('or it does nothing and logs why')
    expect(readme).toContain('`sweep failed: Error`')
  })
})

describe('what the documents say a tick costs questions', () => {
  // A tick spends the shared daily allowance whoever is watching, and counts none of it. The slot's
  // arithmetic is right, and it is not the whole of what a question can be refused by.
  it('does not call questions safe by the slot alone, and names the daily allowance', async () => {
    const adr = await readFile(join(rootDir, 'docs/adr/0012-pipeline-orchestration.md'), 'utf8')
    expect(adr).not.toContain('Questions share the Groq slot, and are not starved by this.')
    expect(adr).toContain('the slot does not starve them, and the daily allowance can')
    expect(adr).toContain('about 44 chunks')
    expect(adr).toContain('**No daily budget for a tick.**')
  })

  it('agrees on how many one-hour meetings that allowance is, in every ADR that says', async () => {
    const [orchestration, embeddings] = await Promise.all([
      readFile(join(rootDir, 'docs/adr/0012-pipeline-orchestration.md'), 'utf8'),
      readFile(join(rootDir, 'docs/adr/0014-workers-ai-embeddings.md'), 'utf8'),
    ])
    for (const adr of [orchestration, embeddings]) {
      expect(adr).not.toMatch(/40(–| to )45/)
    }
    expect(orchestration).toContain('Groq\'s 200K TPD (about 5 one-hour meetings,')
  })
})

describe('what the documents say of a meeting past the ones looked at', () => {
  // A complete meeting's row never moves again, so those ahead of a finished transcript stay
  // ahead. tests/unit/helpers/sweep-cases.ts holds the limit itself, on both drivers.
  it('does not tell a finished meeting to wait for those ahead of it, which never ends', async () => {
    const [sql, adr] = await Promise.all([
      readFile(join(rootDir, 'supabase/migrations/20261103180000_sweeper.sql'), 'utf8'),
      readFile(join(rootDir, 'docs/adr/0012-pipeline-orchestration.md'), 'utf8'),
    ])
    expect(sql).not.toMatch(/a\s+(--\s+)?meeting waits for those ahead of it to move, or for a tab/)
    expect(sql).toContain('waits for a tab alone')
    expect(adr).not.toContain('So a meeting past those 50 waits for the ones ahead of it to move, or for a tab.')
    expect(adr).toContain('A finished transcript past its 50 needs a tab, and nothing else')
  })
})
