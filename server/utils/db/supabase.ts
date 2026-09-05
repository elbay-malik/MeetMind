import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import type { Database } from './database.types'
import {
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
      const { data, error } = await table().insert(newMeetingToRow(input)).select().single()
      if (error) fail('insert', error)
      return rowToMeeting(data)
    },

    async get(id) {
      const { data, error } = await table().select().eq('id', id).maybeSingle()
      if (error) fail('select', error)
      return data ? rowToMeeting(data) : null
    },

    async list({ limit }) {
      const { data, error } = await table()
        .select()
        .order('created_at', { ascending: false })
        .limit(limit)
      if (error) fail('list', error)
      return data.map(rowToMeeting)
    },

    async claim(id, from, patch: MeetingPatch) {
      // The extra .eq('status', from) is what makes this atomic: PostgREST
      // sends one UPDATE ... WHERE id = ? AND status = ?, so the database
      // decides the winner and the loser matches no row.
      const { data, error } = await table()
        .update(patchToRow(patch))
        .eq('id', id)
        .eq('status', from)
        .select()
        .maybeSingle()
      if (error) fail('claim', error)
      return data ? rowToMeeting(data) : null
    },

    async update(id, patch: MeetingPatch) {
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
