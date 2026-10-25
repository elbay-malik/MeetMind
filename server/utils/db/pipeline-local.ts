import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { createStorage, type Storage } from 'unstorage'
import type { Meeting, MeetingSummary } from '#shared/types/meeting'
import { serialize } from './local'
import {
  assertStorableResult,
  assertValidLease,
  assertValidPlan,
  parseStoredResult,
  type PipelineRepository,
  type PipelineStage,
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
}

const ledgerKey = (meetingId: string) => `pipeline/${meetingId}`
// The meeting and summary repositories' own keys, under the same base: the
// fences below read and write them inside this meeting's one queue, the local
// stand-in for the row lock and transaction the SQL functions take.
const meetingKey = (meetingId: string) => `meetings/${meetingId}`
const summaryKey = (meetingId: string) => `summaries/${meetingId}`

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
 * supabase/migrations/20261026120000_pipeline_runs.sql; tests/unit/pipeline-ledger.spec.ts
 * asserts this against the cases scripts/verify-migrations.sh asserts the SQL against.
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

    async claimStep(meetingId, stage, { status, leaseMs, chunkNo, newRun = false, resetAttempts = false }) {
      assertValidLease(leaseMs)
      if (chunkNo !== undefined && newRun) throw new Error('A new run has no chunks to claim yet')
      return withLedger(meetingId, async (s, state) => {
        const meeting = await s.getItem<Meeting>(meetingKey(meetingId))
        if (!meeting || meeting.status !== status) return null

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
          if (chunk.result != null) return null
        }

        run.stepToken = randomUUID()
        run.stepLeaseUntil = now + leaseMs
        run.stepChunkNo = chunkNo ?? null
        run.attempts = newRun || chunk ? 0 : resetAttempts ? 1 : run.attempts + 1

        let attempts = run.attempts
        if (chunk) {
          chunk.attempts = resetAttempts ? 1 : chunk.attempts + 1
          attempts = chunk.attempts
        }

        state.runs[stage] = run
        await s.setItem<LedgerState>(ledgerKey(meetingId), state)
        await s.setItem<Meeting>(meetingKey(meetingId), { ...meeting, updatedAt: laterThan(meeting.updatedAt) })
        return { token: run.stepToken, runId: run.runId, cursor: run.cursor, attempts }
      })
    },

    async releaseStep(meetingId, stage, token, { error, retryAt, refundAttempt = false }) {
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
        run.lastError = error
        run.retryAt = retryAt ? retryAt.getTime() : null
        await s.setItem<LedgerState>(ledgerKey(meetingId), state)
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
            return { ...plan, attempts, result: parseStoredResult(plan, result) }
          })
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

    async deleteForMeeting(meetingId) {
      await serialize(meetingId, async () => {
        await (await storageFor(base)).removeItem(ledgerKey(meetingId))
      })
    },
  }
}
