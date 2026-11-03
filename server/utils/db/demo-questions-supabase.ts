import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import type { Database } from './database.types'
import type { DemoQuestionRepository } from './demo-questions'
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

function fail(action: string, error: { code?: string, message: string }): never {
  throw new Error(`Supabase ${action} failed${error.code ? ` (${error.code})` : ''}: ${error.message}`)
}

/**
 * The count in `public.demo_question_days`, decided by one SQL function per call. An unusable
 * answer throws rather than reading as "go ahead", which is the one failure that would quietly
 * take the cap away. The migration not being applied is a failure like any other here, which
 * the caller refuses on, and only a question on the demo ever gets this far.
 */
export function createSupabaseDemoQuestionRepository(options: SupabaseOptions): DemoQuestionRepository {
  return {
    kind: 'supabase',

    async gate({ limit, demoMeetingId }) {
      const { data, error } = await clientFor(options).rpc('demo_question_gate', { p_limit: limit, p_demo: demoMeetingId })
      if (error) fail('demo question gate', error)
      const row = data?.[0]
      if (!row || typeof row.over_count !== 'boolean' || typeof row.extraction_pending !== 'boolean') {
        throw new Error(`Supabase demo question gate returned an unusable row: ${JSON.stringify(data)}`)
      }
      return { overCount: row.over_count, extractionPending: row.extraction_pending }
    },

    async take(limit) {
      const { data, error } = await clientFor(options).rpc('take_demo_question', { p_limit: limit })
      if (error) fail('take demo question', error)
      if (typeof data !== 'boolean') {
        throw new Error(`Supabase take demo question returned an unusable answer: ${JSON.stringify(data)}`)
      }
      return data
    },
  }
}
