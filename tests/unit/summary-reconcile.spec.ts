import { describe, expect, it } from 'vitest'
import { attestQuote, reconcile } from '../../server/utils/summary/reconcile'
import type { TranscriptSegment } from '../../shared/types/meeting'
import type { WireSummary } from '../../shared/schemas/summary'

const seg = (idx: number, startMs: number, text: string): TranscriptSegment =>
  ({ idx, startMs, endMs: startMs + 1000, text })

const segments = [
  seg(0, 0, 'Welcome everyone, let us begin the review.'),
  seg(1, 5000, 'We agreed to ship the billing change on Friday.'),
  seg(2, 10_000, 'Priya will draft the migration plan by next week.'),
  seg(3, 15_000, 'Any other business? No. Thanks all.'),
]

const empty: WireSummary = { summary: '', decisions: [], actionItems: [] }

describe('attestQuote', () => {
  it('finds a quote in the segment the model claimed', () => {
    expect(attestQuote('ship the billing change', 1, segments))
      .toMatchObject({ segmentIdx: 1, startMs: 5000 })
  })

  it('ignores case and punctuation, which models normalise freely', () => {
    expect(attestQuote('Ship the BILLING change!', 1, segments))
      .toMatchObject({ segmentIdx: 1 })
  })

  it('recovers when the words are right but the index is slightly wrong', () => {
    // Far more common than inventing both.
    expect(attestQuote('draft the migration plan', 1, segments))
      .toMatchObject({ segmentIdx: 2, startMs: 10_000 })
  })

  it('finds a quote anywhere when the claimed index is far off', () => {
    expect(attestQuote('draft the migration plan', 99, segments))
      .toMatchObject({ segmentIdx: 2 })
  })

  it('attests quotes in scripts other than Latin', () => {
    // Transcription detects the language, so an ASCII-only normaliser silently
    // dropped every item from a Japanese or Russian meeting.
    const japanese = [seg(0, 0, '来週までに移行計画を作成します。')]
    expect(attestQuote('来週までに移行計画を作成します', 0, japanese))
      .toMatchObject({ segmentIdx: 0, startMs: 0 })

    const russian = [seg(0, 0, 'Мы решили отправить изменения в пятницу.')]
    expect(attestQuote('Мы решили отправить изменения', 0, russian))
      .toMatchObject({ segmentIdx: 0 })
  })

  it('matches accented Latin on the accents actually written', () => {
    // Documents the behaviour rather than guarding the regression: stripping
    // accents mangles both quote and segment the same way, so this case passes
    // either way. The empty-collapse test above is the one that fails against
    // an ASCII-only normaliser.
    const spanish = [seg(0, 0, 'Priya diría que sí, lo enviamos el viernes.')]
    expect(attestQuote('Priya diría que sí', 0, spanish)).toMatchObject({ segmentIdx: 0 })
    expect(attestQuote('Priya diria que si', 0, spanish)).toBeNull()
  })

  it('still rejects an invented quote in a non-Latin transcript', () => {
    const japanese = [seg(0, 0, '来週までに移行計画を作成します。')]
    expect(attestQuote('競合他社を買収することに合意しました', 0, japanese)).toBeNull()
  })

  it('returns null for a quote nobody said', () => {
    // The case the whole mechanism exists for.
    expect(attestQuote('we decided to acquire a competitor', 1, segments)).toBeNull()
  })

  it('refuses quotes too short to match anything but by accident', () => {
    expect(attestQuote('the', 0, segments)).toBeNull()
    expect(attestQuote('', 0, segments)).toBeNull()
  })

  it('reports the segment it actually found, not the one claimed', () => {
    const found = attestQuote('draft the migration plan', 0, segments)
    expect(found!.segmentIdx).toBe(2)
    expect(found!.startMs).toBe(10_000)
  })
})

describe('reconcile', () => {
  it('keeps items the transcript supports and resolves their timestamps', () => {
    const result = reconcile({
      summary: 'A short review.',
      decisions: [{ quote: 'ship the billing change', segmentIdx: 1, decision: 'Ship billing on Friday' }],
      actionItems: [{
        quote: 'draft the migration plan', segmentIdx: 2, task: 'Draft migration plan',
        assignee: 'Priya', dueDateText: 'next week',
      }],
    }, segments)

    expect(result.decisions).toEqual([{
      idx: 0, decision: 'Ship billing on Friday', quote: 'ship the billing change',
      segmentIdx: 1, startMs: 5000,
    }])
    expect(result.actionItems[0]).toMatchObject({
      idx: 0, task: 'Draft migration plan', assignee: 'Priya',
      dueDateText: 'next week', segmentIdx: 2, startMs: 10_000,
    })
    expect(result.droppedDecisions).toBe(0)
  })

  it('drops every item whose quote does not occur in the transcript', () => {
    // This is the check that protects production: a fluent, plausible,
    // entirely invented citation must not reach storage.
    const result = reconcile({
      summary: 'x',
      decisions: [
        { quote: 'we agreed to acquire a competitor', segmentIdx: 1, decision: 'Acquire' },
        { quote: 'ship the billing change', segmentIdx: 1, decision: 'Ship' },
      ],
      actionItems: [
        { quote: 'Sam will rewrite the backend', segmentIdx: 2, task: 'Rewrite', assignee: 'Sam', dueDateText: null },
      ],
    }, segments)

    expect(result.decisions.map(d => d.decision)).toEqual(['Ship'])
    expect(result.droppedDecisions).toBe(1)
    expect(result.actionItems).toEqual([])
    expect(result.droppedActionItems).toBe(1)
  })

  it('treats an empty assignee as nobody named, not as a name', () => {
    const result = reconcile({
      summary: 'x',
      decisions: [],
      actionItems: [{
        quote: 'draft the migration plan', segmentIdx: 2, task: 'Draft',
        assignee: '   ', dueDateText: '',
      }],
    }, segments)
    expect(result.actionItems[0]).toMatchObject({ assignee: null, dueDateText: null })
  })

  it('orders by time and numbers gaplessly, whatever order the model used', () => {
    const result = reconcile({
      summary: 'x',
      decisions: [
        { quote: 'draft the migration plan', segmentIdx: 2, decision: 'Later' },
        { quote: 'ship the billing change', segmentIdx: 1, decision: 'Earlier' },
      ],
      actionItems: [],
    }, segments)
    expect(result.decisions.map(d => d.decision)).toEqual(['Earlier', 'Later'])
    expect(result.decisions.map(d => d.idx)).toEqual([0, 1])
  })

  it('collapses the same item restated at the same moment', () => {
    // Chunk boundaries make this common.
    const result = reconcile({
      summary: 'x',
      decisions: [
        { quote: 'ship the billing change', segmentIdx: 1, decision: 'Ship billing' },
        { quote: 'ship the billing change on Friday', segmentIdx: 1, decision: 'ship billing' },
      ],
      actionItems: [],
    }, segments)
    expect(result.decisions).toHaveLength(1)
  })

  it('drops an item with no text even when its quote checks out', () => {
    const result = reconcile({
      summary: 'x',
      decisions: [{ quote: 'ship the billing change', segmentIdx: 1, decision: '  ' }],
      actionItems: [],
    }, segments)
    expect(result.decisions).toEqual([])
    expect(result.droppedDecisions).toBe(1)
  })

  it('handles a meeting with nothing to report', () => {
    expect(reconcile(empty, segments)).toMatchObject({ decisions: [], actionItems: [] })
  })

  it('drops everything when there is no transcript to check against', () => {
    const result = reconcile({
      summary: 'x',
      decisions: [{ quote: 'anything at all', segmentIdx: 0, decision: 'd' }],
      actionItems: [],
    }, [])
    expect(result.decisions).toEqual([])
    expect(result.droppedDecisions).toBe(1)
  })
})
