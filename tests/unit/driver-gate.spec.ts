import { readdir, readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { H3Event } from 'h3'
import { DRIVERS_REFUSED_MESSAGE, isDriverRefusal, REQUIRED_SETTINGS } from '../../server/utils/drivers'
import { withoutInternals } from '../../server/utils/pipeline/errors'
import { REAL_SETTINGS_ABSENT } from '../e2e/helpers/local-drivers'

/**
 * The gate through what actually builds a driver, with no network: this tier runs as a built
 * server, with `import.meta.dev` false. Each selector is any `use*` that a file under server/
 * exports, found on disk, so one added later is covered without being named, in a new module too.
 */

const useRuntimeConfig = vi.hoisted(() => vi.fn())
// Auto-imported from Nuxt's app runtime in this tier, so not a global to stub.
vi.mock('#app/nuxt', async importOriginal => ({ ...await importOriginal<object>(), useRuntimeConfig }))

const MODULES = {
  db: await import('../../server/utils/db'),
  storage: await import('../../server/utils/storage'),
  transcription: await import('../../server/utils/transcription'),
  summary: await import('../../server/utils/summary'),
  qa: await import('../../server/utils/qa'),
  deps: await import('../../server/utils/pipeline/deps'),
}

type Selector = (event: H3Event) => unknown

const EXPORTS_A_SELECTOR = /^export\s+(?:async\s+)?(?:function|const)\s+use[A-Z]|^export\s*\{[^}]*\buse[A-Z]/m

const SERVER_SOURCES = import.meta.glob<string>('../../server/**/*.ts', { query: '?raw', import: 'default', eager: true })
const SERVER_MODULES = import.meta.glob('../../server/**/*.ts')
const SELECTION_MODULES = Object.keys(SERVER_SOURCES).filter(path => EXPORTS_A_SELECTOR.test(SERVER_SOURCES[path]!))

const SELECTORS = (await Promise.all(SELECTION_MODULES.map(path => SERVER_MODULES[path]!())))
  .flatMap(module => Object.entries(module as Record<string, unknown>))
  .filter((entry): entry is [string, Selector] => /^use[A-Z]/.test(entry[0]) && typeof entry[1] === 'function')

/** Every `kind` a selector's result holds, in it or in the bundle of drivers it returns. */
function kindsIn(value: unknown, depth = 3): string[] {
  if (depth === 0 || typeof value !== 'object' || value === null) return []
  const { kind } = value as { kind?: unknown }
  return [
    ...typeof kind === 'string' ? [kind] : [],
    ...Object.values(value).flatMap(inner => kindsIn(inner, depth - 1)),
  ]
}

const KEYS = Object.values(REQUIRED_SETTINGS).flatMap(group => Object.values(group))
/** A value per setting, each one recognisable, so a test can look for it in what was said. */
const EVERY_SETTING = Object.fromEntries(KEYS.map(key => [key, `value-of-${key}`]))
EVERY_SETTING.supabaseUrl = 'https://example.invalid'

const ALL_BUT = (group: keyof typeof REQUIRED_SETTINGS) => Object.fromEntries(
  Object.entries(EVERY_SETTING).filter(([key]) => !(Object.values(REQUIRED_SETTINGS[group]) as string[]).includes(key)),
)

/** Everything a real selection has no business reading. */
const LOCAL_ONLY = {
  dataDir: 'unused-data-dir',
  uploadTokenSecret: 'unused-secret',
  transcribeStubQuotaFail: true,
  summaryStubCanary: true,
  summaryStubFailOnceRetryable: true,
  answerStubPaced: true,
  embedStubQuotaCanary: 'canary',
}

const INTERVALS = { groqChatIntervalMs: 60_000, embedIntervalMs: 1000, askMaxSlotWaitMs: 20_000 }

const OK_EVENT = { context: {} } as H3Event
const fetched = vi.fn(async () => new Response('no real calls in this tier', { status: 500 }))
let logged: ReturnType<typeof vi.spyOn>

function configure(settings: Record<string, unknown>) {
  useRuntimeConfig.mockReturnValue({ ...INTERVALS, ...settings })
}

function refusalOf(act: () => unknown): { statusCode?: number, message?: string } {
  try {
    act()
  }
  catch (err) {
    return err as { statusCode?: number, message?: string }
  }
  throw new Error('it did not refuse')
}

beforeEach(() => {
  vi.stubGlobal('fetch', fetched)
  fetched.mockClear()
  logged = vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'info').mockImplementation(() => {})
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('the selectors it walks', () => {
  it.each([
    ['a function', 'export function useReranker(event: H3Event) {}'],
    ['a constant', 'export const useReranker = (event: H3Event) => {}'],
    ['an async function', 'export async function useReranker(event: H3Event) {}'],
    ['a list', 'export { other, useReranker }'],
    ['a list across lines', 'export {\n  other,\n  useReranker,\n}'],
  ])('include one exported as %s, wherever it is', (_name, source) => {
    expect(EXPORTS_A_SELECTOR.test(source)).toBe(true)
  })

  it('leave out a name that only looks like one, or is not exported', () => {
    expect(EXPORTS_A_SELECTOR.test('function useInternal() {}\nexport function user() {}')).toBe(false)
  })

  it('include every module that calls the gate', () => {
    const callers = Object.keys(SERVER_SOURCES).filter(path => /\bselectDriver(?:<[^(]*>)?\(/.test(SERVER_SOURCES[path]!) && !path.endsWith('/drivers.ts'))
    // Guard the guard: a pattern that stopped matching would pass this for ever.
    expect(callers.length).toBeGreaterThanOrEqual(5)
    expect(SELECTION_MODULES).toEqual(expect.arrayContaining(callers))
  })

  it('tells a stand-in from a real driver inside a bundle', () => {
    expect(kindsIn({ transcriber: { kind: 'stub' }, meetings: { kind: 'supabase' } })).toEqual(['stub', 'supabase'])
    expect(kindsIn({ kind: 'local' })).toEqual(['local'])
    expect(kindsIn(undefined)).toEqual([])
  })

  // Guard the guard: a walk that found nothing would pass everything below.
  it('include every selection point there is today', () => {
    expect(SELECTORS.map(([name]) => name).sort()).toEqual(expect.arrayContaining([
      'useAnswerer',
      'useAudioStore',
      'useEmbedder',
      'useExtractionStepDeps',
      'useGroqChatPacer',
      'useIndexingStepDeps',
      'useMeetingRepository',
      'usePipelineDeps',
      'usePipelineRepository',
      'useSlotRepository',
      'useStepEmbedder',
      'useStepSummarizer',
      'useSummarizer',
      'useSummaryRepository',
      'useTranscriber',
      'useTranscriptIndexRepository',
      'useTranscriptRepository',
      'useTranscriptionStepDeps',
    ]))
  })
})

// Each of these is a server that must change nothing, whichever selector it reaches first.
describe.each<[string, Record<string, unknown>, H3Event]>([
  ['nothing set, no opt-in', {}, OK_EVENT],
  ['stub flags set, no opt-in', LOCAL_ONLY, OK_EVENT],
  ['Groq missing', ALL_BUT('groq'), OK_EVENT],
  ['Workers AI missing', ALL_BUT('workersAi'), OK_EVENT],
  ['Supabase missing', ALL_BUT('supabase'), OK_EVENT],
  ['R2 missing', ALL_BUT('r2'), OK_EVENT],
  ['Groq missing, with the opt-in', { ...ALL_BUT('groq'), allowLocalDrivers: true }, OK_EVENT],
  ['Workers AI missing, with the opt-in', { ...ALL_BUT('workersAi'), allowLocalDrivers: true }, OK_EVENT],
  ['R2 missing, with the opt-in', { ...ALL_BUT('r2'), allowLocalDrivers: true }, OK_EVENT],
  ['half of R2, with the opt-in', { r2AccountId: 'x', allowLocalDrivers: true }, OK_EVENT],
  ['half of Supabase, with the opt-in', { supabaseUrl: 'x', allowLocalDrivers: true }, OK_EVENT],
  ['half of Workers AI, with the opt-in', { workersAiApiToken: 'x', allowLocalDrivers: true }, OK_EVENT],
  ['a Worker by its request context, with the opt-in and every flag', { ...LOCAL_ONLY, allowLocalDrivers: true }, { context: { cloudflare: {} } } as unknown as H3Event],
])('%s', (_name, settings, event) => {
  it.each(SELECTORS)('%s answers 503 in the one generic message, and calls nothing', (_selector, select) => {
    configure(settings)
    const refusal = refusalOf(() => select(event))
    expect(refusal.statusCode).toBe(503)
    expect(refusal.message).toBe(DRIVERS_REFUSED_MESSAGE)
    expect(fetched).not.toHaveBeenCalled()
  })
})

describe('on a Worker known by what the runtime says it is', () => {
  it.each(SELECTORS)('%s refuses the opt-in', (_selector, select) => {
    vi.stubGlobal('navigator', { userAgent: 'Cloudflare-Workers' })
    configure({ ...LOCAL_ONLY, allowLocalDrivers: true })
    expect(refusalOf(() => select(OK_EVENT)).statusCode).toBe(503)
  })
})

describe('the message', () => {
  it('names no provider, store or setting', () => {
    expect(DRIVERS_REFUSED_MESSAGE).not.toMatch(/nuxt|groq|workers|cloudflare|supabase|r2\b|key|token|setting|config/i)
  })
})

describe('with every setting present', () => {
  const byGroup = {
    groq: [MODULES.transcription.useTranscriber, MODULES.summary.useSummarizer, MODULES.summary.useStepSummarizer, MODULES.qa.useAnswerer],
    workersAi: [MODULES.qa.useEmbedder, MODULES.qa.useStepEmbedder],
    supabase: [MODULES.db.useMeetingRepository, MODULES.db.useTranscriptRepository, MODULES.db.useSummaryRepository, MODULES.db.useTranscriptIndexRepository, MODULES.db.useSlotRepository, MODULES.db.usePipelineRepository],
    r2: [MODULES.storage.useAudioStore],
  }

  const expected = { groq: 'groq', workersAi: 'workers-ai', supabase: 'supabase', r2: 'r2' }

  /** Any read of a local driver's setting or a stub's flag throws, so a real path cannot even look at one. */
  const settingsThatForbidLocalOnes = new Proxy(EVERY_SETTING, {
    get(target, key) {
      if (typeof key === 'string' && key in LOCAL_ONLY) throw new Error(`read ${key} on the real path`)
      return target[key as string]
    },
  })

  it.each(['no opt-in', 'the opt-in'])('selects the real driver of every group, with %s, calling nothing', (which) => {
    configure(which === 'no opt-in' ? EVERY_SETTING : { ...EVERY_SETTING, allowLocalDrivers: true })
    for (const [group, selectors] of Object.entries(byGroup)) {
      for (const select of selectors) {
        expect((select(OK_EVENT) as { kind: string }).kind, `${group} ${select.name}`).toBe(expected[group as keyof typeof expected])
      }
    }
    expect(fetched).not.toHaveBeenCalled()
  })

  it.each(SELECTORS)('%s reads no flag or local setting, so neither can change what it does', (_selector, select) => {
    useRuntimeConfig.mockReturnValue(new Proxy(settingsThatForbidLocalOnes, {
      get: (target, key) => key in INTERVALS ? INTERVALS[key as keyof typeof INTERVALS] : Reflect.get(target, key),
    }))
    expect(() => select(OK_EVENT)).not.toThrow()
    expect(fetched).not.toHaveBeenCalled()
    expect(logged).not.toHaveBeenCalled()
  })

  it.each(SELECTORS)('%s holds no stub or local driver, once the gate has let it through', (_selector, select) => {
    configure(EVERY_SETTING)
    expect(kindsIn(select(OK_EVENT)).filter(kind => kind === 'stub' || kind === 'local')).toEqual([])
  })

  it('does the same on a Worker, which needs no opt-in', () => {
    configure(EVERY_SETTING)
    const worker = { context: { cloudflare: {} } } as unknown as H3Event
    expect(MODULES.transcription.useTranscriber(worker).kind).toBe('groq')
    expect(MODULES.db.useMeetingRepository(worker).kind).toBe('supabase')
    expect(MODULES.storage.useAudioStore(worker).kind).toBe('r2')
    expect(MODULES.qa.useEmbedder(worker).kind).toBe('workers-ai')
  })
})

describe('with the opt-in and nothing set', () => {
  it('selects a stand-in for every group', () => {
    configure({ allowLocalDrivers: true, dataDir: '.data', uploadTokenSecret: 's' })
    expect(MODULES.transcription.useTranscriber(OK_EVENT).kind).toBe('stub')
    expect(MODULES.summary.useSummarizer(OK_EVENT).kind).toBe('stub')
    expect(MODULES.summary.useStepSummarizer(OK_EVENT).kind).toBe('stub')
    expect(MODULES.qa.useAnswerer(OK_EVENT).kind).toBe('stub')
    expect(MODULES.qa.useEmbedder(OK_EVENT).kind).toBe('stub')
    expect(MODULES.qa.useStepEmbedder(OK_EVENT).kind).toBe('stub')
    expect(MODULES.db.useMeetingRepository(OK_EVENT).kind).toBe('local')
    expect(MODULES.storage.useAudioStore(OK_EVENT).kind).toBe('local')
  })

  it('lets a stub flag through, which is the only place it does anything', async () => {
    configure({ allowLocalDrivers: true, embedStubQuotaCanary: 'canary' })
    await expect(MODULES.qa.useEmbedder(OK_EVENT).embedDocuments(['the canary'])).rejects.toThrow(/free daily limit/)
  })

  it('uses the real provider beside local stores when its settings are there', () => {
    configure({ allowLocalDrivers: true, dataDir: '.data', groqApiKey: 'k' })
    expect(MODULES.transcription.useTranscriber(OK_EVENT).kind).toBe('groq')
    expect(MODULES.qa.useEmbedder(OK_EVENT).kind).toBe('stub')
    expect(MODULES.db.useMeetingRepository(OK_EVENT).kind).toBe('local')
  })
})

describe('what reaches the log', () => {
  /** A fresh module, since what it has logged lives there for as long as the process does. */
  const fresh = async () => {
    vi.resetModules()
    return await import('../../server/utils/drivers')
  }

  it('names what is missing, once, however many requests are refused', async () => {
    const { requireDrivers } = await fresh()
    configure(ALL_BUT('workersAi'))
    for (let i = 0; i < 50; i++) expect(() => requireDrivers(OK_EVENT)).toThrow()
    expect(logged).toHaveBeenCalledTimes(1)
    const line = String(logged.mock.calls[0]![0])
    expect(line).toContain('NUXT_WORKERS_AI_ACCOUNT_ID, NUXT_WORKERS_AI_API_TOKEN')
    expect(line).not.toContain('NUXT_GROQ_API_KEY')
  })

  it('never holds a value, whatever is set', async () => {
    const { requireDrivers } = await fresh()
    configure({ ...ALL_BUT('groq'), allowLocalDrivers: true })
    expect(() => requireDrivers(OK_EVENT)).toThrow()
    expect(logged).toHaveBeenCalledTimes(1)
    expect(String(logged.mock.calls[0]![0])).toContain('NUXT_GROQ_API_KEY')
    expect(JSON.stringify(logged.mock.calls)).not.toMatch(/value-of|example\.invalid/)
  })

  it('says nothing when it is not refusing', async () => {
    const { requireDrivers } = await fresh()
    configure(EVERY_SETTING)
    requireDrivers(OK_EVENT)
    expect(logged).not.toHaveBeenCalled()
  })
})

// The pipeline routes turn anything they catch into a 500 that names nothing. This one
// names nothing already, and a 500 would log it for every request and hide what it is.
describe('withoutInternals', () => {
  it('lets the refusal through as it is, and logs nothing more', async () => {
    const warned = vi.spyOn(console, 'warn').mockImplementation(() => {})
    configure({})
    const refusal = await withoutInternals(async () => MODULES.db.useMeetingRepository(OK_EVENT)).catch((err: unknown) => err)
    expect(isDriverRefusal(refusal)).toBe(true)
    expect(refusal).toMatchObject({ statusCode: 503, message: DRIVERS_REFUSED_MESSAGE })
    expect(warned).not.toHaveBeenCalled()
  })

  it('still hides anything else that is a 503', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const provider503 = Object.assign(new Error('Groq says no, org_123'), { statusCode: 503 })
    await expect(withoutInternals(async () => {
      throw provider503
    })).rejects.toMatchObject({ statusCode: 500, message: expect.not.stringContaining('Groq') })
  })
})

// A new credential in nuxt.config.ts has to say what it is to the gate: either it is on the
// list, or there is a reason here why its absence is not the gate's to refuse.
describe('every runtime setting', () => {
  const NOT_THE_GATES: Record<string, string> = {
    allowLocalDrivers: 'the opt-in itself',
    adminToken: 'fails closed by itself: the admin routes answer 404 without it',
    inviteCode: 'fails closed by itself: uploads close without it',
    r2MaxStoredBytes: 'has a default, and refuses an unusable value by itself',
    r2RetentionDays: 'has a default',
    groqChatIntervalMs: 'has a default',
    embedIntervalMs: 'has a default',
    askMaxSlotWaitMs: 'has a default',
    uploadTokenSecret: 'read only inside the local store',
    dataDir: 'read only inside the local stores',
    summaryStubCanary: 'read only inside a stub',
    transcribeStubQuotaFail: 'read only inside a stub',
    summaryStubFailOnceRetryable: 'read only inside a stub',
    answerStubPaced: 'read only inside a stub',
    embedStubQuotaCanary: 'read only inside a stub',
    public: 'the public block, which holds no credential',
  }

  it('is either required or has a reason why not', async () => {
    const config = await readFile(fileURLToPath(new URL('../../nuxt.config.ts', import.meta.url)), 'utf8')
    const block = config.slice(config.indexOf('runtimeConfig: {'), config.indexOf('routeRules: {'))
    const keys = [...block.matchAll(/^ {4}(\w+):/gm)].map(match => match[1]!)
    // Guard the guard: a pattern that stopped matching would pass this for ever.
    expect(keys).toEqual(expect.arrayContaining(['groqApiKey', 'r2Bucket', 'inviteCode', 'public']))
    expect(keys.filter(key => !KEYS.includes(key as typeof KEYS[number]) && !(key in NOT_THE_GATES))).toEqual([])
  })

  it('holds the opt-in false in the build, and out of what a Worker is deployed with', async () => {
    const root = fileURLToPath(new URL('../..', import.meta.url))
    expect(await readFile(`${root}nuxt.config.ts`, 'utf8')).toMatch(/^ {4}allowLocalDrivers: false, \/\/ NUXT_ALLOW_LOCAL_DRIVERS$/m)
    expect(await readFile(`${root}wrangler.jsonc`, 'utf8')).not.toMatch(/ALLOW_LOCAL_DRIVERS|allowLocalDrivers/)
  })

  // A shell that exported a setting left out here would hand it to every e2e server, and with
  // the opt-in a real key on local stores is allowed, so those tests would spend real quota.
  it('is blanked on every e2e server', () => {
    const names = Object.values(REQUIRED_SETTINGS).flatMap(group => Object.keys(group))
    expect(names).toHaveLength(9)
    expect(REAL_SETTINGS_ABSENT).toEqual(Object.fromEntries(names.map(name => [name, ''])))
  })

  it('reads a stub flag nowhere but where a stub is built', async () => {
    const root = fileURLToPath(new URL('../../server/', import.meta.url))
    const stubFlag = /\b(?:summaryStubCanary|transcribeStubQuotaFail|summaryStubFailOnceRetryable|answerStubPaced|embedStubQuotaCanary|uploadTokenSecret)\b/
    const readers: string[] = []
    for (const entry of await readdir(root, { recursive: true, withFileTypes: true })) {
      if (!entry.isFile()) continue
      const path = `${entry.parentPath}/${entry.name}`
      if (stubFlag.test(await readFile(path, 'utf8'))) readers.push(path.slice(root.length))
    }
    expect(readers.sort()).toEqual(['utils/qa/index.ts', 'utils/storage/index.ts', 'utils/summary/index.ts', 'utils/transcription/index.ts'])
  })
})
