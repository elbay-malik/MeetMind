import type { MeetingRow } from './meetings'
import type { TranscriptSegmentRow } from './transcripts'
import type { ActionItemRow, DecisionRow, SummaryRow } from './summaries'
import type { CrossMeetingMatchRow, TranscriptWindowRow, WindowMatchRow } from './windows'

/**
 * Hand-written Supabase schema typing for the tables the server touches.
 * Keep in step with supabase/migrations/. Regenerate with
 * `supabase gen types typescript` once the CLI is part of the toolchain.
 */
export interface Database {
  public: {
    Tables: {
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
      match_transcript_windows_across_meetings: {
        Args: {
          /** A vector literal, '[0.1,0.2,…]'. */
          p_query: string
          p_model: string
          p_meeting_limit: number
          p_per_meeting_limit: number
        }
        Returns: CrossMeetingMatchRow[]
      }
      stored_audio_bytes: {
        Args: {
          p_retention_days: number
          p_reservation_seconds: number
        }
        /** A bigint, which PostgREST sends as a number or a string. */
        Returns: number | string
      }
    }
    Enums: Record<string, never>
    CompositeTypes: Record<string, never>
  }
}
