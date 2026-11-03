import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { createStorage, type Storage } from 'unstorage'
import type { Meeting, MeetingSummary, TranscriptSegment } from '#shared/types/meeting'
import { serialize } from './local'
import { hashTranscript } from './windows-local'
import type { EmbeddedWindow, IndexMarker } from './windows'
import type { SlotProvider, SlotState } from './slots'
import {
  afterInRotation,
  assertReleasable,
  assertStorableResult,
  assertValidIndexBatch,
  assertValidPage,
  assertValidLease,
  assertValidPlan,
  busyProviders,
  parseStoredResult,
  sweepCanMove,
  SWEEP_POOL,
  type PipelineRepository,
  type PipelineStage,
  type SweepFacts,
} from './pipeline'

const storages = new Map<string, Promise<Storage>>()

function storageFor(base: string): Promise<Storage> {
  let existing = storages.get(base)
  if (!existing) {
    existing = import('unstorage/drivers/fs').then(({ default: fsDriver }) =>
      createStorage({ driver: fsDriver({ base }) }))
    storages.set(base, existing)
  }
  return existing
}

interface LocalRun {
  runId: string
  cursor: Record<string, unknown>
  stepToken: string | null
  stepLeaseUntil: number | null
  /** The chunk the live step claimed, so a release knows whose attempt to refund. */
  stepChunkNo?: number | null
  attempts: number
  lastError: string | null
  retryAt: number | null
}

interface LocalChunk {
  chunkNo: number
  runId: string
  segFrom: number
  segTo: number
  estTokens: number
  attempts: number
  result: unknown
}

interface LedgerState {
  runs: Partial<Record<PipelineStage, LocalRun>>
  chunks: LocalChunk[]
  /** `meeting_index_state`, in the ledger so one write carries it and the cursor. */
  indexMarker?: IndexMarker
}

const ledgerKey = (meetingId: string) => `pipeline/${meetingId}`
// The meeting and summary repositories' own keys, under the same base: the
// fences below read and write them inside this meeting's one queue, the local
// stand-in for the row lock and transaction the SQL functions take.
const meetingKey = (meetingId: string) => `meetings/${meetingId}`
const summaryKey = (meetingId: string) => `summaries/${meetingId}`
const transcriptKey = (meetingId: string) => `transcripts/${meetingId}`
const windowsKey = (meetingId: string) => `windows/${meetingId}`
const SWEEP_STATE_KEY = 'sweep/state'

/** `public.sweep_state`: when a tick last ran, and the meeting the rotation last chose. */
interface LocalSweepState {
  lastTickAt: number
  createdAt?: string
  id?: string
}

/**
 * A timestamp strictly after `previous`. A delete is fenced on `updatedAt`
 * matching what it read, so a claim that left it unchanged -- two writes in
 * the same millisecond -- would not stop the delete.
 */
function laterThan(previous: string): string {
  return new Date(Math.max(Date.now(), Date.parse(previous) + 1)).toISOString()
}

/**
 * The run ledger as one JSON file per meeting under `<dataDir>/db/`, for
 * development and tests. A deliberate mirror of the SQL functions in
 * supabase/migrations/20261026120000_pipeline_runs.sql and the migrations
 * after it; tests/unit/pipeline-ledger.spec.ts asserts this against the cases
 * scripts/verify-migrations.sh asserts the SQL against.
 */
export function createLocalPipelineRepository(options: { dataDir: string }): PipelineRepository {
  const base = join(options.dataDir, 'db')

  /** Read-modify-write of one meeting's ledger, queued with every other write to that meeting. */
  function withLedger<T>(meetingId: string, work: (s: Storage, state: LedgerState) => Promise<T>): Promise<T> {
    return serialize(meetingId, async () => {
      const s = await storageFor(base)
      const state = (await s.getItem<LedgerState>(ledgerKey(meetingId))) ?? { runs: {}, chunks: [] }
      return work(s, state)
    })
  }

  /** The stage's run, only while `token` is its live step. */
  function liveRun(state: LedgerState, stage: PipelineStage, token: string): LocalRun | null {
    const run = state.runs[stage]
    return run && run.stepToken === token ? run : null
  }

  function endStep(run: LocalRun): void {
    run.stepToken = null
    run.stepLeaseUntil = null
    run.stepChunkNo = null
    run.lastError = null
    run.retryAt = null
  }

  return {
    kind: 'local',

    async claimStep(meetingId, stage, { status, leaseMs, chunkNo, newRun = false, resetAttempts = false, moveTo, redo = false, expectedUpdatedAt }) {
      assertValidLease(leaseMs)
      if (chunkNo !== undefined && newRun) throw new Error('A new run has no chunks to claim yet')
      return withLedger(meetingId, async (s, state) => {
        const meeting = await s.getItem<Meeting>(meetingKey(meetingId))
        if (!meeting || meeting.status !== status) return null
        if (expectedUpdatedAt !== undefined && meeting.updatedAt !== expectedUpdatedAt) return null

        const now = Date.now()
        const current = state.runs[stage]
        if (current?.stepLeaseUntil != null && current.stepLeaseUntil >= now) return null

        const run: LocalRun = current && !newRun
          ? { ...current }
          : { runId: randomUUID(), cursor: {}, stepToken: null, stepLeaseUntil: null, attempts: 0, lastError: null, retryAt: null }

        // Checked before anything is written, so a refused chunk claim changes nothing.
        const chunk = chunkNo === undefined ? undefined : state.chunks.find(c => c.chunkNo === chunkNo && c.runId === run.runId)
        if (chunkNo !== undefined) {
          if (!chunk) throw new Error(`Chunk ${chunkNo} is not in the current plan`)
          if (chunk.result != null && !redo) return null
        }

        run.stepToken = randomUUID()
        run.stepLeaseUntil = now + leaseMs
        run.stepChunkNo = chunkNo ?? null
        run.attempts = newRun || chunk ? 0 : resetAttempts ? 1 : run.attempts + 1

        let attempts = run.attempts
        if (chunk) {
          chunk.attempts = resetAttempts ? 1 : chunk.attempts + 1
          if (redo) chunk.result = null
          attempts = chunk.attempts
        }

        state.runs[stage] = run
        await s.setItem<LedgerState>(ledgerKey(meetingId), state)
        await s.setItem<Meeting>(meetingKey(meetingId), {
          ...meeting,
          ...(moveTo ? { status: moveTo, errorMessage: null, failedStage: null } : {}),
          updatedAt: laterThan(meeting.updatedAt),
        })
        return { token: run.stepToken, runId: run.runId, cursor: run.cursor, attempts }
      })
    },

    async releaseStep(meetingId, stage, token, { error, retryAt, refundAttempt = false, cursor, failFrom }) {
      assertReleasable(stage, failFrom)
      if (cursor !== undefined && (cursor === null || typeof cursor !== 'object' || Array.isArray(cursor))) {
        throw new Error('The cursor must be a JSON object')
      }
      return withLedger(meetingId, async (s, state) => {
        const run = liveRun(state, stage, token)
        if (!run) return false
        if (refundAttempt) {
          const chunk = run.stepChunkNo == null
            ? undefined
            : state.chunks.find(c => c.chunkNo === run.stepChunkNo && c.runId === run.runId)
          if (chunk) chunk.attempts = Math.max(chunk.attempts - 1, 0)
          else if (run.stepChunkNo == null) run.attempts = Math.max(run.attempts - 1, 0)
        }
        endStep(run)
        if (cursor !== undefined) run.cursor = structuredClone(cursor)
        run.lastError = error
        run.retryAt = retryAt ? retryAt.getTime() : null
        await s.setItem<LedgerState>(ledgerKey(meetingId), state)
        if (failFrom !== undefined) {
          const meeting = await s.getItem<Meeting>(meetingKey(meetingId))
          if (meeting && meeting.status === failFrom) {
            await s.setItem<Meeting>(meetingKey(meetingId), {
              ...meeting,
              status: 'failed',
              failedStage: stage as Exclude<PipelineStage, 'search_index'>,
              errorMessage: error ?? `The ${stage} step failed`,
              updatedAt: laterThan(meeting.updatedAt),
            })
          }
        }
        return true
      })
    },

    async listRuns(meetingId) {
      return withLedger(meetingId, async (_s, state) =>
        Object.entries(state.runs).map(([stage, run]) => ({
          stage: stage as PipelineStage,
          runId: run.runId,
          cursor: run.cursor,
          stepLeaseUntil: run.stepLeaseUntil === null ? null : new Date(run.stepLeaseUntil),
          attempts: run.attempts,
          lastError: run.lastError,
          retryAt: run.retryAt === null ? null : new Date(run.retryAt),
        })))
    },

    async planChunks(meetingId, token, chunks) {
      assertValidPlan(chunks)
      return withLedger(meetingId, async (s, state) => {
        const run = liveRun(state, 'summarization', token)
        if (!run) return false
        state.chunks = state.chunks.filter(c => c.runId === run.runId)
        if (state.chunks.length === 0) {
          state.chunks = chunks.map(c => ({ ...c, runId: run.runId, attempts: 0, result: null }))
        }
        await s.setItem<LedgerState>(ledgerKey(meetingId), state)
        return true
      })
    },

    async listChunks(meetingId) {
      return withLedger(meetingId, async (_s, state) => {
        const run = state.runs.summarization
        if (!run) return []
        return state.chunks
          .filter(c => c.runId === run.runId)
          .sort((a, b) => a.chunkNo - b.chunkNo)
          .map(({ chunkNo, segFrom, segTo, estTokens, attempts, result }) => {
            const plan = { chunkNo, segFrom, segTo, estTokens }
            const parsed = parseStoredResult(plan, result)
            return { ...plan, attempts, result: parsed, unusable: result != null && parsed === null }
          })
      })
    },

    async countChunks(meetingId, runId) {
      return withLedger(meetingId, async (_s, state) => {
        const plan = state.chunks.filter(c => c.runId === runId)
        return { done: plan.filter(c => c.result != null).length, total: plan.length }
      })
    },

    async recordChunk(meetingId, token, chunk, result) {
      assertStorableResult(chunk, result)
      return withLedger(meetingId, async (s, state) => {
        const run = liveRun(state, 'summarization', token)
        if (!run) return false
        const stored = state.chunks.find(c => c.chunkNo === chunk.chunkNo && c.runId === run.runId)
        if (!stored || stored.segFrom !== chunk.segFrom || stored.segTo !== chunk.segTo) return false
        stored.result = structuredClone(result)
        endStep(run)
        await s.setItem<LedgerState>(ledgerKey(meetingId), state)
        return true
      })
    },

    async finalizeSummary(meetingId, token, summary) {
      return withLedger(meetingId, async (s, state) => {
        const run = liveRun(state, 'summarization', token)
        if (!run) return false
        if (state.chunks.some(c => c.runId === run.runId && c.result == null)) {
          throw new Error('A chunk of the current plan has no result yet')
        }
        const meeting = await s.getItem<Meeting>(meetingKey(meetingId))
        if (!meeting || meeting.status !== 'indexing') return false

        endStep(run)
        // Summary, then status, then ledger: a crash part-way leaves the
        // meeting `indexing` with its step lease to expire, and the next
        // finalize writes the same summary again.
        await s.setItem<MeetingSummary>(summaryKey(meetingId), summary)
        await s.setItem<Meeting>(meetingKey(meetingId), {
          ...meeting,
          status: 'ready',
          errorMessage: null,
          failedStage: null,
          updatedAt: laterThan(meeting.updatedAt),
        })
        await s.setItem<LedgerState>(ledgerKey(meetingId), state)
        return true
      })
    },

    async appendSegments(meetingId, token, page) {
      assertValidPage(page)
      return withLedger(meetingId, async (s, state) => {
        const run = liveRun(state, 'transcription', token)
        if (!run) return false
        const meeting = await s.getItem<Meeting>(meetingKey(meetingId))
        if (!meeting || meeting.status !== 'transcribing') return false

        const stored = (await s.getItem<TranscriptSegment[]>(transcriptKey(meetingId))) ?? []
        await s.setItem<TranscriptSegment[]>(transcriptKey(meetingId), [
          ...stored.filter(segment => segment.idx < page.fromIdx),
          ...page.segments,
        ])
        endStep(run)
        run.attempts = 0
        run.cursor = structuredClone(page.cursor)
        await s.setItem<LedgerState>(ledgerKey(meetingId), state)
        return true
      })
    },

    async finishTranscription(meetingId, token, { chunks, refusal }) {
      assertValidPlan(chunks)
      return withLedger(meetingId, async (s, state) => {
        const run = liveRun(state, 'transcription', token)
        if (!run) return false
        const meeting = await s.getItem<Meeting>(meetingKey(meetingId))
        if (!meeting || meeting.status !== 'transcribing') return false

        const runId = randomUUID()
        state.runs.summarization = { runId, cursor: {}, stepToken: null, stepLeaseUntil: null, attempts: 0, lastError: null, retryAt: null }
        state.chunks = refusal === null
          ? chunks.map(c => ({ ...c, runId, attempts: 0, result: null }))
          : []
        endStep(run)
        run.attempts = 0
        run.cursor = {}
        await s.setItem<LedgerState>(ledgerKey(meetingId), state)
        await s.setItem<Meeting>(meetingKey(meetingId), {
          ...meeting,
          ...(refusal === null
            ? { status: 'summarizing' as const, errorMessage: null, failedStage: null }
            : { status: 'failed' as const, errorMessage: refusal, failedStage: 'summarization' as const }),
          updatedAt: laterThan(meeting.updatedAt),
        })
        return true
      })
    },

    async upsertWindows(meetingId, token, batch) {
      assertValidIndexBatch(batch)
      return withLedger(meetingId, async (s, state) => {
        const run = liveRun(state, 'search_index', token)
        if (!run) return false
        // What the foreign key does on Supabase: a run outliving its meeting's delete
        // must not write the windows back.
        if (!await s.getItem<Meeting>(meetingKey(meetingId))) return false

        if (batch.windows.length > 0) {
          const byIdx = new Map(((await s.getItem<EmbeddedWindow[]>(windowsKey(meetingId))) ?? []).map(w => [w.idx, w]))
          for (const window of batch.windows) byIdx.set(window.idx, window)
          await s.setItem(windowsKey(meetingId), [...byIdx.values()].sort((a, b) => a.idx - b.idx))
        }
        state.indexMarker = { textHash: batch.textHash, model: batch.model, windowCount: 0, complete: false }
        endStep(run)
        run.attempts = 0
        run.cursor = structuredClone(batch.cursor)
        await s.setItem<LedgerState>(ledgerKey(meetingId), state)
        return true
      })
    },

    async finishIndex(meetingId, token, { textHash, model, windowCount }) {
      if (!Number.isInteger(windowCount) || windowCount < 0) {
        throw new Error(`The window count must not be negative, got ${windowCount}`)
      }
      return withLedger(meetingId, async (s, state) => {
        const run = liveRun(state, 'search_index', token)
        if (!run) return 'lost'
        if (!await s.getItem<Meeting>(meetingKey(meetingId))) return 'lost'

        const segments = (await s.getItem<TranscriptSegment[]>(transcriptKey(meetingId))) ?? []
        if (await hashTranscript(segments) !== textHash) return 'changed'

        const windows = (await s.getItem<EmbeddedWindow[]>(windowsKey(meetingId))) ?? []
        const planned = windows.filter(w => w.model === model && w.idx < windowCount)
        const reaches = planned.find(w => w.idx === windowCount - 1)?.lastSegmentIdx ?? null
        const lastLine = segments.length === 0 ? null : Math.max(...segments.map(line => line.idx))
        if (planned.length !== windowCount || reaches !== lastLine) return 'changed'

        const kept = windows.filter(w => w.idx < windowCount)
        if (kept.length !== windows.length) await s.setItem(windowsKey(meetingId), kept)
        state.indexMarker = { textHash, model, windowCount, complete: true }
        endStep(run)
        run.attempts = 0
        run.cursor = {}
        await s.setItem<LedgerState>(ledgerKey(meetingId), state)
        return 'complete'
      })
    },

    async deleteForMeeting(meetingId) {
      await serialize(meetingId, async () => {
        await (await storageFor(base)).removeItem(ledgerKey(meetingId))
      })
    },

    async nextForSweep({ model, excludeId, limitError }) {
      // One queue, as `sweep_next_meeting` takes one row lock.
      return serialize(SWEEP_STATE_KEY, async () => {
        const s = await storageFor(base)
        const now = Date.now()
        const last = await s.getItem<LocalSweepState>(SWEEP_STATE_KEY)
        await s.setItem<LocalSweepState>(SWEEP_STATE_KEY, { ...last, lastTickAt: now })

        const slots: Partial<Record<SlotProvider, SlotState>> = {}
        for (const provider of ['groq-chat', 'groq-whisper', 'workers-ai-embed'] as const) {
          const slot = await s.getItem<SlotState>(`slots/${provider}`)
          if (slot) slots[provider] = slot
        }
        const busy = busyProviders(slots, now)

        const items = await s.getItems<Meeting>(await s.getKeys('meetings'))
        const meetings = items.map(item => item.value).filter((m): m is Meeting => !!m)
        const byUpdate = (a: Meeting, b: Meeting) => Date.parse(a.updatedAt) - Date.parse(b.updatedAt) || (a.id < b.id ? -1 : 1)
        const inProgress = meetings.filter(m => ['uploaded', 'transcribing', 'summarizing', 'indexing'].includes(m.status))
          .sort(byUpdate).slice(0, SWEEP_POOL)
        const transcriptFinished = meetings.filter(m => m.status === 'ready' || (m.status === 'failed' && m.failedStage === 'summarization'))
          .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt) || (a.id < b.id ? -1 : 1)).slice(0, SWEEP_POOL)

        const lastChosen = last?.createdAt && last.id ? { createdAt: last.createdAt, id: last.id } : null
        const inOrder = [...inProgress, ...transcriptFinished]
          .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt) || (a.id < b.id ? -1 : 1))
        const rotated = [...inOrder.filter(m => afterInRotation(m, lastChosen)), ...inOrder.filter(m => !afterInRotation(m, lastChosen))]

        for (const meeting of rotated) {
          if (excludeId !== null && meeting.id.toLowerCase() === excludeId.toLowerCase()) continue
          if (!sweepCanMove(await factsOf(s, meeting), { model, limitError, busy, now })) continue
          await s.setItem<LocalSweepState>(SWEEP_STATE_KEY, { lastTickAt: now, createdAt: meeting.createdAt, id: meeting.id })
          return { meetingId: meeting.id, busy }
        }
        return { meetingId: null, busy }

        async function factsOf(storage: Storage, meeting: Meeting): Promise<SweepFacts> {
          const ledger = await storage.getItem<LedgerState>(ledgerKey(meeting.id))
          const windows = (await storage.getItem<EmbeddedWindow[]>(windowsKey(meeting.id))) ?? []
          const lines = (await storage.getItem<TranscriptSegment[]>(transcriptKey(meeting.id))) ?? []
          const run = (stage: PipelineStage) => {
            const stored = ledger?.runs[stage]
            return stored && {
              cursor: stored.cursor,
              lastError: stored.lastError,
              retryAt: stored.retryAt === null ? null : new Date(stored.retryAt),
              stepLeaseUntil: stored.stepLeaseUntil === null ? null : new Date(stored.stepLeaseUntil),
            }
          }
          const extraction = ledger?.runs.summarization
          return {
            status: meeting.status,
            failedStage: meeting.failedStage ?? null,
            runs: { transcription: run('transcription'), summarization: run('summarization'), search_index: run('search_index') },
            unfinishedChunk: !!extraction && (ledger?.chunks ?? []).some(c => c.runId === extraction.runId && c.result == null),
            marker: ledger?.indexMarker ?? null,
            hasLines: lines.length > 0,
            hasWindows: windows.length > 0,
            hasOtherModelWindows: windows.some(w => w.model !== model),
          }
        }
      })
    },
  }
}
