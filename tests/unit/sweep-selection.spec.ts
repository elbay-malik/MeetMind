import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll } from 'vitest'
import { createLocalPipelineRepository } from '../../server/utils/db/pipeline-local'
import { hashTranscript } from '../../server/utils/db/windows-local'
import { readPipeline } from '../../server/utils/pipeline/assess'
import { indexingHarness } from './helpers/indexing'
import { describeExpirySelection, describeSweepSelection, MODEL, type MeetingSeed, type SweepDriver } from './helpers/sweep-cases'

let dataDir: string
beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'meetmind-sweep-selection-'))
})
afterAll(async () => {
  await rm(dataDir, { recursive: true, force: true })
})

const harness = indexingHarness(() => dataDir)

const emptyEmbedding = { firstSegmentIdx: 0, lastSegmentIdx: 0, startMs: 0, endMs: 1, text: 'w', contentHash: 'a'.repeat(64), embedding: [] }

async function seed(id: string, meeting: MeetingSeed) {
  const now = Date.now()
  const db = harness.db()
  const past = ['summarizing', 'indexing', 'ready'].includes(meeting.status) || (meeting.status === 'failed' && meeting.failedStage === 'summarization')
  const lines = meeting.lines ?? (past ? 2 : 0)
  const segments = Array.from({ length: lines }, (_, idx) => ({ idx, startMs: idx * 1000, endMs: idx * 1000 + 500, text: `line ${idx}` }))
  await harness.meetingWith(id, segments, meeting.status, {
    failedStage: meeting.failedStage ?? null,
    errorMessage: meeting.errorMessage ?? null,
  })
  const row = await db.getItem<Record<string, unknown>>(`meetings/${id}`)
  await db.setItem(`meetings/${id}`, {
    ...row,
    createdAt: meeting.createdAt ?? new Date(now - (meeting.createdAgoMs ?? 0)).toISOString(),
    updatedAt: new Date(now - (meeting.updatedAgoMs ?? 0)).toISOString(),
  })
  const runs = Object.fromEntries(Object.entries(meeting.runs ?? {}).map(([stage, run]) => [stage, {
    runId: `run-${stage}`,
    cursor: run.cursor ?? {},
    stepToken: run.leaseInMs !== undefined ? 'token' : null,
    stepLeaseUntil: run.leaseInMs !== undefined ? now + run.leaseInMs : null,
    attempts: run.attempts ?? 0,
    lastError: run.lastError ?? null,
    retryAt: run.retryInMs === undefined ? null : now + run.retryInMs,
  }]))
  if (meeting.chunks && !runs.summarization) {
    runs.summarization = { runId: 'run-summarization', cursor: {}, stepToken: null, stepLeaseUntil: null, attempts: 0, lastError: null, retryAt: null }
  }
  const chunks = Array.from({ length: meeting.chunks?.total ?? 0 }, (_, chunkNo) => ({
    chunkNo, runId: 'run-summarization', segFrom: chunkNo, segTo: chunkNo, estTokens: 1, attempts: 0,
    result: chunkNo < (meeting.chunks?.done ?? 0) ? { summary: '', decisions: [], actionItems: [], dropped: { decisions: 0, actionItems: 0 } } : null,
  }))
  await db.setItem(`pipeline/${id}`, {
    runs,
    chunks,
    ...(meeting.marker ? { indexMarker: { textHash: await hashTranscript(segments), windowCount: 0, ...meeting.marker } } : {}),
  })
  if (meeting.windows) {
    await db.setItem(`windows/${id}`, Array.from({ length: meeting.windows.count }, (_, idx) => ({ ...emptyEmbedding, idx, model: meeting.windows!.model })))
  }
}

const driver = (): SweepDriver => ({
  pipeline: createLocalPipelineRepository({ dataDir }),
  seed,
  async seedSlots(slots) {
    const now = Date.now()
    for (const [provider, slot] of Object.entries(slots)) {
      await harness.db().setItem(`slots/${provider}`, {
        nextAvailableAt: slot.nextInMs === undefined ? 0 : now + slot.nextInMs,
        blockedUntil: slot.blockedInMs === undefined ? 0 : now + slot.blockedInMs,
      })
    }
  },
  async clear() {
    const db = harness.db()
    for (const key of await db.getKeys()) await db.removeItem(key)
  },
  async snapshot(id) {
    const { meetings, pipeline, index } = harness.repos()
    return (await readPipeline(id, MODEL, { meetings, pipeline, index }))!
  },
})

describeSweepSelection('the local driver', driver)
describeExpirySelection('the local driver', driver)
