import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { injectedFailure } from '../../server/utils/injected-failure'

const read = (path: string) => readFile(fileURLToPath(new URL(`../../${path}`, import.meta.url)), 'utf8')

describe('the failure a stub is asked for', () => {
  it('is the one the text names', () => {
    expect(injectedFailure('canary', 'answer', 'a canary:answer:rate-limited b')).toBe('rate-limited')
  })

  it.each([undefined, ''])('is none with the canary set to %j, whatever the text says', (canary) => {
    expect(injectedFailure(canary, 'transcribe', ':transcribe:refused')).toBeNull()
    expect(injectedFailure(canary, 'transcribe', 'undefined:transcribe:refused')).toBeNull()
  })

  it('is none for another stage\'s marker', () => {
    expect(injectedFailure('canary', 'answer', 'canary:embed:refused')).toBeNull()
  })

  it('is off unless a test sets it', async () => {
    expect(await read('nuxt.config.ts')).toMatch(/stubFailureCanary: '',/)
  })

  it('is one of the settings the Worker gate is shown not to open for', async () => {
    expect(await read('scripts/verify-worker-gate.mjs')).toMatch(/NUXT_STUB_FAILURE_CANARY: /)
  })
})
