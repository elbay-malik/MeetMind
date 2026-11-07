import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import type { Database } from './database.types'
import type { RegistrationRepository } from './registrations'
import type { SupabaseOptions } from './supabase'

const clients = new Map<string, SupabaseClient<Database>>()

function clientFor(options: SupabaseOptions): SupabaseClient<Database> {
  const cacheKey = `${options.url}\n${options.serviceKey}`
  let client = clients.get(cacheKey)
  if (!client) {
    client = createClient<Database>(options.url, options.serviceKey, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    })
    clients.set(cacheKey, client)
  }
  return client
}

/**
 * The count in `public.meeting_registration_days`, decided by one SQL function per call. An
 * unusable answer throws rather than reading as "go ahead", and so does the migration not being
 * applied, which the route refuses on.
 */
export function createSupabaseRegistrationRepository(options: SupabaseOptions): RegistrationRepository {
  return {
    kind: 'supabase',

    async take(limit) {
      const { data, error } = await clientFor(options).rpc('take_meeting_registration', { p_limit: limit })
      if (error) throw new Error(`Supabase take meeting registration failed${error.code ? ` (${error.code})` : ''}: ${error.message}`)
      if (typeof data !== 'boolean') {
        throw new Error(`Supabase take meeting registration returned an unusable answer: ${JSON.stringify(data)}`)
      }
      return data
    },
  }
}
