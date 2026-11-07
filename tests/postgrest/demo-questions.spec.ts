import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createSupabaseDemoQuestionRepository } from '../../server/utils/db/demo-questions-supabase'
import { describeDemoQuestions, type DemoQuestionDriver } from '../unit/helpers/demo-question-cases'
import { startSupabaseStandIn } from './helpers'

/** The local driver's cases (tests/unit/demo-question-repository.spec.ts), through the real Supabase driver and real SQL. */
let standIn: Awaited<ReturnType<typeof startSupabaseStandIn>>

beforeAll(async () => {
  standIn = await startSupabaseStandIn()
})
afterAll(async () => {
  await standIn?.stop()
})

const driver = (): DemoQuestionDriver => ({
  repo: createSupabaseDemoQuestionRepository(standIn.options),
  seed: (id, meeting) => standIn.driver().seed(id, { status: meeting.status, failedStage: meeting.failedStage ?? undefined, updatedAgoMs: meeting.updatedAgoMs }),
  setCount: async (day, taken) => {
    await standIn.sql(`insert into public.demo_question_days (day, taken) values ('${day}', ${taken});`)
  },
  async counts() {
    const out = await standIn.sql('select day || \'=\' || taken from public.demo_question_days order by day;')
    return Object.fromEntries(out.trim().split('\n').filter(Boolean).map((line: string) => {
      const [day, taken] = line.split('=')
      return [day, Number(taken)]
    }))
  },
  async clear() {
    await standIn.sql('delete from public.meetings; delete from public.demo_question_days;')
  },
})

describeDemoQuestions('the Supabase driver', driver)

describe('who reaches the demo\'s count, through PostgREST', () => {
  /** PostgREST with no key at all, which is what it treats as anon. */
  const anon = (path: string, init?: RequestInit) => fetch(`${standIn.options.url}/rest/v1/${path}`, init)
  const call = (body: object) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

  it('is not anyone without the service role, for the table or either function', async () => {
    await standIn.sql('delete from public.demo_question_days;')
    expect((await anon('demo_question_days?select=day')).status).toBe(401)
    expect((await anon('rpc/take_demo_question', call({ p_limit: 5 }))).status).toBe(401)
    expect((await anon('rpc/demo_question_gate', call({ p_limit: 5, p_demo: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd' }))).status).toBe(401)
    expect(await standIn.sql('select count(*) from public.demo_question_days;')).toContain('0')
  })

  it('reads and writes the driver\'s way for the service role, which is what the cases above ran as', async () => {
    await standIn.sql('delete from public.demo_question_days;')
    expect(await driver().repo.take(1)).toBe(true)
  })
})

/** Last, as it takes the functions away. What the route refuses on is in tests/unit/demo-question-cap.spec.ts. */
describe('with the migration not applied', () => {
  it('both calls fail, rather than reading as go ahead', async () => {
    await standIn.sql(`drop function public.demo_question_gate(integer, uuid);
      drop function public.take_demo_question(integer);
      notify pgrst, 'reload schema';`)
    await new Promise(resolve => setTimeout(resolve, 1500))
    const { repo } = driver()
    await expect(repo.gate({ limit: 5, demoMeetingId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd' })).rejects.toThrow(/Supabase demo question gate failed/)
    await expect(repo.take(5)).rejects.toThrow(/Supabase take demo question failed/)
  })
})
