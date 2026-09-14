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
 * Rows per upsert request. Each row carries 768 floats as JSON, roughly 12 KB,
 * so a meeting's worth in one body would be several megabytes for no benefit.
 */
const UPSERT_BATCH = 50

export function createSupabaseTranscriptIndexRepository(options: SupabaseOptions): TranscriptIndexRepository {
  const windows = () => clientFor(options).from('transcript_windows')

  return {
    kind: 'supabase',

    async listKeys(meetingId) {
      const keys: { idx: number, contentHash: string, model: string }[] = []
      for (let offset = 0; ; offset += PAGE) {
        const { data, error } = await windows()
          // Never the embedding: a meeting's vectors would be megabytes to
          // download just to compare hashes.
          .select('idx, content_hash, model')
          .eq('meeting_id', meetingId)
          .order('idx')
          .range(offset, offset + PAGE - 1)
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

    async deleteExcept(meetingId, keep) {
      let query = windows().delete().eq('meeting_id', meetingId)
      // PostgREST rejects `not.in.()`; with nothing to keep, delete them all.
      if (keep.length > 0) query = query.not('idx', 'in', `(${keep.map(k => Math.trunc(k)).join(',')})`)
      const { error } = await query
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
