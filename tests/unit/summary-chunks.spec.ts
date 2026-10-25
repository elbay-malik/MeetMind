import { afterEach, describe, expect, it, vi } from 'vitest'
import { createGroqSummarizer, type RequestPacer } from '../../server/utils/summary/groq'
import { attestChunk, mergeReconciled, reconcile, type AttestedChunk } from '../../server/utils/summary/reconcile'
import { createStubSummarizer } from '../../server/utils/summary/stub'
import type { WireSummary } from '../../shared/schemas/summary'
import type { TranscriptSegment } from '../../shared/types/meeting'

const seg = (idx: number, startMs: number, text: string): TranscriptSegment =>
  ({ idx, startMs, endMs: startMs + 1000, text })

const first = [
  seg(0, 0, 'Welcome everyone, let us begin the review.'),
  seg(1, 5000, 'We agreed to ship the billing change on Friday.'),
]
const second = [
  seg(2, 10_000, 'Priya will draft the migration plan by next week.'),
  seg(3, 15_000, 'Any other business? No. Thanks all.'),
]

const decision = (quote: string, segmentIdx: number, text: string) => ({ quote, segmentIdx, decision: text })
const action = (quote: string, segmentIdx: number, task: string) =>
  ({ quote, segmentIdx, task, assignee: null, dueDateText: null })

describe('attestChunk', () => {
  // The one behaviour change of attesting per chunk (ADR-0006 addendum). The
  // model is shown only its chunk's lines, so a quote found only in another
  // chunk is one it did not read: a fabrication that happens to match.
  it('drops a quote that occurs only in another chunk, which whole-transcript reconcile kept', () => {
    const model: WireSummary = {
      summary: 'The first half.',
      decisions: [decision('Priya will draft the migration plan', 2, 'Priya drafts the plan')],
      actionItems: [action('Priya will draft the migration plan', 2, 'Draft the plan')],
    }

    expect(attestChunk(model, first)).toEqual({
      summary: 'The first half.',
      decisions: [],
      actionItems: [],
      droppedDecisions: 1,
      droppedActionItems: 1,
    })
    // The contrast that makes this a change, not an accident of the fixture.
    expect(reconcile(model, [...first, ...second]).decisions).toHaveLength(1)
  })

  // The second, smaller change: where a phrase is also some other chunk's
  // whole line, the whole-transcript check preferred that line -- a moment the
  // model never read. The citation now stays where the model read the words.
  it('cites the occurrence in its own chunk, not a whole-line match in another', () => {
    const a = [seg(0, 0, 'Let us ship the onboarding flow.')]
    const b = [seg(1, 5000, 'Fine, so we said let us ship the onboarding flow then.')]
    const model: WireSummary = {
      summary: '',
      decisions: [decision('let us ship the onboarding flow', 1, 'Ship onboarding')],
      actionItems: [],
    }
    expect(reconcile(model, [...a, ...b]).decisions[0]).toMatchObject({ segmentIdx: 0, startMs: 0 })
    expect(attestChunk(model, b).decisions[0]).toMatchObject({ segmentIdx: 1, startMs: 5000 })
  })

  it('keeps a quote from its own chunk, with the time of the line it begins on', () => {
    const chunk = attestChunk({
      summary: '  Padded.  ',
      decisions: [decision('ship the billing change', 1, '  Ship billing Friday  ')],
      actionItems: [{ ...action('ship the billing change', 1, 'Ship it'), assignee: '  ', dueDateText: ' Friday ' }],
    }, first)

    expect(chunk).toEqual({
      summary: 'Padded.',
      decisions: [{ decision: 'Ship billing Friday', quote: 'ship the billing change', segmentIdx: 1, startMs: 5000 }],
      actionItems: [{
        task: 'Ship it', assignee: null, dueDateText: 'Friday',
        quote: 'ship the billing change', segmentIdx: 1, startMs: 5000,
      }],
      droppedDecisions: 0,
      droppedActionItems: 0,
    })
  })

  it('is plain data that survives being stored between requests', () => {
    const chunk = attestChunk({
      summary: 's',
      decisions: [decision('ship the billing change', 1, 'Ship')],
      actionItems: [],
    }, first)
    expect(JSON.parse(JSON.stringify(chunk))).toEqual(chunk)
  })
})

describe('mergeReconciled', () => {
  const kept = (over: Partial<AttestedChunk>): AttestedChunk => ({
    summary: '', decisions: [], actionItems: [], droppedDecisions: 0, droppedActionItems: 0, ...over,
  })

  it('removes the same item restated at the same moment by two chunks, and counts it as dropped', () => {
    // Overlapping chunk boundaries are where restatements come from.
    const item = { decision: 'Ship billing Friday', quote: 'ship the billing change', segmentIdx: 1, startMs: 5000 }
    const merged = mergeReconciled([
      kept({ decisions: [item], droppedDecisions: 2 }),
      kept({ decisions: [{ ...item, decision: 'ship billing, Friday!' }], droppedDecisions: 1 }),
    ])
    expect(merged.decisions).toHaveLength(1)
    expect(merged.decisions[0]!.decision).toBe('Ship billing Friday')
    expect(merged.droppedDecisions).toBe(4)
  })

  it('orders every chunk\'s items by time and numbers them without gaps', () => {
    const at = (startMs: number, segmentIdx: number, task: string) =>
      ({ task, assignee: null, dueDateText: null, quote: 'q', segmentIdx, startMs })
    const merged = mergeReconciled([
      kept({ actionItems: [at(15_000, 3, 'late'), at(0, 0, 'early')] }),
      kept({ actionItems: [at(10_000, 2, 'middle')], droppedActionItems: 1 }),
    ])
    expect(merged.actionItems.map(a => [a.idx, a.task])).toEqual([[0, 'early'], [1, 'middle'], [2, 'late']])
    expect(merged.droppedActionItems).toBe(1)
  })

  it('joins the chunks\' summaries in order, skipping empty ones', () => {
    expect(mergeReconciled([kept({ summary: 'One.' }), kept({}), kept({ summary: 'Two.' })]).summary)
      .toBe('One. Two.')
  })

  it('keeps the first of an action item two chunks both report, with its own details', async () => {
    const item = (assignee: string) =>
      ({ task: 'Draft the plan', assignee, dueDateText: null, quote: 'q', segmentIdx: 2, startMs: 10_000 })
    const merged = mergeReconciled([
      kept({ actionItems: [item('Priya')] }),
      kept({ actionItems: [{ ...item('Sam'), task: 'draft the plan.' }] }),
    ])
    expect(merged.actionItems).toEqual([{ idx: 0, ...item('Priya') }])
    expect(merged.droppedActionItems).toBe(1)
  })

  it('keeps the same words said at two different moments as two items', () => {
    const at = (segmentIdx: number, startMs: number) =>
      ({ decision: 'Ship billing', quote: 'q', segmentIdx, startMs })
    const merged = mergeReconciled([kept({ decisions: [at(1, 5000)] }), kept({ decisions: [at(40, 200_000)] })])
    expect(merged.decisions.map(d => d.segmentIdx)).toEqual([1, 40])
    expect(merged.droppedDecisions).toBe(0)
  })

  it('composes into reconcile for a single reply', () => {
    const model: WireSummary = {
      summary: 'x',
      decisions: [decision('ship the billing change', 1, 'Ship'), decision('ship the billing change', 1, 'ship')],
      actionItems: [action('nobody said this at any point today', 0, 'Nothing')],
    }
    expect(reconcile(model, first)).toEqual({
      decisions: [{ idx: 0, decision: 'Ship', quote: 'ship the billing change', segmentIdx: 1, startMs: 5000 }],
      actionItems: [],
      droppedDecisions: 1,
      droppedActionItems: 1,
    })
  })
})

describe('summarizeChunk', () => {
  afterEach(() => vi.unstubAllGlobals())
  const unpaced: RequestPacer = { wait: async () => {}, rateLimited: async () => {} }

  const reply = (payload: WireSummary) => Response.json({ choices: [{ message: { content: JSON.stringify(payload) } }] })

  it('makes one request showing only the chunk, and returns it attested against the chunk', async () => {
    const bodies: string[] = []
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
      bodies.push(String(init.body))
      return reply({
        summary: 'First half.',
        decisions: [
          decision('ship the billing change', 1, 'Ship billing Friday'),
          decision('Priya will draft the migration plan', 2, 'From the other chunk'),
        ],
        actionItems: [],
      })
    })

    const chunk = await createGroqSummarizer({ apiKey: 'k', pacer: unpaced }).summarizeChunk({ segments: first })

    expect(bodies).toHaveLength(1)
    expect(bodies[0]).toContain('billing change')
    expect(bodies[0]).not.toContain('migration plan')
    expect(chunk.decisions.map(d => d.decision)).toEqual(['Ship billing Friday'])
    expect(chunk.droppedDecisions).toBe(1)
  })

  it('makes no request for an empty chunk', async () => {
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    expect(await createGroqSummarizer({ apiKey: 'k', pacer: unpaced }).summarizeChunk({ segments: [] }))
      .toMatchObject({ summary: '', decisions: [], actionItems: [] })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('drops a quote from another chunk across a whole multi-chunk summary', async () => {
    // Each line alone is over the chunk budget, so each is its own chunk.
    const filler = Array.from({ length: 4000 }, () => 'word').join(' ')
    const segments = [
      seg(0, 0, `${filler} We agreed to ship the billing change on Friday.`),
      seg(1, 5000, `${filler} Priya will draft the migration plan by next week.`),
    ]
    const replies = [
      reply({
        summary: 'One.',
        decisions: [decision('Priya will draft the migration plan', 1, 'Read in the other chunk')],
        actionItems: [],
      }),
      reply({
        summary: 'Two.',
        decisions: [decision('Priya will draft the migration plan', 1, 'Priya drafts the plan')],
        actionItems: [],
      }),
    ]
    vi.stubGlobal('fetch', async () => replies.shift() ?? new Response(null, { status: 500 }))

    const summary = await createGroqSummarizer({ apiKey: 'k', pacer: unpaced }).summarize({ segments })

    expect(replies).toHaveLength(0)
    expect(summary.summary).toBe('One. Two.')
    expect(summary.decisions.map(d => d.decision)).toEqual(['Priya drafts the plan'])
  })

  it('is the stub\'s unit too, checked the same way', async () => {
    const stub = createStubSummarizer()
    const chunk = await stub.summarizeChunk({ segments: second })
    expect(chunk.decisions.length).toBeGreaterThan(0)
    expect(chunk.decisions.every(d => second.some(s => s.idx === d.segmentIdx))).toBe(true)
    expect((await stub.summarize({ segments: second })).decisions.map(({ idx: _, ...d }) => d)).toEqual(chunk.decisions)
  })
})
