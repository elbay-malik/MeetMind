import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import type { Database } from './database.types'
import {
  rowToSegment,
  segmentToRow,
  type TranscriptRepository,
} from './transcripts'
import type { SupabaseOptions } from './supabase'

/**
 * The columns {@link rowToSegment} reads, and the only ones a read asks for: the meeting id
 * is already the filter and `created_at` is never shown, so fetching them would only make
 * every transcript read larger.
 */
const SEGMENT_COLUMNS = 'idx, start_ms, end_ms, text'

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

/** Transcript segments in Supabase Postgres, accessed over PostgREST. */
export function createSupabaseTranscriptRepository(options: SupabaseOptions): TranscriptRepository {
  const table = () => clientFor(options).from('transcript_segments')

  return {
    kind: 'supabase',

    async replaceForMeeting(meetingId, segments) {
      // PostgREST has no cross-call transactions, so this is delete-then-insert
      // with a visible gap. The caller keeps that gap inside the window where
      // the meeting is claimed as `transcribing`, and the composite primary key
      // (meeting_id, idx) makes a repeat run a replacement rather than a
      // duplicate.
      const { error: deleteError } = await table().delete().eq('meeting_id', meetingId)
      if (deleteError) fail('transcript delete', deleteError)
      if (segments.length === 0) return

      const { error } = await table().insert(segments.map(s => segmentToRow(meetingId, s)))
      if (error) fail('transcript insert', error)
    },

    async deleteForMeeting(meetingId) {
      // Normally a no-op by the time it runs: deleting the meeting cascades.
      const { error } = await table().delete().eq('meeting_id', meetingId)
      if (error) fail('transcript delete', error)
    },

    async listForMeeting(meetingId) {
      // PostgREST enforces a server-side row cap (Supabase's "Max rows",
      // 1000 by default) and returns a short array with no error and no signal.
      // Whisper emits a segment every few seconds, so a 90-minute meeting
      // reaches that cap and would be silently cut in half. Page explicitly.
      const PAGE = 1000
      const segments = []
      for (let from = 0; ; from += PAGE) {
        const { data, error } = await table()
          .select(SEGMENT_COLUMNS)
          .eq('meeting_id', meetingId)
          .order('idx', { ascending: true })
          .range(from, from + PAGE - 1)
        if (error) fail('transcript select', error)
        segments.push(...data.map(rowToSegment))
        if (data.length < PAGE) return segments
      }
    },

    async listRange(meetingId, from, to) {
      // One chunk is far under the row cap; paged anyway, so a wide range
      // cannot come back silently short.
      const PAGE = 1000
      const segments = []
      for (let offset = 0; ; offset += PAGE) {
        const { data, error } = await table()
          .select(SEGMENT_COLUMNS)
          .eq('meeting_id', meetingId)
          .gte('idx', from)
          .lte('idx', to)
          .order('idx', { ascending: true })
          .range(offset, offset + PAGE - 1)
        if (error) fail('transcript range select', error)
        segments.push(...data.map(rowToSegment))
        if (data.length < PAGE) return segments
      }
    },

    async listFrom(meetingId, from, limit) {
      // The exact count over this filter is an index scan, and says whether anything
      // lies past this page even if a row cap has shortened it.
      const { data, error, count } = await table()
        .select(SEGMENT_COLUMNS, { count: 'exact' })
        .eq('meeting_id', meetingId)
        .gte('idx', from)
        .order('idx', { ascending: true })
        .range(0, limit - 1)
      if (error) fail('transcript page select', error)
      if (typeof count !== 'number') throw new Error('Supabase transcript page select returned no count')
      return { segments: data.map(rowToSegment), more: count > data.length }
    },
  }
}
