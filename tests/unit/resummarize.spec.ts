import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { MeetingSummary } from '../../shared/types/meeting'
import type { PipelineDeps } from '../../server/utils/pipeline/advance'
import { advanceExtraction, MAX_CHUNKS, RESTART_REFUSALS, restartExtraction, tooManyChunksMessage } from '../../server/utils/summary/steps'
import { longLine, pipelineHarness, scriptedProviders, segmentsOf } from './helpers/pipeline'

/**
 * Making a finished meeting's summary again (ADR-0011's resummarize addendum), against the local
 * drivers: which meetings it moves, that it moves them in one fenced claim, and that what it
 * starts is an ordinary extraction which replaces the summary only at the end.
 * The route's own checks are tests/unit/resummarize-route.spec.ts.
 */

let dataDir: string
beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'meetmind-resummarize-'))
})
afterAll(() => rm(dataDir, { recursive: true, force: true }))

const harness = pipelineHarness(() => dataDir)
const { repos, depsWith, uploadedMeeting, transcribedMeeting, advance, stored } = harness

const LINES = [longLine(0), longLine(1), longLine(2)]
const OLD: MeetingSummary = { summary: 'An earlier summary.', decisions: [], actionItems: [], provider: 'groq' }

const restart = (id: string, deps: PipelineDeps) => restartExtraction(id, { ...deps, model: deps.embedder.model })

/** A meeting the page has driven to the end, with `OLD` in place of its summary. */
async function finishedMeeting() {
  const providers = scriptedProviders(LINES)
  const deps = depsWith(providers)
  const id = await uploadedMeeting()
  for (let i = 0; i < 100; i++) {
    const answer = await advance(id, deps)
    if (answer.next === 'done') break
    if (answer.next === 'failed') throw new Error('the fixture failed')
  }
  await deps.summaries.replaceForMeeting(id, OLD)
  return { id, deps, providers }
}

describe('restartExtraction', () => {
  it('moves a ready meeting back to extraction with a new plan, and the old summary stays until the new one replaces it', async () => {
    const { id, deps, providers } = await finishedMeeting()
    const before = await repos().meetings.get(id)
    const { transcript, windows } = await stored(id) as { transcript: unknown, windows: unknown }
    const chunksAsked = providers.count('chunk')

    const outcome = await restart(id, deps)
    expect(outcome).toMatchObject({ kind: 'progress', meeting: { status: 'indexing' }, progress: { done: 0, total: 3 }, next: 'continue' })
    // Planning asks no provider.
    expect(providers.count('chunk')).toBe(chunksAsked)
    expect(await deps.summaries.getForMeeting(id)).toEqual(OLD)

    let last
    for (let i = 0; i < 10; i++) {
      last = await advanceExtraction(id, deps)
      if (last.kind !== 'progress') break
    }
    expect(last).toMatchObject({ kind: 'done', meeting: { status: 'ready' } })
    expect(providers.count('chunk')).toBe(chunksAsked + 3)
    const after = await repos().meetings.get(id)
    expect(Date.parse(after!.updatedAt)).toBeGreaterThan(Date.parse(before!.updatedAt))
    const summary = await deps.summaries.getForMeeting(id)
    expect(summary).toMatchObject({ provider: 'stub' })
    expect(summary!.summary).not.toBe(OLD.summary)
    // Neither the transcript nor the index was touched, so the index is still complete.
    expect(await stored(id)).toMatchObject({ transcript, windows })
    expect((await advance(id, deps))).toMatchObject({ status: 'ready', next: 'done', index: { state: 'complete' } })
  })

  it('starts over a meeting whose extraction failed, with its index complete', async () => {
    const { id, deps } = await finishedMeeting()
    const meeting = (await repos().meetings.update(id, { status: 'failed', failedStage: 'summarization', errorMessage: 'it broke' }))!
    const outcome = await restart(id, deps)
    expect(outcome).toMatchObject({ kind: 'progress', meeting: { status: 'indexing', errorMessage: null, failedStage: null } })
    expect(meeting.status).toBe('failed')
  })

  it('refuses a meeting that is not finished, and moves nothing', async () => {
    const providers = scriptedProviders(LINES)
    const deps = depsWith(providers)
    for (const [status, patch] of [
      ['uploaded', {}],
      ['transcribing', {}],
      ['summarizing', {}],
      ['indexing', {}],
      ['failed', { failedStage: 'transcription', errorMessage: 'it broke' }],
      ['failed', { failedStage: 'upload', errorMessage: 'rejected' }],
    ] as const) {
      const id = await transcribedMeeting(segmentsOf(LINES), status, patch)
      const before = await stored(id)
      expect(await restart(id, deps)).toEqual({ kind: 'refused', statusCode: 409, message: RESTART_REFUSALS.notFinished(status) })
      expect(await stored(id)).toEqual(before)
    }
    expect(providers.calls).toEqual([])
  })

  it('refuses a finished meeting whose index is not complete for the current model', async () => {
    const { id, deps } = await finishedMeeting()
    const before = await stored(id)
    const otherModel = depsWith(scriptedProviders(LINES, { model: 'model-b' }))
    expect(await restart(id, otherModel)).toEqual({ kind: 'refused', statusCode: 409, message: RESTART_REFUSALS.noIndex })

    const unindexed = await transcribedMeeting(segmentsOf(LINES), 'ready')
    expect(await restart(unindexed, deps)).toEqual({ kind: 'refused', statusCode: 409, message: RESTART_REFUSALS.noIndex })
    expect(await stored(id)).toEqual(before)
  })

  it('refuses a transcript that was refused as too long, which planning would refuse again', async () => {
    const id = await transcribedMeeting(segmentsOf(LINES), 'failed', { failedStage: 'summarization', errorMessage: tooManyChunksMessage(MAX_CHUNKS + 1) })
    expect(await restart(id, depsWith(scriptedProviders(LINES)))).toEqual({ kind: 'refused', statusCode: 409, message: RESTART_REFUSALS.tooLong })
  })

  it('refuses when the row moved after it was read, and does not take the claim', async () => {
    const { id, deps } = await finishedMeeting()
    // A step of the stage lands between the read and the claim: the row is no longer the one checked.
    const moved: PipelineDeps = {
      ...deps,
      meetings: {
        ...deps.meetings,
        get: async (meetingId) => {
          const read = await deps.meetings.get(meetingId)
          await deps.meetings.update(meetingId, { title: 'renamed' })
          return read
        },
      },
    }
    expect(await restart(id, moved)).toEqual({ kind: 'refused', statusCode: 409, message: RESTART_REFUSALS.moved })
    expect(await repos().meetings.get(id)).toMatchObject({ status: 'ready', title: 'renamed' })
    expect(await deps.summaries.getForMeeting(id)).toEqual(OLD)
  })

  it('answers 404 for a meeting that does not exist', async () => {
    const deps = depsWith(scriptedProviders(LINES))
    expect(await restart('00000000-0000-4000-8000-000000000000', deps)).toEqual({ kind: 'refused', statusCode: 404, message: 'Meeting not found' })
  })
})
