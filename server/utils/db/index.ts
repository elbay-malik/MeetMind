import type { H3Event } from 'h3'
import type { MeetingRepository } from './meetings'
import { createLocalMeetingRepository } from './local'
import { createSupabaseMeetingRepository } from './supabase'
import { createLocalTranscriptRepository } from './transcripts-local'
import { createSupabaseTranscriptRepository } from './transcripts-supabase'
import type { TranscriptRepository } from './transcripts'
import { createLocalSummaryRepository } from './summaries-local'
import { createSupabaseSummaryRepository } from './summaries-supabase'
import type { SummaryRepository } from './summaries'
import { createLocalTranscriptIndexRepository } from './windows-local'
import { createSupabaseTranscriptIndexRepository } from './windows-supabase'
import type { TranscriptIndexRepository } from './windows'
import { createLocalSlotRepository } from './slots-local'
import { createSupabaseSlotRepository } from './slots-supabase'
import type { SlotRepository } from './slots'
import { createLocalPipelineRepository } from './pipeline-local'
import { createSupabasePipelineRepository } from './pipeline-supabase'
import type { PipelineRepository } from './pipeline'
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

/** The summary store, chosen the same way as the other repositories. */
export function useSummaryRepository(event: H3Event): SummaryRepository {
  const config = useRuntimeConfig(event)
  const supabaseReady = requireAllOrNone('Supabase', {
    NUXT_SUPABASE_URL: config.supabaseUrl,
    NUXT_SUPABASE_SERVICE_KEY: config.supabaseServiceKey,
  })
  return supabaseReady
    ? createSupabaseSummaryRepository({ url: config.supabaseUrl, serviceKey: config.supabaseServiceKey })
    : createLocalSummaryRepository({ dataDir: config.dataDir })
}

/** The embedded-window index for Q&A, chosen the same way as the other repositories. */
export function useTranscriptIndexRepository(event: H3Event): TranscriptIndexRepository {
  const config = useRuntimeConfig(event)
  const supabaseReady = requireAllOrNone('Supabase', {
    NUXT_SUPABASE_URL: config.supabaseUrl,
    NUXT_SUPABASE_SERVICE_KEY: config.supabaseServiceKey,
  })
  return supabaseReady
    ? createSupabaseTranscriptIndexRepository({ url: config.supabaseUrl, serviceKey: config.supabaseServiceKey })
    : createLocalTranscriptIndexRepository({ dataDir: config.dataDir })
}

/** Provider request slots (ADR-0012), chosen the same way as the other repositories. */
export function useSlotRepository(event: H3Event): SlotRepository {
  const config = useRuntimeConfig(event)
  const supabaseReady = requireAllOrNone('Supabase', {
    NUXT_SUPABASE_URL: config.supabaseUrl,
    NUXT_SUPABASE_SERVICE_KEY: config.supabaseServiceKey,
  })
  return supabaseReady
    ? createSupabaseSlotRepository({ url: config.supabaseUrl, serviceKey: config.supabaseServiceKey })
    : createLocalSlotRepository({ dataDir: config.dataDir })
}

/** The run ledger (ADR-0012), chosen the same way as the other repositories. */
export function usePipelineRepository(event: H3Event): PipelineRepository {
  const config = useRuntimeConfig(event)
  const supabaseReady = requireAllOrNone('Supabase', {
    NUXT_SUPABASE_URL: config.supabaseUrl,
    NUXT_SUPABASE_SERVICE_KEY: config.supabaseServiceKey,
  })
  return supabaseReady
    ? createSupabasePipelineRepository({ url: config.supabaseUrl, serviceKey: config.supabaseServiceKey })
    : createLocalPipelineRepository({ dataDir: config.dataDir })
}
