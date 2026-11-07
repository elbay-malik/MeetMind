import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createSupabaseRegistrationRepository } from '../../server/utils/db/registrations-supabase'
import { describeRegistrations, type RegistrationDriver } from '../unit/helpers/registration-cases'
import { startSupabaseStandIn } from './helpers'

/** The local driver's cases (tests/unit/registration-repository.spec.ts), through the real Supabase driver and real SQL. */
let standIn: Awaited<ReturnType<typeof startSupabaseStandIn>>

beforeAll(async () => {
  standIn = await startSupabaseStandIn()
})
afterAll(async () => {
  await standIn?.stop()
})

const driver = (): RegistrationDriver => ({
  repo: createSupabaseRegistrationRepository(standIn.options),
  setCount: async (day, taken) => {
    await standIn.sql(`insert into public.meeting_registration_days (day, taken) values ('${day}', ${taken});`)
  },
  async counts() {
    const out = await standIn.sql('select day || \'=\' || taken from public.meeting_registration_days order by day;')
    return Object.fromEntries(out.trim().split('\n').filter(Boolean).map((line: string) => {
      const [day, taken] = line.split('=')
      return [day, Number(taken)]
    }))
  },
  async clear() {
    await standIn.sql('delete from public.meeting_registration_days;')
  },
})

describeRegistrations('the Supabase driver', driver)

describe('who reaches the day\'s new meetings, through PostgREST', () => {
  /** PostgREST with no key at all, which is what it treats as anon. */
  const anon = (path: string, init?: RequestInit) => fetch(`${standIn.options.url}/rest/v1/${path}`, init)

  it('is not anyone without the service role, for the table or the function', async () => {
    await driver().clear()
    expect((await anon('meeting_registration_days?select=day')).status).toBe(401)
    expect((await anon('rpc/take_meeting_registration', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ p_limit: 5 }) })).status).toBe(401)
    expect(await driver().counts()).toEqual({})
  })
})

/** Last, as it takes the function away. What the route refuses on is in tests/unit/registration-limit.spec.ts. */
describe('with the migration not applied', () => {
  it('the take fails, rather than reading as go ahead', async () => {
    await standIn.sql(`drop function public.take_meeting_registration(integer);
      notify pgrst, 'reload schema';`)
    await new Promise(resolve => setTimeout(resolve, 1500))
    await expect(driver().repo.take(5)).rejects.toThrow(/Supabase take meeting registration failed/)
  })
})
