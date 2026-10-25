import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import type { Database } from './database.types'
import type { SupabaseOptions } from './supabase'
import type { SlotRepository } from './slots'

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

function fail(action: string, error: { code?: string, message: string }): never {
  throw new Error(`Supabase ${action} failed${error.code ? ` (${error.code})` : ''}: ${error.message}`)
}

/** Slots in `public.provider_slots`, decided by one SQL statement per call. */
export function createSupabaseSlotRepository(options: SupabaseOptions): SlotRepository {
  return {
    kind: 'supabase',

    async reserve(provider, { intervalMs, maxWaitMs }) {
      const { data, error } = await clientFor(options).rpc('reserve_slot', {
        p_provider: provider,
        p_interval_ms: Math.round(intervalMs),
        p_max_wait_ms: Math.round(maxWaitMs),
      })
      if (error) fail('reserve slot', error)
      const row = data?.[0]
      const at = row ? Date.parse(row.slot_at) : Number.NaN
      // An unusable answer must not read as "go ahead now": that is the one
      // failure that would quietly turn pacing off.
      if (!row || typeof row.granted !== 'boolean' || !Number.isFinite(at)) {
        throw new Error(`Supabase reserve slot returned an unusable row: ${JSON.stringify(data)}`)
      }
      return row.granted ? { granted: true, slotAt: new Date(at) } : { granted: false, retryAt: new Date(at) }
    },

    async noteRateLimit(provider, retryAfterMs) {
      const { error } = await clientFor(options).rpc('note_rate_limit', {
        p_provider: provider,
        p_retry_after_ms: Math.round(retryAfterMs),
      })
      if (error) fail('note rate limit', error)
    },

    async blockedUntil(provider) {
      const { data, error } = await clientFor(options).from('provider_slots')
        .select('blocked_until').eq('provider', provider).maybeSingle()
      if (error) fail('read rate-limit block', error)
      const until = data ? Date.parse(data.blocked_until) : Number.NaN
      return Number.isFinite(until) && until > Date.now() ? new Date(until) : null
    },
  }
}
