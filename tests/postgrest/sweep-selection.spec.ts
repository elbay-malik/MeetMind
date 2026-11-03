import { afterAll, beforeAll } from 'vitest'
import { describeSweepSelection } from '../unit/helpers/sweep-cases'
import { startSupabaseStandIn } from './helpers'

/** The local driver's cases (tests/unit/sweep-selection.spec.ts), through the real Supabase driver and real SQL. */
let standIn: Awaited<ReturnType<typeof startSupabaseStandIn>>

beforeAll(async () => {
  standIn = await startSupabaseStandIn()
})
afterAll(async () => {
  await standIn?.stop()
})

describeSweepSelection('the Supabase driver', () => standIn.driver())
