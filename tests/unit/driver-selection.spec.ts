import { describe, expect, it } from 'vitest'
import { decideDrivers, REQUIRED_SETTINGS } from '../../server/utils/drivers'

/**
 * The decision alone. tests/unit/driver-gate.spec.ts runs it through what actually builds a
 * driver, and tests/e2e/driver-gate.spec.ts through a real production build.
 */

const ALL_KEYS = Object.values(REQUIRED_SETTINGS).flatMap(group => Object.values(group))
const every = Object.fromEntries(ALL_KEYS.map(key => [key, 'set']))

/** Every setting but the ones of these groups. */
const allBut = (...groups: (keyof typeof REQUIRED_SETTINGS)[]): Record<string, unknown> => {
  const gone: string[] = groups.flatMap(group => Object.values(REQUIRED_SETTINGS[group]))
  return Object.fromEntries(Object.entries(every).filter(([key]) => !gone.includes(key)))
}

const GROUP_NAMES = Object.keys(REQUIRED_SETTINGS) as (keyof typeof REQUIRED_SETTINGS)[]
const built = { dev: false, worker: false }
const dev = { dev: true, worker: false }
const worker = { dev: false, worker: true }
const optIn = { allowLocalDrivers: true }
const allReal = { groq: true, workersAi: true, supabase: true, r2: true }
const allLocal = { groq: false, workersAi: false, supabase: false, r2: false }

describe('with every setting present', () => {
  it.each([['a built server', built], ['a Worker', worker], ['pnpm dev', dev]])('runs on the real services on %s, with no opt-in', (_name, environment) => {
    expect(decideDrivers(every, environment)).toEqual({ refused: false, real: allReal })
  })

  it('runs on them whatever the opt-in says', () => {
    expect(decideDrivers({ ...every, ...optIn }, built)).toEqual({ refused: false, real: allReal })
    expect(decideDrivers({ ...every, ...optIn }, worker)).toEqual({ refused: false, real: allReal })
  })

  it('knows of all nine', () => {
    expect(ALL_KEYS).toHaveLength(9)
  })
})

describe('on a built server with no opt-in', () => {
  it('refuses with nothing set, and names all nine', () => {
    const decision = decideDrivers({}, built)
    expect(decision).toMatchObject({ refused: true })
    expect(decision.refused && decision.missing).toEqual(Object.values(REQUIRED_SETTINGS).flatMap(group => Object.keys(group)))
  })

  it.each(GROUP_NAMES)('refuses with only %s missing, and names it', (group) => {
    expect(decideDrivers(allBut(group), built)).toMatchObject({ refused: true, missing: Object.keys(REQUIRED_SETTINGS[group]) })
  })

  it.each(ALL_KEYS)('refuses with only %s missing', (key) => {
    const { [key]: _gone, ...rest } = every
    expect(decideDrivers(rest, built)).toMatchObject({ refused: true })
  })

  // What a secret store or an env parser can leave behind, none of it a key.
  it.each([[''], ['   '], ['\n'], [null], [undefined], [true], [false], [{}], [[]]])('counts %j as missing', (value) => {
    expect(decideDrivers({ ...every, groqApiKey: value }, built)).toMatchObject({ refused: true, missing: ['NUXT_GROQ_API_KEY'] })
  })

  // destr turns an all-digit variable into a number, which is still the value given.
  it('counts a number as set', () => {
    expect(decideDrivers({ ...every, r2AccountId: 123 }, built)).toMatchObject({ refused: false })
  })
})

describe('the opt-in', () => {
  it('lets a built server with nothing set run on stubs and local stores', () => {
    expect(decideDrivers(optIn, built)).toEqual({ refused: false, real: allLocal })
  })

  // Only what destr makes of `true`. A stray value must not turn stubs on.
  it.each([['1', 1], ['yes', 'yes'], ['on', 'on'], ['"true"', 'true'], ['false', false], ['0', 0], ['empty', ''], ['{}', {}]])('does nothing when it is %s', (_name, value) => {
    expect(decideDrivers({ allowLocalDrivers: value }, built)).toMatchObject({ refused: true })
  })

  it('is not needed by pnpm dev, which runs on stubs and local stores as it always has', () => {
    expect(decideDrivers({}, dev)).toEqual({ refused: false, real: allLocal })
  })

  it('is ignored outright on a Worker, and so is being in dev', () => {
    expect(decideDrivers(optIn, worker)).toMatchObject({ refused: true })
    expect(decideDrivers(optIn, { dev: true, worker: true })).toMatchObject({ refused: true })
    expect(decideDrivers({ ...allBut('groq'), ...optIn }, worker)).toMatchObject({ refused: true, missing: ['NUXT_GROQ_API_KEY'] })
  })
})

// The exact shape of the hazard: a real database, a key missing, and someone clicking index.
describe.each([['with the opt-in', built, optIn], ['in pnpm dev', dev, {}]])('the stored-data rule, %s', (_name, environment, extra) => {
  it.each(GROUP_NAMES.filter(group => group !== 'supabase'))('refuses a real database with %s absent', (group) => {
    expect(decideDrivers({ ...allBut(group), ...extra }, environment)).toMatchObject({ refused: true, missing: Object.keys(REQUIRED_SETTINGS[group]) })
  })

  it('refuses a real database and nothing else', () => {
    expect(decideDrivers({ ...allBut('groq', 'workersAi', 'r2'), ...extra }, environment)).toMatchObject({ refused: true })
  })

  it('refuses a real bucket on a local database, whose rows its budget is counted from', () => {
    expect(decideDrivers({ ...allBut('supabase'), ...extra }, environment)).toMatchObject({ refused: true, missing: Object.keys(REQUIRED_SETTINGS.supabase) })
    expect(decideDrivers({ ...allBut('supabase', 'groq', 'workersAi'), ...extra }, environment)).toMatchObject({ refused: true })
  })

  // Real output in a throwaway store harms nothing, and it is how a provider gets tried.
  it.each([
    ['Groq', allBut('workersAi', 'supabase', 'r2'), { ...allLocal, groq: true }],
    ['Workers AI', allBut('groq', 'supabase', 'r2'), { ...allLocal, workersAi: true }],
    ['both', allBut('supabase', 'r2'), { ...allLocal, groq: true, workersAi: true }],
  ])('allows a real provider on local stores: %s', (_which, settings, real) => {
    expect(decideDrivers({ ...settings, ...extra }, environment)).toEqual({ refused: false, real })
  })
})

// Silently using a local driver here would write production audio to a container
// filesystem while looking like it worked.
describe.each([['with the opt-in', built, optIn], ['in pnpm dev', dev, {}]])('half a group of settings, %s', (_name, environment, extra) => {
  it.each([
    [{ r2AccountId: 'x', r2AccessKeyId: 'x' }, ['NUXT_R2_SECRET_ACCESS_KEY', 'NUXT_R2_BUCKET']],
    [{ supabaseUrl: 'x' }, ['NUXT_SUPABASE_SERVICE_KEY']],
    [{ supabaseServiceKey: 'x' }, ['NUXT_SUPABASE_URL']],
    [{ workersAiAccountId: 'x' }, ['NUXT_WORKERS_AI_API_TOKEN']],
    [{ workersAiApiToken: 'x' }, ['NUXT_WORKERS_AI_ACCOUNT_ID']],
  ])('refuses %j, naming what is missing from it', (settings, missing) => {
    const decision = decideDrivers({ ...settings, ...extra }, environment)
    expect(decision).toMatchObject({ refused: true, missing })
    expect(decision.refused && decision.reason).toMatch(/half a group/)
  })

  it('names every half of every group', () => {
    expect(decideDrivers({ supabaseUrl: 'x', workersAiApiToken: 'x', ...extra }, environment))
      .toMatchObject({ refused: true, missing: ['NUXT_WORKERS_AI_ACCOUNT_ID', 'NUXT_SUPABASE_SERVICE_KEY'] })
  })
})

describe('what it says', () => {
  it('holds names and reasons, never a value', () => {
    const decision = decideDrivers({ ...allBut('groq'), r2Bucket: 'value-of-the-bucket', supabaseServiceKey: 'value-of-the-key' }, built)
    expect(JSON.stringify(decision)).not.toContain('value-of')
  })
})
