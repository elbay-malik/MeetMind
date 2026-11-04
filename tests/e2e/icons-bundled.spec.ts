import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

async function sources(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true })
  const found = await Promise.all(entries.map(entry => entry.isDirectory()
    ? sources(join(dir, entry.name))
    : Promise.resolve(/\.(vue|ts)$/.test(entry.name) ? [join(dir, entry.name)] : [])))
  return found.flat()
}

describe('the icons in the built client', () => {
  // One that is left out costs a request the rate rule counts, and stays blank during a block.
  it('has every one the app names, wherever it names it', async () => {
    const names = new Set<string>()
    for (const file of await sources('app')) {
      for (const [, name] of (await readFile(file, 'utf8')).matchAll(/i-lucide-([a-z0-9-]+)/g)) names.add(name!)
    }
    const built = '.output/public/_nuxt'
    const chunks = await Promise.all((await readdir(built)).filter(file => file.endsWith('.js')).map(file => readFile(join(built, file), 'utf8')))
    const bundle = chunks.find(chunk => /\\?"loader-circle\\?":/.test(chunk))
    expect(bundle).toBeDefined()
    expect(names.size).toBeGreaterThan(20)
    for (const name of names) expect(bundle, name).toMatch(new RegExp(`\\\\?"${name}\\\\?":`))
  })
})
