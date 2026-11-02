import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import type { Database } from './database.types'
import type { SupabaseOptions } from './supabase'
import {
  clampLimit,
  rowToMatch,
  windowToRow,
  type TranscriptIndexRepository,
  type WindowMatchRow,
} from './windows'

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

/** PostgREST caps result sets server-side, so reads page rather than truncate. */
const PAGE = 1000

/**
 * Rows per upsert request. Each row carries 1024 floats as JSON, roughly 20 KB,
 * so a meeting's worth in one body would be several megabytes for no benefit.
 */
const UPSERT_BATCH = 50

export function createSupabaseTranscriptIndexRepository(options: SupabaseOptions): TranscriptIndexRepository {
  const windows = () => clientFor(options).from('transcript_windows')

  return {
    kind: 'supabase',

    async readState(meetingId, model) {
      const { data, error } = await clientFor(options).rpc('read_index_state', { p_meeting: meetingId, p_model: model })
      if (error) fail('read index state', error)
      const row = data?.[0]
      // An unusable answer must not read as anything, least of all as "ready".
      if (!row || typeof row.current_hash !== 'string' || typeof row.stored_windows !== 'number') {
        throw new Error(`Supabase read index state returned an unusable row: ${JSON.stringify(data)}`)
      }
      return {
        marker: row.text_hash === null
          ? null
          : { textHash: row.text_hash, model: row.model!, windowCount: row.window_count!, complete: row.complete! },
        transcriptHash: row.current_hash,
        segmentCount: row.segment_count,
        storedWindows: row.stored_windows,
        storedForModel: row.stored_for_model,
      }
    },

    async listKeys(meetingId, range) {
      const keys: { idx: number, contentHash: string, model: string }[] = []
      for (let offset = 0; ; offset += PAGE) {
        // Never the embedding: a meeting's vectors would be megabytes to
        // download just to compare hashes.
        let query = windows().select('idx, content_hash, model').eq('meeting_id', meetingId)
        if (range) query = query.gte('idx', range.from).lte('idx', range.to)
        const { data, error } = await query.order('idx').range(offset, offset + PAGE - 1)
        if (error) fail('windows list', error)
        keys.push(...data.map(r => ({ idx: r.idx, contentHash: r.content_hash, model: r.model })))
        if (data.length < PAGE) return keys
      }
    },

    async upsertWindows(meetingId, batch) {
      for (let i = 0; i < batch.length; i += UPSERT_BATCH) {
        const rows = batch.slice(i, i + UPSERT_BATCH).map(w => windowToRow(meetingId, w))
        const { error } = await windows().upsert(rows, { onConflict: 'meeting_id,idx' })
        if (error) fail('windows upsert', error)
      }
    },

    async deleteForMeeting(meetingId) {
      // Normally a no-op by the time it runs: deleting the meeting cascades.
      const { error } = await windows().delete().eq('meeting_id', meetingId)
      if (error) fail('windows delete', error)
    },

    async search(meetingId, query, { model, limit }) {
      const { data, error } = await clientFor(options).rpc('match_transcript_windows', {
        p_meeting_id: meetingId,
        // pgvector's text input is the same bracketed list JSON produces.
        p_query: JSON.stringify(query),
        p_model: model,
        p_match_count: clampLimit(limit),
      })
      if (error) fail('windows search', error)
      return (data as WindowMatchRow[]).map(rowToMatch)
    },
  }
}
