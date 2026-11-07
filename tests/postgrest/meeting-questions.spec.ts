import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createSupabaseMeetingQuestionRepository } from '../../server/utils/db/meeting-questions-supabase'
import { describeMeetingQuestions, type MeetingQuestionDriver } from '../unit/helpers/meeting-question-cases'
import { startSupabaseStandIn } from './helpers'

/** The local driver's cases (tests/unit/meeting-question-repository.spec.ts), through the real Supabase driver and real SQL. */
let standIn: Awaited<ReturnType<typeof startSupabaseStandIn>>

beforeAll(async () => {
  standIn = await startSupabaseStandIn()
})
afterAll(async () => {
  await standIn?.stop()
})

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

const driver = (): MeetingQuestionDriver => ({
  repo: createSupabaseMeetingQuestionRepository(standIn.options),
  seed: id => standIn.driver().seed(id, { status: 'ready' }),
  setCount: async (day, meetingId, taken) => {
    await standIn.sql(`insert into public.meeting_question_days (day, meeting_id, taken) values ('${day}', '${meetingId}', ${taken});`)
  },
  async counts() {
    const out = await standIn.sql('select day || \' \' || meeting_id || \'=\' || taken from public.meeting_question_days order by day, meeting_id;')
    return Object.fromEntries(out.trim().split('\n').filter(Boolean).map((line: string) => {
      const [key, taken] = line.split('=')
      return [key, Number(taken)]
    }))
  },
  async clear() {
    await standIn.sql('delete from public.meeting_question_days; delete from public.meetings;')
  },
})

describeMeetingQuestions('the Supabase driver', driver)

describe('a meeting\'s count, in Postgres', () => {
  it('goes with its meeting when the meeting is deleted', async () => {
    await driver().clear()
    await driver().seed(A)
    expect(await driver().repo.take({ limit: 5, meetingId: A })).toBe(true)
    await standIn.sql(`delete from public.meetings where id = '${A}';`)
    expect(await driver().counts()).toEqual({})
  })
})

describe('who reaches each meeting\'s count, through PostgREST', () => {
  /** PostgREST with no key at all, which is what it treats as anon. */
  const anon = (path: string, init?: RequestInit) => fetch(`${standIn.options.url}/rest/v1/${path}`, init)
  const call = (body: object) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

  it('is not anyone without the service role, for the table or either function', async () => {
    await driver().clear()
    await driver().seed(A)
    expect((await anon('meeting_question_days?select=day')).status).toBe(401)
    expect((await anon('rpc/take_meeting_question', call({ p_limit: 5, p_meeting: A }))).status).toBe(401)
    expect((await anon('rpc/meeting_question_gate', call({ p_limit: 5, p_meeting: A }))).status).toBe(401)
    expect(await driver().counts()).toEqual({})
  })
})

/** Last, as it takes the functions away. What the route refuses on is in tests/unit/meeting-question-cap.spec.ts. */
describe('with the migration not applied', () => {
  it('both calls fail, rather than reading as go ahead', async () => {
    await standIn.sql(`drop function public.meeting_question_gate(integer, uuid);
      drop function public.take_meeting_question(integer, uuid);
      notify pgrst, 'reload schema';`)
    await new Promise(resolve => setTimeout(resolve, 1500))
    const { repo } = driver()
    await expect(repo.overCount({ limit: 5, meetingId: A })).rejects.toThrow(/Supabase meeting question gate failed/)
    await expect(repo.take({ limit: 5, meetingId: A })).rejects.toThrow(/Supabase take meeting question failed/)
  })
})
