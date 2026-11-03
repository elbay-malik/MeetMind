import { randomUUID } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { createClient } from '@supabase/supabase-js'
import type { Database } from '../../server/utils/db/database.types'
import { readPipeline } from '../../server/utils/pipeline/assess'
import { createSupabaseMeetingRepository } from '../../server/utils/db/supabase'
import { createSupabasePipelineRepository } from '../../server/utils/db/pipeline-supabase'
import { createSupabaseTranscriptIndexRepository } from '../../server/utils/db/windows-supabase'
import { startThrowawayPostgrest } from '../../scripts/lib/throwaway-postgrest.mjs'
import { MODEL, type MeetingSeed, type SlotSeed, type SweepDriver } from '../unit/helpers/sweep-cases'

/**
 * PostgREST serves from its root, and supabase-js asks for /rest/v1, as Supabase's own gateway
 * does. So a small proxy stands in for that gateway, which also lets a test count what is sent.
 */
function gateway(target: string): Promise<{ server: Server, url: string, requests: string[] }> {
  const requests: string[] = []
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(chunk as Buffer)
    requests.push(`${req.method} ${req.url}`)
    const headers = new Headers()
    for (const [name, value] of Object.entries(req.headers)) {
      if (typeof value === 'string' && !['host', 'content-length', 'connection'].includes(name)) headers.set(name, value)
    }
    const body = chunks.length > 0 ? Buffer.concat(chunks) : undefined
    const answer = await fetch(`${target}${req.url!.replace(/^\/rest\/v1/, '')}`, { method: req.method, headers, body })
    res.statusCode = answer.status
    answer.headers.forEach((value, name) => {
      if (!['content-encoding', 'transfer-encoding', 'content-length'].includes(name)) res.setHeader(name, value)
    })
    res.end(Buffer.from(await answer.arrayBuffer()))
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as { port: number }
      resolve({ server, url: `http://127.0.0.1:${address.port}`, requests })
    })
  })
}

export async function startSupabaseStandIn() {
  const pg = await startThrowawayPostgrest({ name: 'meetmind-postgrest-spec', port: 55436 })
  const front = await gateway(pg.url)
  const options = { url: front.url, serviceKey: pg.serviceKey }
  const client = createClient<Database>(options.url, options.serviceKey, { auth: { persistSession: false, autoRefreshToken: false } })

  async function seed(id: string, meeting: MeetingSeed) {
    const now = Date.now()
    const iso = (offsetMs: number) => new Date(now + offsetMs).toISOString()
    const past = ['summarizing', 'indexing', 'ready'].includes(meeting.status) || (meeting.status === 'failed' && meeting.failedStage === 'summarization')
    const lines = meeting.lines ?? (past ? 2 : 0)
    const must = <T extends { error: unknown }>(result: T) => {
      if (result.error) throw new Error(JSON.stringify(result.error))
      return result
    }

    must(await client.from('meetings').insert({
      id,
      title: 't',
      status: meeting.status,
      source_file_name: 'f',
      source_bytes: 1,
      source_mime: null,
      duration_sec: null,
      audio_key: `meetings/${id}/audio.ogg`,
      audio_bytes: 1,
      uploaded_at: iso(0),
      error_message: meeting.errorMessage ?? null,
      failed_stage: meeting.failedStage ?? null,
      created_at: iso(-(meeting.createdAgoMs ?? 0)),
    }))
    if (lines > 0) {
      must(await client.from('transcript_segments').insert(Array.from({ length: lines }, (_, idx) => ({ meeting_id: id, idx, start_ms: idx * 1000, end_ms: idx * 1000 + 500, text: `line ${idx}` }))))
    }
    const runs = { ...meeting.runs }
    if (meeting.chunks && !runs.summarization) runs.summarization = {}
    const runIds = new Map<string, string>()
    for (const [stage, run] of Object.entries(runs)) {
      const runId = randomUUID()
      runIds.set(stage, runId)
      must(await client.from('pipeline_runs').insert({
        meeting_id: id,
        stage: stage as 'transcription',
        run_id: runId,
        cursor: run.cursor ?? {},
        step_token: run.leaseInMs ? randomUUID() : null,
        step_lease_until: run.leaseInMs ? iso(run.leaseInMs) : null,
        attempts: run.attempts ?? 0,
        last_error: run.lastError ?? null,
        retry_at: run.retryInMs === undefined ? null : iso(run.retryInMs),
      }))
    }
    if (meeting.chunks) {
      must(await client.from('summary_chunks').insert(Array.from({ length: meeting.chunks.total }, (_, chunkNo) => ({
        meeting_id: id,
        chunk_no: chunkNo,
        run_id: runIds.get('summarization')!,
        seg_from: chunkNo,
        seg_to: chunkNo,
        est_tokens: 1,
        result: chunkNo < meeting.chunks!.done ? { summary: '', decisions: [], actionItems: [] } : null,
      }))))
    }
    if (meeting.windows) {
      const vector = `[${Array.from({ length: 1024 }, () => '0.1').join(',')}]`
      must(await client.from('transcript_windows').insert(Array.from({ length: meeting.windows.count }, (_, idx) => ({
        meeting_id: id, idx, first_segment_idx: 0, last_segment_idx: 0, start_ms: 0, end_ms: 1, content: 'w', content_hash: 'a'.repeat(64), model: meeting.windows!.model, embedding: vector,
      }))))
    }
    if (meeting.marker) {
      const { data: hash } = must(await client.rpc('transcript_hash', { p_meeting: id }))
      must(await client.from('meeting_index_state').insert({ meeting_id: id, text_hash: hash as unknown as string, model: meeting.marker.model, complete: meeting.marker.complete, window_count: meeting.marker.windowCount ?? 0 }))
    }
    // Last, since the trigger moves it on any update, and claims move it again.
    if (meeting.updatedAgoMs) await pg.sql(`alter table public.meetings disable trigger meetings_set_updated_at;
      update public.meetings set updated_at = '${iso(-meeting.updatedAgoMs)}' where id = '${id}';
      alter table public.meetings enable trigger meetings_set_updated_at;`)
  }

  const driver = (): SweepDriver => ({
    pipeline: createSupabasePipelineRepository(options),
    seed,
    async seedSlots(slots) {
      const now = Date.now()
      const iso = (offsetMs: number | undefined) => new Date(now + (offsetMs ?? -60_000)).toISOString()
      for (const [provider, slot] of Object.entries(slots) as Array<[string, SlotSeed]>) {
        const { error } = await client.from('provider_slots').upsert({ provider, next_available_at: iso(slot.nextInMs), blocked_until: iso(slot.blockedInMs) })
        if (error) throw new Error(error.message)
      }
    },
    async clear() {
      await pg.sql(`delete from public.meetings;
        update public.provider_slots set next_available_at = now() - interval '1 minute', blocked_until = now() - interval '1 minute';
        update public.sweep_state set last_created_at = null, last_meeting_id = null;`)
    },
    async snapshot(id) {
      return (await readPipeline(id, MODEL, {
        meetings: createSupabaseMeetingRepository(options),
        pipeline: createSupabasePipelineRepository(options),
        index: createSupabaseTranscriptIndexRepository(options),
      }))!
    },
  })

  return {
    driver,
    sql: pg.sql,
    requests: front.requests,
    options,
    stop: async () => {
      front.server.close()
      await pg.stop()
    },
  }
}
