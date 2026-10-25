import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createStorage } from 'unstorage'
import fsDriver from 'unstorage/drivers/fs'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { Meeting, MeetingStatus, MeetingSummary } from '../../shared/types/meeting'
import { createLocalMeetingRepository } from '../../server/utils/db/local'
import { createLocalPipelineRepository } from '../../server/utils/db/pipeline-local'
import { createLocalSummaryRepository } from '../../server/utils/db/summaries-local'
import type { ChunkPlan } from '../../server/utils/db/pipeline'
import { deleteMeeting } from '../../server/utils/meeting-deletion'
import type { AttestedChunk } from '../../server/utils/summary/reconcile'

/**
 * The run ledger's rules, against the local driver. Each case here has a twin
 * in scripts/verify-migrations.sh that asserts the same rule against the SQL
 * functions, so the two drivers cannot drift apart unnoticed.
 */

let dataDir: string
beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'meetmind-ledger-'))
})
afterAll(async () => {
  await rm(dataDir, { recursive: true, force: true })
})

const repos = () => ({
  meetings: createLocalMeetingRepository({ dataDir }),
  pipeline: createLocalPipelineRepository({ dataDir }),
  summaries: createLocalSummaryRepository({ dataDir }),
})

async function newMeeting(status: MeetingStatus = 'indexing'): Promise<Meeting> {
  const id = randomUUID()
  return repos().meetings.create({
    id,
    title: 'Planning',
    status,
    sourceFileName: 'planning.m4a',
    sourceBytes: 1000,
    sourceMime: 'audio/mp4',
    durationSec: 60,
    audioKey: `meetings/${id}/audio.ogg`,
    audioBytes: 500,
    audioMime: 'audio/ogg',
    uploadedAt: new Date().toISOString(),
    errorMessage: null,
    failedStage: null,
  })
}

const LEASE = 60_000
const plan: ChunkPlan[] = [
  { chunkNo: 0, segFrom: 0, segTo: 4, estTokens: 900 },
  { chunkNo: 1, segFrom: 5, segTo: 9, estTokens: 800 },
]
const result = (segmentIdx: number, text = 'Ship on Friday'): AttestedChunk => ({
  summary: `Chunk around ${segmentIdx}.`,
  decisions: [{ decision: text, quote: 'we ship friday', segmentIdx, startMs: segmentIdx * 1000 }],
  actionItems: [],
  droppedDecisions: 0,
  droppedActionItems: 0,
})
const summary: MeetingSummary = {
  summary: 'Shipping Friday.',
  provider: 'stub',
  decisions: [{ idx: 0, decision: 'Ship on Friday', quote: 'we ship friday', segmentIdx: 2, startMs: 2000 }],
  actionItems: [],
}
const expire = () => new Promise(resolve => setTimeout(resolve, 5))

/** A meeting with its two-chunk plan written, and the planning step's claim still held. */
async function planned() {
  const m = await newMeeting()
  const { pipeline } = repos()
  const claim = (await pipeline.claimStep(m.id, 'summarization', { status: 'indexing', leaseMs: LEASE }))!
  expect(await pipeline.planChunks(m.id, claim.token, plan)).toBe(true)
  return { m, pipeline, claim }
}

/** Every chunk recorded, and a fresh step claimed to finalize with. */
async function readyToFinalize() {
  const { m, pipeline, claim } = await planned()
  await pipeline.recordChunk(m.id, claim.token, plan[0]!, result(2))
  const second = (await pipeline.claimStep(m.id, 'summarization', { status: 'indexing', leaseMs: LEASE, chunkNo: 1 }))!
  await pipeline.recordChunk(m.id, second.token, plan[1]!, result(7))
  const final = (await pipeline.claimStep(m.id, 'summarization', { status: 'indexing', leaseMs: LEASE }))!
  return { m, pipeline, token: final.token }
}

describe('claimStep', () => {
  it('grants the first claim, counting it as the first attempt, and refuses a second while its lease lives', async () => {
    const m = await newMeeting()
    const { pipeline } = repos()
    const first = await pipeline.claimStep(m.id, 'summarization', { status: 'indexing', leaseMs: LEASE })
    expect(first).toMatchObject({ attempts: 1, cursor: {} })
    expect(await pipeline.claimStep(m.id, 'summarization', { status: 'indexing', leaseMs: LEASE })).toBeNull()

    const [run] = await pipeline.listRuns(m.id)
    expect(run).toMatchObject({ stage: 'summarization', runId: first!.runId, attempts: 1 })
    expect(run!.stepLeaseUntil!.getTime()).toBeGreaterThan(Date.now() + LEASE - 5_000)
  })

  it('leaves another stage of the same meeting free to claim', async () => {
    const m = await newMeeting()
    const { pipeline } = repos()
    expect(await pipeline.claimStep(m.id, 'summarization', { status: 'indexing', leaseMs: LEASE })).not.toBeNull()
    expect(await pipeline.claimStep(m.id, 'search_index', { status: 'indexing', leaseMs: LEASE })).not.toBeNull()
  })

  it('claims nothing, and creates no run, when the meeting is not in the expected status', async () => {
    const m = await newMeeting('ready')
    const { meetings, pipeline } = repos()
    expect(await pipeline.claimStep(m.id, 'summarization', { status: 'indexing', leaseMs: LEASE })).toBeNull()
    expect(await pipeline.listRuns(m.id)).toEqual([])
    expect((await meetings.get(m.id))!.updatedAt).toBe(m.updatedAt)
  })

  it('claims nothing for a meeting that does not exist', async () => {
    expect(await repos().pipeline.claimStep(randomUUID(), 'summarization', { status: 'indexing', leaseMs: LEASE })).toBeNull()
  })

  // What makes a fenced delete lose to a claim it did not see (ADR-0011).
  it('moves the meeting\'s updatedAt', async () => {
    const m = await newMeeting()
    const { meetings, pipeline } = repos()
    await pipeline.claimStep(m.id, 'summarization', { status: 'indexing', leaseMs: LEASE })
    expect(Date.parse((await meetings.get(m.id))!.updatedAt)).toBeGreaterThan(Date.parse(m.updatedAt))
  })

  it('re-claims a step whose lease has run out, under a new token, counting the killed attempt', async () => {
    const m = await newMeeting()
    const { pipeline } = repos()
    const killed = (await pipeline.claimStep(m.id, 'summarization', { status: 'indexing', leaseMs: 1 }))!
    await expire()
    const next = await pipeline.claimStep(m.id, 'summarization', { status: 'indexing', leaseMs: LEASE })
    expect(next).toMatchObject({ runId: killed.runId, attempts: 2 })
    expect(next!.token).not.toBe(killed.token)
  })

  it('counts a chunk claim on the chunk, not the run', async () => {
    const { m, pipeline, claim } = await planned()
    await pipeline.releaseStep(m.id, 'summarization', claim.token, { error: null, retryAt: null })
    const a = await pipeline.claimStep(m.id, 'summarization', { status: 'indexing', leaseMs: 1, chunkNo: 1 })
    await expire()
    const b = await pipeline.claimStep(m.id, 'summarization', { status: 'indexing', leaseMs: LEASE, chunkNo: 1 })
    expect([a!.attempts, b!.attempts]).toEqual([1, 2])
    expect((await pipeline.listChunks(m.id)).map(c => c.attempts)).toEqual([0, 2])
  })

  it('refuses a chunk the plan does not have, and holds no lease afterwards', async () => {
    const { m, pipeline, claim } = await planned()
    await pipeline.releaseStep(m.id, 'summarization', claim.token, { error: null, retryAt: null })
    await expect(pipeline.claimStep(m.id, 'summarization', { status: 'indexing', leaseMs: LEASE, chunkNo: 7 }))
      .rejects.toThrow(/not in the current plan/)
    expect((await pipeline.listRuns(m.id))[0]!.stepLeaseUntil).toBeNull()
  })

  it('starts a new run on request, leaving the old run\'s chunks stale', async () => {
    const { m, pipeline, claim } = await planned()
    await pipeline.recordChunk(m.id, claim.token, plan[0]!, result(2))
    const fresh = await pipeline.claimStep(m.id, 'summarization', { status: 'indexing', leaseMs: LEASE, newRun: true })
    expect(fresh!.runId).not.toBe(claim.runId)
    expect(fresh!.attempts).toBe(0)
    expect(await pipeline.listChunks(m.id)).toEqual([])
  })

  // Two drivers that both read "chunk 1 has no result" must not both spend a
  // provider call on it.
  it('does not claim a chunk that already has its result, and holds no lease', async () => {
    const { m, pipeline, claim } = await planned()
    await pipeline.recordChunk(m.id, claim.token, plan[0]!, result(2))
    expect(await pipeline.claimStep(m.id, 'summarization', { status: 'indexing', leaseMs: LEASE, chunkNo: 0 })).toBeNull()
    expect((await pipeline.listRuns(m.id))[0]!.stepLeaseUntil).toBeNull()
    expect((await pipeline.listChunks(m.id))[0]!.attempts).toBe(0)
  })

  it('restarts a chunk\'s attempts on request, as when a failed run is retried', async () => {
    const { m, pipeline, claim } = await planned()
    await pipeline.releaseStep(m.id, 'summarization', claim.token, { error: null, retryAt: null })
    for (let i = 0; i < 2; i++) {
      const c = (await pipeline.claimStep(m.id, 'summarization', { status: 'indexing', leaseMs: LEASE, chunkNo: 1 }))!
      await pipeline.releaseStep(m.id, 'summarization', c.token, { error: 'boom', retryAt: null })
    }
    const retried = await pipeline.claimStep(m.id, 'summarization', { status: 'indexing', leaseMs: LEASE, chunkNo: 1, resetAttempts: true })
    expect(retried!.attempts).toBe(1)
  })

  it.each([0, 0.4, -5, 2_147_483_648, Number.NaN])('refuses a lease of %s ms, as Postgres\'s integer parameter would', async (leaseMs) => {
    const m = await newMeeting()
    await expect(repos().pipeline.claimStep(m.id, 'summarization', { status: 'indexing', leaseMs })).rejects.toThrow(/whole number/)
  })
})

describe('releaseStep', () => {
  it('ends the step, recording why and when to try again, so the next caller can claim at once', async () => {
    const m = await newMeeting()
    const { pipeline } = repos()
    const claim = (await pipeline.claimStep(m.id, 'summarization', { status: 'indexing', leaseMs: LEASE }))!
    const retryAt = new Date(Date.now() + 60_000)
    expect(await pipeline.releaseStep(m.id, 'summarization', claim.token, { error: 'busy', retryAt })).toBe(true)
    expect((await pipeline.listRuns(m.id))[0]).toMatchObject({ stepLeaseUntil: null, lastError: 'busy', retryAt })
    expect(await pipeline.claimStep(m.id, 'summarization', { status: 'indexing', leaseMs: LEASE })).not.toBeNull()
  })

  // A slot miss or a 429: the step made no provider call, so it must not use
  // up one of the chunk's attempts (ADR-0012 §5).
  it('gives a chunk claim\'s attempt back when the step made no provider call', async () => {
    const { m, pipeline, claim } = await planned()
    await pipeline.releaseStep(m.id, 'summarization', claim.token, { error: null, retryAt: null })
    const missed = (await pipeline.claimStep(m.id, 'summarization', { status: 'indexing', leaseMs: LEASE, chunkNo: 1 }))!
    expect(missed.attempts).toBe(1)
    await pipeline.releaseStep(m.id, 'summarization', missed.token, { error: null, retryAt: null, refundAttempt: true })
    expect((await pipeline.listChunks(m.id))[1]!.attempts).toBe(0)
    expect((await pipeline.claimStep(m.id, 'summarization', { status: 'indexing', leaseMs: LEASE, chunkNo: 1 }))!.attempts).toBe(1)
  })

  it('gives a run claim\'s attempt back when the step made no provider call', async () => {
    const m = await newMeeting()
    const { pipeline } = repos()
    const claim = (await pipeline.claimStep(m.id, 'summarization', { status: 'indexing', leaseMs: LEASE }))!
    await pipeline.releaseStep(m.id, 'summarization', claim.token, { error: null, retryAt: null, refundAttempt: true })
    expect((await pipeline.listRuns(m.id))[0]!.attempts).toBe(0)
  })

  it('does nothing for a token that is not the live one', async () => {
    const m = await newMeeting()
    const { pipeline } = repos()
    await pipeline.claimStep(m.id, 'summarization', { status: 'indexing', leaseMs: LEASE })
    expect(await pipeline.releaseStep(m.id, 'summarization', randomUUID(), { error: 'x', retryAt: null })).toBe(false)
    expect((await pipeline.listRuns(m.id))[0]!.stepLeaseUntil).not.toBeNull()
  })
})

describe('planChunks', () => {
  it('writes the plan and keeps the step\'s claim, since planning makes no provider call', async () => {
    const { m, pipeline } = await planned()
    expect((await pipeline.listChunks(m.id)).map(c => [c.chunkNo, c.segFrom, c.segTo, c.result])).toEqual([
      [0, 0, 4, null],
      [1, 5, 9, null],
    ])
    expect((await pipeline.listRuns(m.id))[0]!.stepLeaseUntil).not.toBeNull()
  })

  it('keeps an existing plan for the same run as it is, results and all', async () => {
    const { m, pipeline, claim } = await planned()
    await pipeline.recordChunk(m.id, claim.token, plan[0]!, result(2))
    const again = (await pipeline.claimStep(m.id, 'summarization', { status: 'indexing', leaseMs: LEASE }))!
    expect(await pipeline.planChunks(m.id, again.token, [{ chunkNo: 0, segFrom: 0, segTo: 9, estTokens: 1 }])).toBe(true)
    const chunks = await pipeline.listChunks(m.id)
    expect(chunks).toHaveLength(2)
    expect(chunks[0]!.result).toEqual(result(2))
  })

  it('replaces an older run\'s plan', async () => {
    const { m, pipeline, claim } = await planned()
    await pipeline.recordChunk(m.id, claim.token, plan[0]!, result(2))
    const fresh = (await pipeline.claimStep(m.id, 'summarization', { status: 'indexing', leaseMs: LEASE, newRun: true }))!
    const replan: ChunkPlan[] = [{ chunkNo: 0, segFrom: 0, segTo: 9, estTokens: 1700 }]
    expect(await pipeline.planChunks(m.id, fresh.token, replan)).toBe(true)
    expect((await pipeline.listChunks(m.id)).map(c => [c.segFrom, c.segTo, c.result])).toEqual([[0, 9, null]])
  })

  it('makes a new run wait for a live step of the old one', async () => {
    const { m, pipeline } = await planned()
    expect(await pipeline.claimStep(m.id, 'summarization', { status: 'indexing', leaseMs: LEASE, newRun: true })).toBeNull()
  })

  it('writes nothing under a token that is not the live one', async () => {
    const m = await newMeeting()
    const { pipeline } = repos()
    await pipeline.claimStep(m.id, 'summarization', { status: 'indexing', leaseMs: LEASE })
    expect(await pipeline.planChunks(m.id, randomUUID(), plan)).toBe(false)
    expect(await pipeline.listChunks(m.id)).toEqual([])
  })

  it('refuses a plan that is not numbered 0..n-1', async () => {
    const m = await newMeeting()
    const { pipeline } = repos()
    const claim = (await pipeline.claimStep(m.id, 'summarization', { status: 'indexing', leaseMs: LEASE }))!
    await expect(pipeline.planChunks(m.id, claim.token, [plan[1]!])).rejects.toThrow(/numbered/)
  })
})

describe('recordChunk', () => {
  it('stores the result and ends the step', async () => {
    const { m, pipeline, claim } = await planned()
    expect(await pipeline.recordChunk(m.id, claim.token, plan[0]!, result(2))).toBe(true)
    expect((await pipeline.listChunks(m.id))[0]!.result).toEqual(result(2))
    expect((await pipeline.listRuns(m.id))[0]!.stepLeaseUntil).toBeNull()
  })

  // A step killed after its lease ran out, finishing after another caller
  // re-claimed it: its write must land nowhere.
  it('drops a straggler\'s write once the step has been re-claimed', async () => {
    const m = await newMeeting()
    const { pipeline } = repos()
    const straggler = (await pipeline.claimStep(m.id, 'summarization', { status: 'indexing', leaseMs: 1 }))!
    await expire()
    const current = (await pipeline.claimStep(m.id, 'summarization', { status: 'indexing', leaseMs: LEASE }))!
    await pipeline.planChunks(m.id, current.token, plan)
    expect(await pipeline.recordChunk(m.id, straggler.token, plan[0]!, result(2))).toBe(false)
    expect((await pipeline.listChunks(m.id))[0]!.result).toBeNull()
  })

  // The caller's plan can differ from the stored one (a retried planning step
  // keeps the stored plan). The result must match the range it is stored under.
  it('records nothing when the segment range differs from the stored plan\'s', async () => {
    const { m, pipeline, claim } = await planned()
    expect(await pipeline.recordChunk(m.id, claim.token, { ...plan[0]!, segTo: 9 }, result(2))).toBe(false)
    expect((await pipeline.listChunks(m.id))[0]!.result).toBeNull()
  })

  it('records nothing for a chunk the plan does not have', async () => {
    const { m, pipeline, claim } = await planned()
    expect(await pipeline.recordChunk(m.id, claim.token, { chunkNo: 5, segFrom: 0, segTo: 9, estTokens: 1 }, result(2))).toBe(false)
  })

  it('refuses a result citing a line outside its chunk, before writing anything', async () => {
    const { m, pipeline, claim } = await planned()
    await expect(pipeline.recordChunk(m.id, claim.token, plan[0]!, result(7))).rejects.toThrow(/outside 0\.\.4|outside the chunk/)
    expect((await pipeline.listChunks(m.id))[0]!.result).toBeNull()
  })
})

describe('listChunks re-validates what it reads back', () => {
  async function corrupt(meetingId: string, chunkNo: number, value: unknown) {
    const storage = createStorage({ driver: fsDriver({ base: join(dataDir, 'db') }) })
    const state = (await storage.getItem<{ chunks: { chunkNo: number, result: unknown }[] }>(`pipeline/${meetingId}`))!
    state.chunks.find(c => c.chunkNo === chunkNo)!.result = value
    await storage.setItem(`pipeline/${meetingId}`, state)
  }

  it.each([
    ['a malformed result', { summary: 'x', decisions: 'not an array' }],
    ['an item citing a line outside the chunk', result(9)],
    ['a negative dropped count', { ...result(2), droppedDecisions: -1 }],
  ])('reads %s as no result, so the chunk is done again rather than merged', async (_label, stored) => {
    const { m, pipeline, claim } = await planned()
    await pipeline.recordChunk(m.id, claim.token, plan[0]!, result(2))
    await corrupt(m.id, 0, stored)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    expect((await pipeline.listChunks(m.id))[0]!.result).toBeNull()
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/chunk 0 is unusable/))
    warn.mockRestore()
  })
})

describe('finalizeSummary', () => {
  it('writes the summary and moves the meeting to ready, ending the step', async () => {
    const { m, pipeline, token } = await readyToFinalize()
    const { meetings, summaries } = repos()
    expect(await pipeline.finalizeSummary(m.id, token, summary)).toBe(true)
    expect(await summaries.getForMeeting(m.id)).toEqual(summary)
    expect((await meetings.get(m.id))!.status).toBe('ready')
    expect((await pipeline.listRuns(m.id))[0]!.stepLeaseUntil).toBeNull()
  })

  it('refuses while a chunk of the plan has no result, writing nothing', async () => {
    const { m, pipeline, claim } = await planned()
    await expect(pipeline.finalizeSummary(m.id, claim.token, summary)).rejects.toThrow(/no result/)
    expect(await repos().summaries.getForMeeting(m.id)).toBeNull()
    expect((await repos().meetings.get(m.id))!.status).toBe('indexing')
  })

  it('writes nothing under a token that is not the live one', async () => {
    const { m, pipeline } = await readyToFinalize()
    expect(await pipeline.finalizeSummary(m.id, randomUUID(), summary)).toBe(false)
    expect(await repos().summaries.getForMeeting(m.id)).toBeNull()
  })

  it('writes nothing once the meeting has left indexing', async () => {
    const { m, pipeline, token } = await readyToFinalize()
    await repos().meetings.update(m.id, { status: 'failed', failedStage: 'summarization', errorMessage: 'x' })
    expect(await pipeline.finalizeSummary(m.id, token, summary)).toBe(false)
    expect(await repos().summaries.getForMeeting(m.id)).toBeNull()
  })
})

describe('deleting a meeting with a run ledger (ADR-0012 amends ADR-0011)', () => {
  // Created long ago, so the upload-URL window does not decide these cases.
  async function oldMeeting(status: MeetingStatus) {
    const m = await newMeeting(status)
    const { meetings } = repos()
    const storage = createStorage({ driver: fsDriver({ base: join(dataDir, 'db') }) })
    const old = { ...(await meetings.get(m.id))!, createdAt: '2026-01-01T00:00:00.000Z' }
    await storage.setItem(`meetings/${m.id}`, old)
    return old
  }

  function deps() {
    const { meetings, pipeline } = repos()
    return {
      meetings,
      pipeline,
      removeData: async (meetingId: string) => pipeline.deleteForMeeting(meetingId),
      indexingRuns: new Map(),
    }
  }

  it('refuses while a step holds a live lease', async () => {
    const m = await oldMeeting('ready')
    await repos().pipeline.claimStep(m.id, 'search_index', { status: 'ready', leaseMs: LEASE })
    expect(await deleteMeeting(m.id, deps())).toMatchObject({ kind: 'blocked', reason: expect.stringMatching(/pipeline step/) })
  })

  it('deletes a run parked between steps, and its ledger with it', async () => {
    const m = await oldMeeting('ready')
    const { pipeline } = repos()
    const claim = (await pipeline.claimStep(m.id, 'search_index', { status: 'ready', leaseMs: LEASE }))!
    await pipeline.releaseStep(m.id, 'search_index', claim.token, { error: null, retryAt: new Date(Date.now() + 60_000) })
    expect(await deleteMeeting(m.id, deps())).toEqual({ kind: 'deleted' })
    expect(await pipeline.listRuns(m.id)).toEqual([])
  })

  it('leaves nothing for a straggler whose lease ran out to write into after the delete', async () => {
    const { m, pipeline, claim } = await planned()
    await pipeline.releaseStep(m.id, 'summarization', claim.token, { error: null, retryAt: null })
    const straggler = (await pipeline.claimStep(m.id, 'summarization', { status: 'indexing', leaseMs: 1, chunkNo: 0 }))!
    await expire()
    const storage = createStorage({ driver: fsDriver({ base: join(dataDir, 'db') }) })
    // Aged past both the upload window and the old status lease, which still
    // guards an `indexing` meeting until extraction moves onto step leases.
    await storage.setItem(`meetings/${m.id}`, {
      ...(await repos().meetings.get(m.id))!,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:10:00.000Z',
    })

    expect(await deleteMeeting(m.id, deps())).toEqual({ kind: 'deleted' })
    expect(await pipeline.recordChunk(m.id, straggler.token, plan[0]!, result(2))).toBe(false)
    expect(await storage.hasItem(`pipeline/${m.id}`)).toBe(false)
  })

  // The blocker read and the fenced delete are two steps. A claim landing
  // between them is what the updatedAt bump exists to catch.
  it('refuses when a step is claimed between the delete\'s check and its write', async () => {
    const m = await oldMeeting('ready')
    const d = deps()
    const meetings = {
      ...d.meetings,
      delete: async (id: string, expected: Pick<Meeting, 'status' | 'updatedAt'>) => {
        await d.pipeline.claimStep(id, 'search_index', { status: 'ready', leaseMs: LEASE })
        return d.meetings.delete(id, expected)
      },
    }
    expect(await deleteMeeting(m.id, { ...d, meetings })).toMatchObject({ kind: 'blocked', reason: expect.stringMatching(/changed/) })
    expect(await repos().meetings.get(m.id)).not.toBeNull()
  })
})
