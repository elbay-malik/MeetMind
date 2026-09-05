import type { H3Event } from 'h3'
import type { MeetingRepository } from './meetings'
import { createLocalMeetingRepository } from './local'
import { createSupabaseMeetingRepository } from './supabase'
import { createLocalTranscriptRepository } from './transcripts-local'
import { createSupabaseTranscriptRepository } from './transcripts-supabase'
import type { TranscriptRepository } from './transcripts'
import { requireAllOrNone } from '../storage'

let announced = false
function announce(kind: MeetingRepository['kind']) {
  if (announced) return
  announced = true
  if (kind === 'local') {
    console.info('[meetmind] meeting db: local JSON files (set NUXT_SUPABASE_URL/_SERVICE_KEY to use Supabase)')
  }
}

/**
 * Pick the meeting repository from runtime config: Supabase Postgres when the
 * URL and service-role key are present, otherwise local JSON files (dev/tests).
 */
export function useMeetingRepository(event: H3Event): MeetingRepository {
  const config = useRuntimeConfig(event)
  const supabaseReady = requireAllOrNone('Supabase', {
    NUXT_SUPABASE_URL: config.supabaseUrl,
    NUXT_SUPABASE_SERVICE_KEY: config.supabaseServiceKey,
  })
  const repo = supabaseReady
    ? createSupabaseMeetingRepository({ url: config.supabaseUrl, serviceKey: config.supabaseServiceKey })
    : createLocalMeetingRepository({ dataDir: config.dataDir })
  announce(repo.kind)
  return repo
}

/** The transcript store, chosen the same way as the meeting repository. */
export function useTranscriptRepository(event: H3Event): TranscriptRepository {
  const config = useRuntimeConfig(event)
  const supabaseReady = requireAllOrNone('Supabase', {
    NUXT_SUPABASE_URL: config.supabaseUrl,
    NUXT_SUPABASE_SERVICE_KEY: config.supabaseServiceKey,
  })
  return supabaseReady
    ? createSupabaseTranscriptRepository({ url: config.supabaseUrl, serviceKey: config.supabaseServiceKey })
    : createLocalTranscriptRepository({ dataDir: config.dataDir })
}
