import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import type { Database } from './database.types'
import {
  assertValidNewMeeting,
  assertValidStatusPatch,
  newMeetingToRow,
  patchToRow,
  rowToMeeting,
  type MeetingPatch,
  type MeetingRepository,
  type NewMeeting,
} from './meetings'

export interface SupabaseOptions {
  url: string
  /** Service-role key: server-only, bypasses RLS. Never ships to the browser. */
  serviceKey: string
}

const clients = new Map<string, SupabaseClient<Database>>()

function clientFor(options: SupabaseOptions): SupabaseClient<Database> {
  const cacheKey = `${options.url}\n${options.serviceKey}`
  let client = clients.get(cacheKey)
  if (!client) {
    client = createClient<Database>(options.url, options.serviceKey, {
      // Server-side: no browser session to persist or refresh.
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    })
    clients.set(cacheKey, client)
  }
  return client
}

function fail(action: string, error: { code?: string, message: string }): never {
  throw new Error(`Supabase ${action} failed${error.code ? ` (${error.code})` : ''}: ${error.message}`)
}

/** Meeting rows in Supabase Postgres, accessed over PostgREST. */
export function createSupabaseMeetingRepository(options: SupabaseOptions): MeetingRepository {
  const table = () => clientFor(options).from('meetings')

  return {
    kind: 'supabase',

    async create(input: NewMeeting) {
      assertValidNewMeeting(input)
      const { data, error } = await table().insert(newMeetingToRow(input)).select().single()
      if (error) fail('insert', error)
      return rowToMeeting(data)
    },

    async get(id) {
      const { data, error } = await table().select().eq('id', id).maybeSingle()
      if (error) fail('select', error)
      return data ? rowToMeeting(data) : null
    },

    async claim(id, from, patch: MeetingPatch, expectedUpdatedAt) {
      assertValidStatusPatch(patch)
      // The extra .eq('status', from) is what makes this atomic: PostgREST
      // sends one UPDATE ... WHERE id = ? AND status = ?, so the database
      // decides the winner and the loser matches no row.
      let query = table().update(patchToRow(patch)).eq('id', id).eq('status', from)
      // Extra fencing condition: a status alone is not unique once a status
      // can be reclaimed into itself (see the interface doc on `claim`).
      if (expectedUpdatedAt !== undefined) query = query.eq('updated_at', expectedUpdatedAt)
      const { data, error } = await query.select().maybeSingle()
      if (error) fail('claim', error)
      return data ? rowToMeeting(data) : null
    },

    async storedAudioBytes({ retentionDays, reservationSeconds }) {
      const { data, error } = await clientFor(options).rpc('stored_audio_bytes', {
        p_retention_days: retentionDays,
        p_reservation_seconds: reservationSeconds,
      })
      if (error) fail('stored audio bytes', error)
      // bigint crosses PostgREST as a JSON number when it fits and a string
      // when it does not; sums here are far inside 2^53 either way, but reading
      // it as a string first means a future bigger total cannot silently become
      // NaN and read as "nothing stored".
      const total = typeof data === 'string' ? Number(data) : data
      if (typeof total !== 'number' || !Number.isFinite(total)) {
        throw new Error(`Supabase stored audio bytes returned an unusable total: ${JSON.stringify(data)}`)
      }
      return total
    },

    async delete(id, expected) {
      // One DELETE ... WHERE id AND status AND updated_at RETURNING *, so the
      // database decides: a claim that landed first leaves nothing to match.
      const { data, error } = await table()
        .delete()
        .eq('id', id)
        .eq('status', expected.status)
        .eq('updated_at', expected.updatedAt)
        .select()
        .maybeSingle()
      if (error) fail('delete', error)
      return data ? rowToMeeting(data) : null
    },

    async update(id, patch: MeetingPatch) {
      assertValidStatusPatch(patch)
      const { data, error } = await table()
        .update(patchToRow(patch))
        .eq('id', id)
        .select()
        .maybeSingle()
      if (error) fail('update', error)
      return data ? rowToMeeting(data) : null
    },
  }
}
