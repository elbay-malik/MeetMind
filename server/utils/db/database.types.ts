import type { MeetingRow } from './meetings'

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
    }
    Views: Record<string, never>
    Functions: Record<string, never>
    Enums: Record<string, never>
    CompositeTypes: Record<string, never>
  }
}
