import type { H3Event } from 'h3'
import { selectDriver } from '../drivers'
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

/**
 * Pick the meeting repository: Supabase Postgres when the URL and service-role key
 * are present, or local JSON files where ADR-0016 allows that.
 */
export function useMeetingRepository(event: H3Event): MeetingRepository {
  return selectDriver<MeetingRepository>(event, 'supabase', {
    real: config => createSupabaseMeetingRepository({ url: config.supabaseUrl, serviceKey: config.supabaseServiceKey }),
    local: config => createLocalMeetingRepository({ dataDir: config.dataDir }),
  })
}

/** The transcript store, chosen the same way as the meeting repository. */
export function useTranscriptRepository(event: H3Event): TranscriptRepository {
  return selectDriver<TranscriptRepository>(event, 'supabase', {
    real: config => createSupabaseTranscriptRepository({ url: config.supabaseUrl, serviceKey: config.supabaseServiceKey }),
    local: config => createLocalTranscriptRepository({ dataDir: config.dataDir }),
  })
}

/** The summary store, chosen the same way as the other repositories. */
export function useSummaryRepository(event: H3Event): SummaryRepository {
  return selectDriver<SummaryRepository>(event, 'supabase', {
    real: config => createSupabaseSummaryRepository({ url: config.supabaseUrl, serviceKey: config.supabaseServiceKey }),
    local: config => createLocalSummaryRepository({ dataDir: config.dataDir }),
  })
}

/** The embedded-window index for Q&A, chosen the same way as the other repositories. */
export function useTranscriptIndexRepository(event: H3Event): TranscriptIndexRepository {
  return selectDriver<TranscriptIndexRepository>(event, 'supabase', {
    real: config => createSupabaseTranscriptIndexRepository({ url: config.supabaseUrl, serviceKey: config.supabaseServiceKey }),
    local: config => createLocalTranscriptIndexRepository({ dataDir: config.dataDir }),
  })
}

/** Provider request slots (ADR-0012), chosen the same way as the other repositories. */
export function useSlotRepository(event: H3Event): SlotRepository {
  return selectDriver<SlotRepository>(event, 'supabase', {
    real: config => createSupabaseSlotRepository({ url: config.supabaseUrl, serviceKey: config.supabaseServiceKey }),
    local: config => createLocalSlotRepository({ dataDir: config.dataDir }),
  })
}

/** The run ledger (ADR-0012), chosen the same way as the other repositories. */
export function usePipelineRepository(event: H3Event): PipelineRepository {
  return selectDriver<PipelineRepository>(event, 'supabase', {
    real: config => createSupabasePipelineRepository({ url: config.supabaseUrl, serviceKey: config.supabaseServiceKey }),
    local: config => createLocalPipelineRepository({ dataDir: config.dataDir }),
  })
}
