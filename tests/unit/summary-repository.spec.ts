import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { createLocalSummaryRepository } from '../../server/utils/db/summaries-local'
import { createSupabaseSummaryRepository } from '../../server/utils/db/summaries-supabase'
import {
  actionItemToRow,
  decisionToRow,
  rowToActionItem,
  rowToDecision,
  type ActionItemRow,
  type DecisionRow,
} from '../../server/utils/db/summaries'
import type { ActionItem, Decision, MeetingSummary } from '../../shared/types/meeting'

const decision: Decision = { idx: 0, decision: 'ship it', quote: 'we agreed to ship', segmentIdx: 2, startMs: 4000 }
const actionItem: ActionItem = {
  idx: 0, task: 'send the deck', assignee: 'Sam', dueDateText: 'next Friday',
  quote: 'Sam will send the deck', segmentIdx: 3, startMs: 6000,
}

const summary: MeetingSummary = {
  summary: 'Shipped the feature.', provider: 'stub', decisions: [decision], actionItems: [actionItem],
}

describe('row mapping', () => {
  it('maps a decision row to the domain shape and back', () => {
    const row: DecisionRow = {
      meeting_id: 'm1', idx: 0, decision: 'ship it', quote: 'we agreed to ship',
      segment_idx: 2, start_ms: 4000, created_at: '2026-09-06T12:00:00Z',
    }
    expect(rowToDecision(row)).toEqual(decision)
    const mapped = decisionToRow('m1', decision)
    expect(mapped).toEqual({
      meeting_id: 'm1', idx: 0, decision: 'ship it', quote: 'we agreed to ship', segment_idx: 2, start_ms: 4000,
    })
    expect(mapped).not.toHaveProperty('created_at')
  })

  it('maps an action item row to the domain shape and back, including a null assignee/due date', () => {
    const row: ActionItemRow = {
      meeting_id: 'm1', idx: 0, task: 'send the deck', assignee: null, due_date_text: null,
      quote: 'Sam will send the deck', segment_idx: 3, start_ms: 6000, created_at: '2026-09-06T12:00:00Z',
    }
    expect(rowToActionItem(row)).toEqual({ ...actionItem, assignee: null, dueDateText: null })
    const mapped = actionItemToRow('m1', actionItem)
    expect(mapped).toEqual({
      meeting_id: 'm1', idx: 0, task: 'send the deck', assignee: 'Sam', due_date_text: 'next Friday',
      quote: 'Sam will send the deck', segment_idx: 3, start_ms: 6000,
    })
    expect(mapped).not.toHaveProperty('created_at')
  })

  it('round-trips an action item through both directions', () => {
    expect(rowToActionItem({ ...actionItemToRow('m1', actionItem), created_at: 'x' })).toEqual(actionItem)
  })
})

describe('local summary repository', () => {
  let dataDir: string
  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'meetmind-summaries-'))
  })
  afterAll(() => rm(dataDir, { recursive: true, force: true }))

  it('returns null before anything is stored', async () => {
    const repo = createLocalSummaryRepository({ dataDir })
    expect(await repo.getForMeeting('unknown')).toBeNull()
  })

  it('stores and reads back a summary', async () => {
    const repo = createLocalSummaryRepository({ dataDir })
    await repo.replaceForMeeting('m1', summary)
    expect(await repo.getForMeeting('m1')).toEqual(summary)
  })

  it('replaces rather than appends, so re-running extraction is idempotent', async () => {
    const repo = createLocalSummaryRepository({ dataDir })
    await repo.replaceForMeeting('m2', summary)
    const second: MeetingSummary = { summary: 'Only one thing happened.', provider: 'stub', decisions: [], actionItems: [] }
    await repo.replaceForMeeting('m2', second)
    expect(await repo.getForMeeting('m2')).toEqual(second)
  })

  it('keeps meetings separate', async () => {
    const repo = createLocalSummaryRepository({ dataDir })
    await repo.replaceForMeeting('m3', summary)
    expect(await repo.getForMeeting('m4')).toBeNull()
  })
})

describe('supabase summary repository', () => {
  const repo = createSupabaseSummaryRepository({ url: 'https://p.supabase.co', serviceKey: 'k' })

  interface Call { method: string, table: string, url: URL, body: unknown }

  /** Capture every request, replying per-table so replaceForMeeting's several
   * calls to different tables can each get a sensible response. */
  function stub(perTable: Record<string, unknown>) {
    const calls: Call[] = []
    vi.stubGlobal('fetch', async (input: string | Request, init?: RequestInit) => {
      const request = typeof input === 'string' ? new Request(input, init) : input
      const url = new URL(request.url)
      const table = url.pathname.replace('/rest/v1/', '')
      const raw = await request.clone().text()
      calls.push({ method: request.method, table, url, body: raw ? JSON.parse(raw) : undefined })
      const payload = perTable[table] ?? []
      return new Response(JSON.stringify(payload), { headers: { 'content-type': 'application/json' } })
    })
    return calls
  }

  afterEach(() => vi.unstubAllGlobals())

  it('deletes both item tables, upserts the summary, then inserts the new items', async () => {
    const calls = stub({ meeting_summaries: [{}], meeting_decisions: [], meeting_action_items: [] })
    await repo.replaceForMeeting('m1', summary)

    const byTable = (t: string) => calls.filter(c => c.table === t)
    expect(byTable('meeting_decisions').map(c => c.method)).toEqual(['DELETE', 'POST'])
    expect(byTable('meeting_action_items').map(c => c.method)).toEqual(['DELETE', 'POST'])
    expect(byTable('meeting_summaries').map(c => c.method)).toEqual(['POST'])

    const decisionInsert = byTable('meeting_decisions').find(c => c.method === 'POST')!
    expect(decisionInsert.body).toEqual([decisionToRow('m1', decision)])
    const itemInsert = byTable('meeting_action_items').find(c => c.method === 'POST')!
    expect(itemInsert.body).toEqual([actionItemToRow('m1', actionItem)])
  })

  it('skips the insert call entirely for an empty list rather than sending one with no rows', async () => {
    const calls = stub({ meeting_summaries: [{}], meeting_decisions: [], meeting_action_items: [] })
    const empty: MeetingSummary = { summary: 'Nothing decided.', provider: 'stub', decisions: [], actionItems: [] }
    await repo.replaceForMeeting('m1', empty)

    expect(calls.filter(c => c.table === 'meeting_decisions')).toHaveLength(1) // delete only
    expect(calls.filter(c => c.table === 'meeting_action_items')).toHaveLength(1) // delete only
  })

  it('surfaces a database error from any of the writes', async () => {
    vi.stubGlobal('fetch', async () => new Response(
      JSON.stringify({ code: '23503', message: 'violates foreign key constraint', details: '', hint: '' }),
      { status: 409, headers: { 'content-type': 'application/json' } },
    ))
    await expect(repo.replaceForMeeting('m1', summary)).rejects.toThrow(/23503/)
  })

  it('returns null when no summary row exists', async () => {
    stub({ meeting_summaries: [] })
    expect(await repo.getForMeeting('m1')).toBeNull()
  })

  it('maps a stored summary with its decisions and action items', async () => {
    stub({
      meeting_summaries: [{ meeting_id: 'm1', summary: 'Shipped it.', provider: 'groq' }],
      meeting_decisions: [{ ...decisionToRow('m1', decision), created_at: 'x' }],
      meeting_action_items: [{ ...actionItemToRow('m1', actionItem), created_at: 'x' }],
    })
    const result = await repo.getForMeeting('m1')
    expect(result).toEqual({
      summary: 'Shipped it.', provider: 'groq', decisions: [decision], actionItems: [actionItem],
    })
  })

  it('pages past the server-side row cap for both decisions and action items', async () => {
    // PostgREST caps result sets server-side and says nothing — an unpaged
    // read would silently truncate a meeting with many items.
    const cap = 1000
    const total = 1500
    const calls: URL[] = []
    vi.stubGlobal('fetch', async (input: string | Request, init?: RequestInit) => {
      const request = typeof input === 'string' ? new Request(input, init) : input
      const url = new URL(request.url)
      const table = url.pathname.replace('/rest/v1/', '')
      if (table === 'meeting_summaries') {
        return new Response(
          JSON.stringify({ meeting_id: 'm1', summary: 's', provider: 'stub' }),
          { headers: { 'content-type': 'application/json' } },
        )
      }
      calls.push(url)
      const offset = Number(url.searchParams.get('offset') ?? 0)
      const limit = Math.min(cap, Number(url.searchParams.get('limit') ?? cap))
      const count = Math.max(0, Math.min(limit, total - offset))
      const rowFor = table === 'meeting_decisions'
        ? (i: number) => decisionToRow('m1', { ...decision, idx: i })
        : (i: number) => actionItemToRow('m1', { ...actionItem, idx: i })
      const rows = Array.from({ length: count }, (_, i) => ({ ...rowFor(offset + i), created_at: 'x' }))
      return new Response(JSON.stringify(rows), { headers: { 'content-type': 'application/json' } })
    })

    const result = await repo.getForMeeting('m1')
    expect(result!.decisions).toHaveLength(total)
    expect(result!.actionItems).toHaveLength(total)
    expect(result!.decisions.map(d => d.idx)).toEqual(Array.from({ length: total }, (_, i) => i))
    // Both tables paged: more than one request each.
    expect(calls.filter(u => u.pathname.includes('meeting_decisions')).length).toBeGreaterThan(1)
    expect(calls.filter(u => u.pathname.includes('meeting_action_items')).length).toBeGreaterThan(1)
  })
})
