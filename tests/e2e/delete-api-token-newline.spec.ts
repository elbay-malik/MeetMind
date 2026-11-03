import { randomUUID } from 'node:crypto'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { fetch, setup, startServer } from '@nuxt/test-utils/e2e'
import { LOCAL_DRIVERS } from './helpers/local-drivers'

const rootDir = fileURLToPath(new URL('../..', import.meta.url))
const dataDir = await mkdtemp(join(tmpdir(), 'meetmind-delete-newline-'))

const TOKEN = 'e2e-admin-token-0123456789-abcdefghijklmnop'
const SHORT_TOKEN = 'e2e-short-admin-token-012345678'

/**
 * A secret store can keep a pasted newline, and a header cannot carry one to compare against,
 * so with it counted the operator is locked out with no warning, or a short token passes for
 * long enough. The invite code has the same rule. Its own spec file, as the token is process-wide.
 */
await setup({
  rootDir,
  build: false,
  nuxtConfig: { nitro: { output: { dir: join(rootDir, '.output') } } },
  env: { ...LOCAL_DRIVERS, NUXT_DATA_DIR: dataDir, NUXT_UPLOAD_TOKEN_SECRET: 'e2e-secret', NUXT_ADMIN_TOKEN: `${TOKEN}\n` },
})

const remove = (token: string) => fetch(`/api/meetings/${randomUUID()}`, { method: 'DELETE', headers: { authorization: `Bearer ${token}` } })

describe('an admin token with a pasted newline', () => {
  it('still takes the token, which reaches the route: no such meeting, not unauthorized', async () => {
    const res = await remove(TOKEN)
    expect(res.status).toBe(404)
    expect(res.headers.get('www-authenticate')).toBeNull()
  })

  it('still refuses anything else', async () => {
    const res = await remove(`${TOKEN}x`)
    expect(res.status).toBe(401)
    expect(res.headers.get('www-authenticate')).toBe('Bearer')
  })

  it('does not lift a short token over the length it must have', async () => {
    expect(`${SHORT_TOKEN}\n`).toHaveLength(32)
    await startServer({ env: { NUXT_ADMIN_TOKEN: `${SHORT_TOKEN}\n` } })
    expect((await remove(SHORT_TOKEN)).status).toBe(500)
  })

  it('counts as no token at all when it is nothing else, and the route does not exist', async () => {
    await startServer({ env: { NUXT_ADMIN_TOKEN: ' \n' } })
    const res = await remove(TOKEN)
    expect(res.status).toBe(404)
    expect(res.headers.get('www-authenticate')).toBeNull()
  })
})
