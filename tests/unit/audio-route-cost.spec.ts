import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const routePath = fileURLToPath(
  new URL('../../server/api/meetings/[id]/audio.get.ts', import.meta.url),
)

/**
 * The audio route must read storage ONCE per request.
 *
 * It used to call `head` for the object's length and then `openRange` for the
 * bytes. On R2 those are two separate signed HTTP calls and therefore two
 * billable Class B operations, so the 10-million-a-month free allowance was
 * really 5 million audio requests — on a route with no authentication. The HEAD
 * also sat on the critical path of every seek, since a player issues a fresh
 * range request each time the user scrubs.
 *
 * The length now comes from the meeting row, where `complete.post.ts` already
 * verified it against storage via `inspectStoredAudio`.
 *
 * This is asserted against the source rather than through the route's responses
 * because the change is deliberately behaviour-preserving: the status codes,
 * headers and bodies are identical either way, and the request count to the
 * store is not observable through the HTTP surface the e2e tests drive. What
 * stops a regression is therefore a statement about the code, in the same
 * spirit as driver-citation-parity and ci-local-parity. The e2e tests in
 * tests/e2e/audio-api.spec.ts cover the behaviour this enables.
 */
describe('audio route storage cost', () => {
  it('reads the object once, taking its length from the meeting row', async () => {
    const source = await readFile(routePath, 'utf8')
    // Guard the guard: a path that silently read nothing would pass forever.
    expect(source.length, 'could not read the audio route').toBeGreaterThan(500)

    const storeCalls = [...source.matchAll(/\bstore\.(\w+)\(/g)].map(m => m[1]!)
    expect(
      storeCalls,
      'the audio route should reach the store exactly once, via openRange',
    ).toEqual(['openRange'])

    // Not vacuous: the length has to come from somewhere, and this is where.
    expect(
      source,
      'the window must be derived from the verified length on the meeting row',
    ).toMatch(/parseByteRange\([\s\S]*?meeting\.audioBytes\s*\)/)
  })
})
