import type { MeetingRow } from './meetings'
import type { TranscriptSegmentRow } from './transcripts'
import type { ActionItemRow, DecisionRow, SummaryRow } from './summaries'

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
    }
    Views: Record<string, never>
    Functions: Record<string, never>
    Enums: Record<string, never>
    CompositeTypes: Record<string, never>
  }
}
