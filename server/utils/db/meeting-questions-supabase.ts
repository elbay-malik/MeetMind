import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import type { Database } from './database.types'
import type { MeetingQuestionRepository } from './meeting-questions'
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
 * The counts in `public.meeting_question_days`, decided by one SQL function per call, as the
 * demo's are. An unusable answer throws rather than reading as "go ahead", and so does the
 * migration not being applied, which the caller refuses on.
 */
export function createSupabaseMeetingQuestionRepository(options: SupabaseOptions): MeetingQuestionRepository {
  return {
    kind: 'supabase',

    async overCount({ limit, meetingId }) {
      const { data, error } = await clientFor(options).rpc('meeting_question_gate', { p_limit: limit, p_meeting: meetingId })
      if (error) fail('meeting question gate', error)
      if (typeof data !== 'boolean') {
        throw new Error(`Supabase meeting question gate returned an unusable answer: ${JSON.stringify(data)}`)
      }
      return data
    },

    async take({ limit, meetingId }) {
      const { data, error } = await clientFor(options).rpc('take_meeting_question', { p_limit: limit, p_meeting: meetingId })
      if (error) fail('take meeting question', error)
      if (typeof data !== 'boolean') {
        throw new Error(`Supabase take meeting question returned an unusable answer: ${JSON.stringify(data)}`)
      }
      return data
    },
  }
}
