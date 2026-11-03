import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { whisperReplyKey } from '../../shared/utils/meeting'
import type { PipelineDeps } from '../../server/utils/pipeline/advance'
import { deleteMeeting } from '../../server/utils/meeting-deletion'
import { reportTick, sweepOnce } from '../../server/utils/pipeline/sweep'
import { planWindows } from '../../server/utils/qa/windows'
import { hashedTokenVector } from '../../server/utils/qa/stub'
import { longLine, pipelineHarness, scriptedProviders, segmentsOf, tallied } from './helpers/pipeline'

/**
 * The retention purge (ADR-0017): what it deletes, and above all what it does not. Irreversible
 * and with nobody watching, so most of this is about leaving things alone. Which meeting the
 * database names is tests/unit/sweep-selection.spec.ts, on both drivers. Off is the default.
 */

let dataDir: string
beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'meetmind-purge-'))
})
afterAll(async () => {
  await rm(dataDir, { recursive: true, force: true })
})

const harness = pipelineHarness(() => dataDir)
const { repos, db, depsWith, store, stored } = harness

const NOW = Date.parse('2026-11-03T12:00:00.000Z')
const DAY = 86_400_000
const DEMO = '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d'
const DAYS = 30

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
  const all = db()
  for (const key of await all.getKeys()) await all.removeItem(key)
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

const lines = (count: number) => Array.from({ length: count }, (_, i) => longLine(i))
const purge = (deps: PipelineDeps, days: number | null = DAYS, demoMeetingId: unknown = DEMO) => sweepOnce(deps, { demoMeetingId, purgeDays: days })
const nothingToDo = () => depsWith(scriptedProviders([]))

/** A meeting with something in every store there is, created that many days ago, otherwise finished. */
async function theDemo() {
  await harness.meetingWith(DEMO, [], 'ready')
}

async function fullMeeting(daysOld: number, id: string = randomUUID()): Promise<string> {
  const segments = segmentsOf(lines(2))
  const meeting = await harness.meetingWith(id, segments, 'ready')
  await store().put(meeting.audioKey, new Uint8Array(500).fill(7), 'audio/ogg')
  await store().put(whisperReplyKey(id), new Uint8Array(20).fill(1), 'application/json')
  const { index, pipeline } = repos()
  const windows = await planWindows(segments)
  await index.upsertWindows(id, windows.map(w => ({ ...w, model: 'model-a', embedding: hashedTokenVector(w.text) })))
  const claim = (await pipeline.claimStep(id, 'search_index', { status: 'ready', leaseMs: 1_000 }))!
  await pipeline.upsertWindows(id, claim.token, { windows: [], cursor: {}, textHash: (await index.readState(id, 'model-a')).transcriptHash, model: 'model-a' })
  const finish = (await pipeline.claimStep(id, 'search_index', { status: 'ready', leaseMs: 1_000 }))!
  await pipeline.finishIndex(id, finish.token, { textHash: (await index.readState(id, 'model-a')).transcriptHash, model: 'model-a', windowCount: windows.length })
  await depsWith(scriptedProviders([])).summaries.replaceForMeeting(id, { summary: 'They agreed.', decisions: [], actionItems: [], provider: 'stub' })
  const row = await db().getItem<Record<string, unknown>>(`meetings/${id}`)
  const at = new Date(NOW - daysOld * DAY).toISOString()
  await db().setItem(`meetings/${id}`, { ...row, createdAt: at, updatedAt: at })
  return id
}

async function everythingOf(id: string) {
  const all = await stored(id) as Record<string, unknown>
  const objects = [`meetings/${id}/audio.ogg`, whisperReplyKey(id)]
  return { ...all, slots: null, objects: await Promise.all(objects.map(key => store().head(key))) }
}

const WIPED = { meeting: null, pipeline: null, summary: null, transcript: null, windows: null, slots: null, objects: [null, null] }

describe('with the setting off, which is the default', () => {
  it.each<[string, number | null | undefined]>([
    ['null', null],
    ['left out', undefined],
    ['0', 0],
  ])('deletes nothing at all, however old, for %s', async (_name, purgeDays) => {
    const id = await fullMeeting(4000)
    const before = await everythingOf(id)
    const deps = nothingToDo()
    const nextExpired = vi.fn(deps.pipeline.nextExpired)
    const outcome = await sweepOnce({ ...deps, pipeline: { ...deps.pipeline, nextExpired } }, { demoMeetingId: DEMO, purgeDays })
    expect(outcome).toEqual({ kind: 'idle' })
    expect(nextExpired).not.toHaveBeenCalled()
    expect(await everythingOf(id)).toEqual(before)
  })
})

describe('with it on', () => {
  beforeEach(async () => {
    const all = db()
    if (!await all.getItem(`meetings/${DEMO}`)) await theDemo()
  })

  it('deletes everything stored for an expired meeting: the rows and both objects', async () => {
    const id = await fullMeeting(31)
    // What this helper builds really is in every store, or the rest of this proves nothing.
    expect(await everythingOf(id)).toMatchObject({ meeting: expect.anything(), pipeline: expect.anything(), summary: expect.anything(), transcript: expect.anything(), windows: expect.anything() })
    expect((await everythingOf(id)).objects.every(Boolean)).toBe(true)

    expect(await purge(nothingToDo())).toEqual({ kind: 'purged' })
    expect(await everythingOf(id)).toEqual(WIPED)
  })

  it('deletes one a tick, the oldest, and leaves every other meeting exactly as it was', async () => {
    const [oldest, older, inside] = [await fullMeeting(90), await fullMeeting(40), await fullMeeting(10)]
    const beforeOlder = await everythingOf(older)
    const beforeInside = await everythingOf(inside)

    expect(await purge(nothingToDo())).toEqual({ kind: 'purged' })
    expect((await everythingOf(oldest)).meeting).toBeNull()
    expect(await everythingOf(older)).toEqual(beforeOlder)
    expect(await everythingOf(inside)).toEqual(beforeInside)

    expect(await purge(nothingToDo())).toEqual({ kind: 'purged' })
    expect((await everythingOf(older)).meeting).toBeNull()
    expect(await everythingOf(inside)).toEqual(beforeInside)

    // Nothing else has expired, however many more ticks there are.
    for (let i = 0; i < 5; i++) expect(await purge(nothingToDo())).toEqual({ kind: 'idle' })
    expect(await everythingOf(inside)).toEqual(beforeInside)
  })

  it('leaves a meeting at the days it was told, and takes it just after', async () => {
    const id = await fullMeeting(DAYS)
    expect(await purge(nothingToDo())).toEqual({ kind: 'idle' })
    expect((await everythingOf(id)).meeting).not.toBeNull()
    vi.setSystemTime(NOW + 1)
    expect(await purge(nothingToDo())).toEqual({ kind: 'purged' })
  })

  it('never touches the public demo, however old, written any way', async () => {
    await db().removeItem(`meetings/${DEMO}`)
    await fullMeeting(4000, DEMO)
    const before = await everythingOf(DEMO)
    for (const written of [DEMO, DEMO.toUpperCase(), ` ${DEMO}\n`]) {
      expect(await purge(nothingToDo(), DAYS, written)).toEqual({ kind: 'idle' })
    }
    expect(await everythingOf(DEMO)).toEqual(before)
  })

  it('does not delete the demo when the database names it anyway', async () => {
    await db().removeItem(`meetings/${DEMO}`)
    await fullMeeting(4000, DEMO)
    const before = await everythingOf(DEMO)
    const deps = nothingToDo()
    const mistaken = { ...deps, pipeline: { ...deps.pipeline, nextExpired: async () => DEMO.toUpperCase() } }
    expect(await purge(mistaken)).toEqual({ kind: 'purge-left' })
    expect(await everythingOf(DEMO)).toEqual(before)
  })

  it.each<[string, unknown]>([
    ['empty', ''],
    ['not an id', 'not-a-uuid'],
    ['missing', undefined],
  ])('deletes nothing when the demo setting is %s, as it could not be told from any other', async (_name, demo) => {
    const id = await fullMeeting(4000)
    const before = await everythingOf(id)
    expect(await sweepOnce(nothingToDo(), { demoMeetingId: demo, purgeDays: DAYS })).toEqual({ kind: 'idle' })
    expect(await everythingOf(id)).toEqual(before)
  })

  it('deletes nothing when the demo\'s id names no meeting, which a mistyped one would not, and is said to be wrong', async () => {
    const id = await fullMeeting(4000)
    const before = await everythingOf(id)
    const mistyped = '9b1deb4d-3b7d-4bad-9bdd-000000000000'
    expect(await purge(nothingToDo(), DAYS, mistyped)).toEqual({ kind: 'purge-no-demo' })
    expect(await everythingOf(id)).toEqual(before)
  })

  it('does not delete a meeting the database wrongly says has expired', async () => {
    const id = await fullMeeting(10)
    const before = await everythingOf(id)
    const deps = nothingToDo()
    const mistaken = { ...deps, pipeline: { ...deps.pipeline, nextExpired: async () => id } }
    expect(await purge(mistaken)).toEqual({ kind: 'purge-left' })
    expect(await everythingOf(id)).toEqual(before)
  })

  it('goes by when the row says it was created, and not by when it was last touched, uploaded or anything sent', async () => {
    const old = await fullMeeting(31)
    const row = await db().getItem<Record<string, unknown>>(`meetings/${old}`)
    await db().setItem(`meetings/${old}`, { ...row, updatedAt: new Date(NOW).toISOString(), uploadedAt: new Date(NOW).toISOString() })
    const young = await fullMeeting(5)
    const youngRow = await db().getItem<Record<string, unknown>>(`meetings/${young}`)
    await db().setItem(`meetings/${young}`, { ...youngRow, updatedAt: new Date(NOW - 400 * DAY).toISOString(), uploadedAt: new Date(NOW - 400 * DAY).toISOString() })

    expect(await purge(nothingToDo())).toEqual({ kind: 'purged' })
    expect((await everythingOf(old)).meeting).toBeNull()
    expect((await everythingOf(young)).meeting).not.toBeNull()
  })

  it('does not delete a meeting a step lease is live on, however it comes to be chosen', async () => {
    const id = await fullMeeting(31)
    const { pipeline } = repos()
    const row = (await repos().meetings.get(id))!
    const claim = await pipeline.claimStep(id, 'summarization', { status: row.status, leaseMs: 60_000 })
    expect(claim).not.toBeNull()
    const before = await everythingOf(id)

    // Chosen by the selection: not chosen, since the lease is live.
    expect(await purge(nothingToDo())).toEqual({ kind: 'idle' })
    expect(await everythingOf(id)).toEqual(before)

    // Named anyway, as a lease taken just after the selection would be: the blocker stops it.
    const deps = nothingToDo()
    const late = { ...deps, pipeline: { ...deps.pipeline, nextExpired: async () => id } }
    expect(await purge(late)).toEqual({ kind: 'purge-left' })
    expect(await everythingOf(id)).toEqual(before)

    vi.setSystemTime(NOW + 60_001)
    expect(await purge(nothingToDo())).toEqual({ kind: 'purged' })
  })

  it('leaves the row of a meeting that moved between the blocker\'s read and the delete, by the fence, and finishes later', async () => {
    const id = await fullMeeting(31)
    const deps = nothingToDo()
    const claimedMeanwhile = {
      ...deps,
      pipeline: {
        ...deps.pipeline,
        listRuns: async (meetingId: string) => {
          const runs = await deps.pipeline.listRuns(meetingId)
          const row = (await repos().meetings.get(id))!
          await deps.pipeline.claimStep(id, 'summarization', { status: row.status, leaseMs: 60_000 })
          return runs
        },
      },
    }
    expect(await purge(claimedMeanwhile)).toEqual({ kind: 'purge-left' })
    // Past its days and about to go, so its objects going a tick early is the price of a retry.
    const left = await everythingOf(id)
    expect(left.meeting).not.toBeNull()
    expect(left.objects).toEqual([null, null])

    expect(await purge(nothingToDo())).toEqual({ kind: 'idle' })
    vi.setSystemTime(NOW + 60_001)
    expect(await purge(nothingToDo())).toEqual({ kind: 'purged' })
    expect(await everythingOf(id)).toEqual(WIPED)
  })

  it('answers nothing of a meeting gone by the time it is read, and removes nothing else', async () => {
    const other = await fullMeeting(31)
    const before = await everythingOf(other)
    const deps = nothingToDo()
    const gone = { ...deps, pipeline: { ...deps.pipeline, nextExpired: async () => randomUUID() } }
    expect(await purge(gone)).toEqual({ kind: 'purge-left' })
    expect(await everythingOf(other)).toEqual(before)
  })

  it('takes a step first, when there is one, and does nothing else in that tick', async () => {
    const expired = await fullMeeting(31)
    const providers = scriptedProviders(lines(2))
    const id = randomUUID()
    const meeting = await harness.meetingWith(id, [], 'uploaded')
    await store().put(meeting.audioKey, new Uint8Array(500).fill(7), 'audio/ogg')
    const before = await everythingOf(expired)
    expect(await purge(depsWith(providers))).toMatchObject({ kind: 'step', step: 'transcription' })
    expect(await everythingOf(expired)).toEqual(before)
  })

  it('asks no provider, claims nothing, and spends a known number of requests', async () => {
    await fullMeeting(31)
    const providers = scriptedProviders([])
    const counted = tallied(depsWith(providers))
    expect(await purge(counted.deps)).toEqual({ kind: 'purged' })
    const spent = counted.take()
    expect(spent.claims).toBe(0)
    expect(spent.providerCalls).toBe(0)
    expect(spent.subrequests).toBe(17)
    expect(providers.calls).toEqual([])
  })

  it('spends 22 requests at most, with a meeting chosen first that turned out to have no step', async () => {
    await fullMeeting(31)
    // Parked twice over, so a whole read of it finds nothing to take, though it was chosen.
    const looked = randomUUID()
    await harness.meetingWith(looked, [], 'indexing')
    const run = (retryAt: number) => ({ runId: 'r', cursor: {}, stepToken: null, stepLeaseUntil: null, attempts: 0, lastError: null, retryAt })
    await db().setItem(`pipeline/${looked}`, { runs: { summarization: run(NOW + 60_000), search_index: run(NOW + 60_000) }, chunks: [] })
    const deps = nothingToDo()
    const counted = tallied({ ...deps, pipeline: { ...deps.pipeline, nextForSweep: async () => ({ meetingId: looked, busy: [] }) } })
    expect(await purge(counted.deps)).toEqual({ kind: 'purged' })
    expect(counted.take().subrequests).toBe(22)
  })

  describe('when a part of it fails, as nothing else could choose the meeting again with its row gone', () => {
    const withFailingDelete = (failsOn: (key: string) => boolean): PipelineDeps => {
      const deps = nothingToDo()
      return {
        ...deps,
        store: {
          ...deps.store,
          delete: async (key: string) => {
            if (failsOn(key)) throw new Error(`R2 DELETE ${key} failed`)
            await deps.store.delete(key)
          },
        },
      }
    }

    it('keeps the row when the audio cannot be removed, says so in one line with no id, and finishes on the next tick', async () => {
      const id = await fullMeeting(31)
      const before = await everythingOf(id)
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      await reportTick(() => purge(withFailingDelete(() => true)))
      expect(warn.mock.calls).toEqual([['[meetmind] sweep failed: Error']])
      expect(await everythingOf(id)).toEqual(before)

      expect(await purge(nothingToDo())).toEqual({ kind: 'purged' })
      expect(await everythingOf(id)).toEqual(WIPED)
    })

    it('keeps the row when only the Whisper reply cannot be removed, and finishes on the next tick', async () => {
      const id = await fullMeeting(31)
      await expect(purge(withFailingDelete(key => key === whisperReplyKey(id)))).rejects.toThrow('failed')
      expect((await everythingOf(id)).meeting).not.toBeNull()
      expect((await everythingOf(id)).objects).toEqual([null, expect.anything()])

      expect(await purge(nothingToDo())).toEqual({ kind: 'purged' })
      expect(await everythingOf(id)).toEqual(WIPED)
    })

    it('finishes after an invocation killed between the objects and the row', async () => {
      const id = await fullMeeting(31)
      const deps = nothingToDo()
      const killed = { ...deps, meetings: { ...deps.meetings, delete: async () => {
        throw new Error('killed')
      } } }
      await expect(purge(killed)).rejects.toThrow('killed')
      expect((await everythingOf(id)).meeting).not.toBeNull()
      expect((await everythingOf(id)).objects).toEqual([null, null])

      expect(await purge(nothingToDo())).toEqual({ kind: 'purged' })
      expect(await everythingOf(id)).toEqual(WIPED)
    })

    it('touches no object while a step is live, so a blocked delete costs the meeting nothing', async () => {
      const id = await fullMeeting(31)
      const row = (await repos().meetings.get(id))!
      await repos().pipeline.claimStep(id, 'summarization', { status: row.status, leaseMs: 60_000 })
      const before = await everythingOf(id)
      const deps = nothingToDo()
      const named = { ...deps, pipeline: { ...deps.pipeline, nextExpired: async () => id } }
      expect(await purge(named)).toEqual({ kind: 'purge-left' })
      expect(await everythingOf(id)).toEqual(before)
    })

    it('keeps the admin route\'s order: the row first, fenced, with nothing removed for a meeting in use', async () => {
      const id = await fullMeeting(31)
      const order: string[] = []
      const deps = nothingToDo()
      await deleteMeeting(id, {
        meetings: { ...deps.meetings, delete: async (...args) => {
          order.push('row')
          return deps.meetings.delete(...args)
        } },
        pipeline: deps.pipeline,
        removeData: async () => {
          order.push('data')
        },
      })
      expect(order).toEqual(['row', 'data'])
    })
  })

  it('says one line for a meeting deleted, with no id in it, and nothing for one left', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})
    await reportTick(async () => ({ kind: 'purged' }))
    await reportTick(async () => ({ kind: 'purge-left' }))
    expect(info.mock.calls).toEqual([['[meetmind] sweep: deleted one meeting past its retention days']])
  })
})

describe('a setting that does nothing', () => {
  it('says so of a demo that names no meeting, in the tick\'s one line and then not again', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.resetModules()
    const fresh = await import('../../server/utils/pipeline/sweep')
    await fresh.reportTick(async () => ({ kind: 'purge-no-demo' }))
    await fresh.reportTick(async () => ({ kind: 'purge-no-demo' }))
    expect(warn.mock.calls).toEqual([[expect.stringContaining('NUXT_PUBLIC_DEMO_MEETING_ID names no meeting')]])
  })

  it('is said in a tick with no line of its own, and not in a tick with one', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})
    const notice = vi.fn(() => 'the setting is wrong')
    await reportTick(async () => ({ kind: 'step', step: 'indexing', outcome: 'progress' }), notice)
    expect(notice).not.toHaveBeenCalled()
    expect(info).toHaveBeenCalledTimes(1)
    await reportTick(async () => ({ kind: 'idle' }), notice)
    expect(warn.mock.calls).toEqual([['the setting is wrong']])
  })
})
