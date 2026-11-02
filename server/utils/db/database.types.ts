import type { MeetingRow } from './meetings'
import type { TranscriptSegmentRow } from './transcripts'
import type { ActionItemRow, DecisionRow, SummaryRow } from './summaries'
import type { PipelineRunRow, SummaryChunkRow } from './pipeline'
import type { TranscriptWindowRow, WindowMatchRow } from './windows'

/**
 * Hand-written Supabase schema typing for the tables the server touches.
 * Keep in step with supabase/migrations/. Regenerate with
 * `supabase gen types typescript` once the CLI is part of the toolchain.
 */
export interface Database {
  public: {
    Tables: {
      provider_slots: {
        Row: { provider: string, next_available_at: string, blocked_until: string }
        Insert: { provider: string, next_available_at?: string, blocked_until?: string }
        Update: Partial<{ provider: string, next_available_at: string, blocked_until: string }>
        Relationships: []
      }
      pipeline_runs: {
        Row: PipelineRunRow
        Insert: Pick<PipelineRunRow, 'meeting_id' | 'stage'> & Partial<PipelineRunRow>
        Update: Partial<PipelineRunRow>
        Relationships: []
      }
      summary_chunks: {
        Row: SummaryChunkRow
        Insert: Omit<SummaryChunkRow, 'attempts' | 'result' | 'updated_at'> & Partial<SummaryChunkRow>
        Update: Partial<SummaryChunkRow>
        Relationships: []
      }
      meetings: {
        Row: MeetingRow
        Insert: Omit<MeetingRow, 'created_at' | 'updated_at' | 'audio_mime'>
          & Partial<Pick<MeetingRow, 'created_at' | 'updated_at' | 'audio_mime'>>
        Update: Partial<MeetingRow>
        Relationships: []
      }
      transcript_segments: {
        Row: TranscriptSegmentRow
        Insert: Omit<TranscriptSegmentRow, 'created_at'> & Partial<Pick<TranscriptSegmentRow, 'created_at'>>
        Update: Partial<TranscriptSegmentRow>
        Relationships: []
      }
      meeting_summaries: {
        Row: SummaryRow
        Insert: Omit<SummaryRow, 'created_at' | 'updated_at'>
          & Partial<Pick<SummaryRow, 'created_at' | 'updated_at'>>
        Update: Partial<SummaryRow>
        Relationships: []
      }
      meeting_decisions: {
        Row: DecisionRow
        Insert: Omit<DecisionRow, 'created_at'> & Partial<Pick<DecisionRow, 'created_at'>>
        Update: Partial<DecisionRow>
        Relationships: []
      }
      meeting_action_items: {
        Row: ActionItemRow
        Insert: Omit<ActionItemRow, 'created_at'> & Partial<Pick<ActionItemRow, 'created_at'>>
        Update: Partial<ActionItemRow>
        Relationships: []
      }
      transcript_windows: {
        Row: TranscriptWindowRow
        Insert: Omit<TranscriptWindowRow, 'created_at' | 'updated_at'>
          & Partial<Pick<TranscriptWindowRow, 'created_at' | 'updated_at'>>
        Update: Partial<TranscriptWindowRow>
        Relationships: []
      }
    }
    Views: Record<string, never>
    Functions: {
      match_transcript_windows: {
        Args: {
          p_meeting_id: string
          /** A vector literal, '[0.1,0.2,…]'. */
          p_query: string
          p_model: string
          p_match_count: number
        }
        Returns: WindowMatchRow[]
      }
      stored_audio_bytes: {
        Args: {
          p_retention_days: number
          p_reservation_seconds: number
        }
        /** A bigint, which PostgREST sends as a number or a string. */
        Returns: number | string
      }
      reserve_slot: {
        Args: {
          p_provider: string
          p_interval_ms: number
          p_max_wait_ms: number
        }
        /** One row: granted, and the slot's start (or when the next one frees). */
        Returns: { granted: boolean, slot_at: string }[]
      }
      note_rate_limit: {
        Args: {
          p_provider: string
          p_retry_after_ms: number
        }
        Returns: undefined
      }
      claim_step: {
        Args: {
          p_meeting: string
          p_stage: string
          p_status: string
          p_lease_ms: number
          p_chunk_no: number | null
          p_new_run: boolean
          p_reset_attempts: boolean
          p_move_to: string | null
          p_redo: boolean
          p_expected_updated_at: string | null
        }
        /** One row when granted, none when refused. */
        Returns: { step_token: string, run_id: string, run_cursor: Record<string, unknown>, attempts: number }[]
      }
      release_step: {
        Args: {
          p_meeting: string
          p_stage: string
          p_token: string
          p_error: string | null
          p_retry_at: string | null
          p_refund_attempt: boolean
          p_cursor: Record<string, unknown> | null
          p_fail_from: string | null
        }
        Returns: boolean
      }
      plan_chunks: {
        /** p_chunks: rows of { chunk_no, seg_from, seg_to, est_tokens }. */
        Args: { p_meeting: string, p_token: string, p_chunks: unknown }
        Returns: boolean
      }
      record_chunk: {
        Args: { p_meeting: string, p_token: string, p_chunk_no: number, p_seg_from: number, p_seg_to: number, p_result: unknown }
        Returns: boolean
      }
      append_segments: {
        /** p_segments: rows of { idx, start_ms, end_ms, text }. */
        Args: { p_meeting: string, p_token: string, p_from_idx: number, p_segments: unknown, p_cursor: Record<string, unknown> }
        Returns: boolean
      }
      finish_transcription: {
        /** p_chunks: rows of { chunk_no, seg_from, seg_to, est_tokens }. */
        Args: { p_meeting: string, p_token: string, p_chunks: unknown, p_refusal: string | null }
        Returns: boolean
      }
      finalize_summary: {
        /** p_decisions and p_action_items: rows in the tables' own column names. */
        Args: {
          p_meeting: string
          p_token: string
          p_summary: string
          p_provider: string
          p_decisions: unknown
          p_action_items: unknown
        }
        Returns: boolean
      }
    }
    Enums: Record<string, never>
    CompositeTypes: Record<string, never>
  }
}
