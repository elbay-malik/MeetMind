import { describe, expect, it } from 'vitest'
import { attestQuote, MAX_QUOTE_SEGMENTS, quoteStartsAt, reconcile } from '../../server/utils/summary/reconcile'
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

  it('attests a FRAGMENT of a no-space script, not only a whole segment', () => {
    // tokenize() splits each no-space-script character into its own token so a
    // run of them compares like a substring search. A script missing from
    // NO_SPACE_SCRIPT gets the opposite treatment: the whole sentence becomes
    // ONE token, so occurs() degenerates into whole-run equality and every
    // fragment citation is silently dropped — only a byte-exact whole-segment
    // quote survives, via the full-segment exemption. Khmer, Lao, Burmese and
    // Tibetan were all in that state; each of these fails against the old
    // four-script list.
    const cases: Array<[string, string, string]> = [
      ['Khmer', 'យើងបានយល់ព្រមផ្ញើការផ្លាស់ប្តូរវិក្កយបត្រនៅថ្ងៃសុក្រ។', 'ផ្ញើការផ្លាស់ប្តូរវិក្កយបត្រ'],
      ['Lao', 'ພວກເຮົາຕົກລົງທີ່ຈະສົ່ງການປ່ຽນແປງໃບແຈ້ງໜີ້ໃນວັນສຸກ.', 'ສົ່ງການປ່ຽນແປງໃບແຈ້ງໜີ້'],
      ['Burmese', 'ကျွန်ုပ်တို့သည် ငွေတောင်းခံလွှာပြောင်းလဲမှုကို ပေးပို့ရန် သဘောတူခဲ့သည်။', 'ငွေတောင်းခံလွှာပြောင်းလဲမှု'],
      ['Thai', 'เราตกลงกันว่าจะส่งการเปลี่ยนแปลงใบแจ้งหนี้ในวันศุกร์', 'ส่งการเปลี่ยนแปลงใบแจ้งหนี้'],
    ]
    for (const [script, text, fragment] of cases) {
      expect(attestQuote(fragment, 0, [seg(0, 0, text)]), `${script} fragment must attest`)
        .toMatchObject({ segmentIdx: 0 })
    }
  })

  it('matches accented Latin on the accents actually written', () => {
    // Documents the behaviour rather than guarding the regression: stripping
    // accents mangles both quote and segment the same way, so this case passes
    // either way. The empty-collapse test above is the one that fails against
    // an ASCII-only normaliser. Long enough to clear the fragment floor on its
    // own merits, since that is not what this test is probing.
    const spanish = [seg(0, 0, 'Priya diría que sí, lo enviamos el viernes.')]
    expect(attestQuote('Priya diría que sí, lo enviamos', 0, spanish)).toMatchObject({ segmentIdx: 0 })
    expect(attestQuote('Priya diria que si, lo enviamos', 0, spanish)).toBeNull()
  })

  it('matches a no-space-script quote that omits internal punctuation the transcript has', () => {
    // normalise() turns the transcript's internal comma into a space that a
    // model quoting the same words without it does not have. Japanese has no
    // reliable word boundary for that residual space to preserve, so it must
    // not matter here the way it would for a script that actually uses
    // whitespace to separate words.
    const japanese = [seg(0, 0, '来週までに、移行計画を作成します。')]
    expect(attestQuote('来週までに移行計画を作成します', 0, japanese))
      .toMatchObject({ segmentIdx: 0, startMs: 0 })
  })

  it('still rejects an invented quote in a non-Latin transcript', () => {
    const japanese = [seg(0, 0, '来週までに移行計画を作成します。')]
    expect(attestQuote('競合他社を買収することに合意しました', 0, japanese)).toBeNull()
  })

  it('returns null for a quote nobody said', () => {
    // The case the whole mechanism exists for.
    expect(attestQuote('we decided to acquire a competitor', 1, segments)).toBeNull()
  })

  it('does not match a fabrication that lands mid-word, even meaning the opposite', () => {
    // "approved by everyone" is a literal substring of "disapproved by
    // everyone" — the exact words, starting three characters in. A raw
    // substring check accepts that as attested; the transcript actually
    // says the opposite of what the fabricated quote claims.
    const disagreed = [seg(0, 0, 'The proposal was disapproved by everyone in the room.')]
    expect(attestQuote('approved by everyone', 0, disagreed)).toBeNull()
    // The real words, respecting the actual word boundary, still match.
    expect(attestQuote('disapproved by everyone', 0, disagreed)).toMatchObject({ segmentIdx: 0 })
  })

  it('does not match a fabrication that ENDS mid-word either', () => {
    // Every mid-word test above probes the LEADING boundary. The trailing one
    // was unguarded: dropping it from occurs() left the whole suite green,
    // while this quote — 24 characters, clearing the fragment floor — went from
    // rejected to attested despite being cut off inside "vendor".
    const asked = [seg(0, 0, 'Has anyone reached out to the vendor about pricing yet?')]
    expect(attestQuote('reached out to the vendo', 0, asked)).toBeNull()
    expect(attestQuote('reached out to the vendor', 0, asked)).toMatchObject({ segmentIdx: 0 })
  })

  it('does not fall back to substring matching just because the SEGMENT also contains an unrelated CJK word', () => {
    // A segment can legitimately mix scripts (an English sentence naming a
    // place in Japanese). The all-Latin fabricated quote must still be held
    // to a word boundary — picking the matching rule from the segment as a
    // whole would let it slip through just because the segment happens to
    // also contain a CJK word elsewhere.
    const mixed = [seg(0, 0, 'The proposal was disapproved by everyone in 東京.')]
    expect(attestQuote('approved by everyone', 0, mixed)).toBeNull()
    expect(attestQuote('disapproved by everyone', 0, mixed)).toMatchObject({ segmentIdx: 0 })
  })

  it('holds the Latin portion of a MIXED-SCRIPT QUOTE to a word boundary too, not just an all-Latin one', () => {
    // Deciding "which script" from the quote as a whole is not enough either:
    // a single fabricated quote can itself mix an entirely invented Latin
    // phrase with a real CJK one. "approved by everyone in 東京" must still
    // fail on its Latin portion even though the same quote also contains CJK
    // characters that genuinely occur in the segment.
    const mixed = [seg(0, 0, 'The proposal was disapproved by everyone in 東京.')]
    expect(attestQuote('approved by everyone in 東京', 0, mixed)).toBeNull()
    expect(attestQuote('disapproved by everyone in 東京', 0, mixed)).toMatchObject({ segmentIdx: 0 })
  })

  it('treats canonically equivalent accented text the same, precomposed or not', () => {
    // Cafe/e-acute can be written as one precomposed character (U+00E9) or
    // as a base letter plus a separate combining acute accent (U+0065
    // U+0301) -- the same text, but a letters-and-numbers-only filter drops
    // the second form's accent as if it were punctuation while leaving the
    // first form's intact, so otherwise-identical text would fail to match.
    // .normalize() constructs each form explicitly, rather than depending on
    // which form this file's own text happens to be saved as.
    const text = 'Caf\u00e9 est pr\u00eat pour la r\u00e9union.'
    const precomposed = [seg(0, 0, text.normalize('NFC'))]
    expect(attestQuote(text.normalize('NFD'), 0, precomposed)).toMatchObject({ segmentIdx: 0 })
    const decomposed = [seg(0, 0, text.normalize('NFD'))]
    expect(attestQuote(text.normalize('NFC'), 0, decomposed)).toMatchObject({ segmentIdx: 0 })
  })

  it('keeps combining marks NFC cannot precompose away', () => {
    // The test above passes with \p{M} removed from the filter entirely: every
    // accent in "Café est prêt" HAS a precomposed form, so NFC collapses the
    // decomposed input before the filter ever sees a standalone mark, and the
    // \p{M} half of that fix was never actually load-bearing.
    //
    // These have no precomposed form, so the marks survive NFC and the filter
    // is the only thing standing between them and being stripped as
    // punctuation. Devanagari, and a Latin base carrying two stacked marks.
    const hindi = 'हमने शुक्रवार को चालान भेजने पर सहमति दी'
    expect(attestQuote(hindi, 0, [seg(0, 0, `${hindi}।`)])).toMatchObject({ segmentIdx: 0 })

    const stacked = 'the q̣̇ sample was approved today'
    expect(attestQuote(stacked, 0, [seg(0, 0, `Yes, ${stacked}.`)])).toMatchObject({ segmentIdx: 0 })
    // Dropping one of the two marks is a different word, and must not attest.
    expect(attestQuote('the q̇ sample was approved today', 0, [seg(0, 0, `Yes, ${stacked}.`)]))
      .toBeNull()
  })

  it('counts the fragment/full-match floor by Unicode code point, not UTF-16 code unit', () => {
    // A single supplementary-plane character is ONE code point but TWO
    // UTF-16 code units (a surrogate pair) -- `.length` alone would let a
    // single such character slip through the 2-character full-match floor
    // as though it were two characters.
    const oneChar = String.fromCodePoint(0x20000)
    const segment = [seg(0, 0, oneChar)]
    expect(attestQuote(oneChar, 0, segment)).toBeNull()
  })

  it('refuses quotes too short to match anything but by accident', () => {
    expect(attestQuote('the', 0, segments)).toBeNull()
    expect(attestQuote('', 0, segments)).toBeNull()
  })

  it('pins the fragment floor exactly, so it cannot drift unnoticed', () => {
    // The floor was assertable only somewhere in a wide band before this:
    // the nearest fixtures were 10 characters (rejected) and 24 (accepted),
    // so anything from 11 to 24 could be substituted without a test noticing.
    // Both needles end on a word boundary, so only the LENGTH differs — a
    // mid-word slice would be rejected by the token-boundary rule instead and
    // prove nothing about the floor.
    const justUnder = 'alpha bravo charlie'
    const justAt = 'alpha bravo charlies'
    expect(justUnder).toHaveLength(19)
    expect(justAt).toHaveLength(20)
    expect(attestQuote(justUnder, 0, [seg(0, 0, `Right, ${justUnder} it is.`)])).toBeNull()
    expect(attestQuote(justAt, 0, [seg(0, 0, `Right, ${justAt} it is.`)]))
      .toMatchObject({ segmentIdx: 0 })
  })

  it('applies the fragment floor comparably across scripts, not by raw character count', () => {
    // 20 characters of English is three or four words; 20 characters of
    // Japanese is a whole sentence, so counting raw characters made the floor a
    // far stricter rule for CJK than for Latin. Measured before the fix, this
    // 19-character clause — complete and entirely specific — was rejected, so
    // a Japanese meeting yielded citations only when the model quoted a whole
    // segment.
    const japanese = [seg(0, 0, '田中さんが来週までに新しい見積もりを提出することで合意しました。')]
    const clause = '来週までに新しい見積もりを提出すること'
    expect([...clause]).toHaveLength(19)
    expect(attestQuote(clause, 0, japanese)).toMatchObject({ segmentIdx: 0 })

    // Still refuses the genuinely generic short phrase the floor exists for.
    expect(attestQuote('来週', 0, japanese)).toBeNull()
  })

  it('keeps a value and a range distinguishable, rather than flattening the separator', () => {
    // Punctuation between digits is what separates a value from a range, so
    // dropping it to a space let a quote state a range the meeting never
    // mentioned and still attest: "3.5" and "3-5" both normalised to "3 5".
    const transcript = [seg(0, 0, 'Revenue grew by 3.5 percent this quarter, below the plan we set.')]
    expect(attestQuote('Revenue grew by 3.5 percent this quarter', 0, transcript))
      .toMatchObject({ segmentIdx: 0 })
    expect(attestQuote('Revenue grew by 3-5 percent this quarter', 0, transcript)).toBeNull()

    const range = [seg(0, 0, 'We expect 3-5 percent growth next quarter, maybe more.')]
    expect(attestQuote('We expect 3-5 percent growth next quarter', 0, range))
      .toMatchObject({ segmentIdx: 0 })
    expect(attestQuote('We expect 3.5 percent growth next quarter', 0, range)).toBeNull()
  })

  it('reports the segment it actually found, not the one claimed', () => {
    const found = attestQuote('draft the migration plan', 0, segments)
    expect(found!.segmentIdx).toBe(2)
    expect(found!.startMs).toBe(10_000)
  })

  it('picks the occurrence nearest the claimed index, not the first in the transcript', () => {
    // A phrase people say more than once in the same meeting, long enough that
    // the fragment floor is not what is under test here. The claimed index is
    // outside the transcript entirely (a numbered-line index the model simply
    // got wrong), so neither occurrence is an exact or neighbouring hit — the
    // only question is which one a search "anywhere" prefers. Picking the
    // first array match, rather than the nearest, would silently attribute the
    // citation to the wrong moment.
    const repeated = [
      seg(0, 0, 'Let us revisit the budget numbers before we finalize anything.'),
      seg(1, 5000, 'Moving on to the next item on the agenda.'),
      seg(2, 10_000, 'We agreed to increase the marketing budget for Q3.'),
      seg(3, 15_000, 'Let us revisit the budget numbers one more time before closing.'),
    ]
    // Claimed index 6: distance 3 from segment 3, distance 6 from segment 0.
    expect(attestQuote('Let us revisit the budget numbers', 6, repeated))
      .toMatchObject({ segmentIdx: 3, startMs: 15_000 })
    // Claimed index -3: distance 3 from segment 0, distance 6 from segment 3.
    expect(attestQuote('Let us revisit the budget numbers', -3, repeated))
      .toMatchObject({ segmentIdx: 0, startMs: 0 })
  })

  it('accepts a short quote that is the cited segment\'s entire text', () => {
    // Real meetings are full of short, complete confirmations that ARE the
    // decision: "Agreed.", "Approved.", "Got it." A flat character floor would
    // reject these purely because the true evidence was short.
    const confirmations = [seg(0, 0, 'Agreed.'), seg(1, 1000, 'Got it.')]
    expect(attestQuote('Agreed.', 0, confirmations)).toMatchObject({ segmentIdx: 0 })
    expect(attestQuote('Got it', 1, confirmations)).toMatchObject({ segmentIdx: 1 })
  })

  it('rejects a short quote that is only a FRAGMENT of a longer segment', () => {
    // The reviewer's own worked example: a short, generic fragment that is
    // real but proves nothing about the specific claim attached to it.
    const meeting = [seg(0, 0, 'Has anyone reached out to the vendor yet about pricing?')]
    expect(attestQuote('the vendor', 0, meeting)).toBeNull()
  })

  it('prefers a full-segment match over a nearer fragment match', () => {
    // Both candidates clear the fragment floor on their own, so this isolates
    // the full-over-fragment preference from the length filter.
    const quote = 'was approved by everyone'
    const segs = [
      seg(0, 0, 'The proposal was approved by everyone in the room today.'),
      seg(5, 25_000, 'Was approved by everyone.'),
    ]
    // Segment 0 merely contains the phrase (fragment, distance 0); segment 5
    // IS the phrase (full match, distance 5). Full wins despite being farther.
    expect(attestQuote(quote, 0, segs)).toMatchObject({ segmentIdx: 5 })
  })
})

/**
 * Whisper ends a segment at a pause or a length limit, not at the end of a
 * sentence. These lines are verbatim from the one-hour meeting measured in the
 * Phase 9 spike, where requiring a quote to sit inside one segment dropped 57 of
 * 73 action items and 29 of 73 decisions that the model had quoted perfectly.
 */
describe('quotes that run across segments', () => {
  const split = [
    seg(325, 0, 'raised a concern that this will not scale unless we invest more time in'),
    seg(326, 4000, 'planning and testing. After some discussion, we agreed to keep the current'),
    seg(327, 8000, 'scope for customer onboarding and revisit the larger changes in the planning session.'),
    seg(328, 12_000, 'Action item. Laina will write up the open questions about customer onboarding and share'),
    seg(329, 16_000, 'them with the group by next week.'),
  ]
  const decisionQuote = 'After some discussion, we agreed to keep the current scope for customer onboarding and revisit the larger changes in the planning session.'
  const actionQuote = 'Action item. Laina will write up the open questions about customer onboarding and share them with the group by next week.'

  it('attests a quote split over two segments, citing the segment it begins in', () => {
    expect(attestQuote(decisionQuote, 326, split)).toMatchObject({ segmentIdx: 326, startMs: 4000 })
    expect(attestQuote(actionQuote, 328, split)).toMatchObject({ segmentIdx: 328, startMs: 12_000 })
  })

  it('cites where the quote begins even when the model gave a later line it touches', () => {
    expect(attestQuote(actionQuote, 329, split)).toMatchObject({ segmentIdx: 328 })
  })

  it('keeps such items through reconcile, which is where they were being lost', () => {
    const result = reconcile({
      summary: '',
      decisions: [{ quote: decisionQuote, segmentIdx: 326, decision: 'Keep the onboarding scope' }],
      actionItems: [{ quote: actionQuote, segmentIdx: 328, task: 'Write up open questions', assignee: 'Laina', dueDateText: 'by next week' }],
    }, split)
    expect(result.decisions).toHaveLength(1)
    expect(result.actionItems).toHaveLength(1)
    expect(result.droppedDecisions + result.droppedActionItems).toBe(0)
  })

  it('measures nearness to the claim from every line the quote touches, not only its first', () => {
    // The words occur twice: across 5-7, and inside 8. The model gave line 7,
    // the last line of the first occurrence -- the one it read. Measured from
    // the first line alone, 5 is two away and 8 only one, and the citation
    // would jump to the other occurrence.
    const repeated = [
      seg(5, 5000, 'so to be clear'), seg(6, 6000, 'we will ship'), seg(7, 7000, 'on friday then'),
      seg(8, 8000, 'so to be clear we will ship on friday then'),
    ]
    expect(attestQuote('to be clear we will ship on friday', 7, repeated)).toMatchObject({ segmentIdx: 5 })
  })

  it('attributes a quote that fits wholly in a later segment to that segment, not to one before it', () => {
    // "scope for customer onboarding" sits entirely in 327; the run 326-327
    // also contains it, but the words do not begin in 326.
    expect(attestQuote('scope for customer onboarding and revisit', 326, split)).toMatchObject({ segmentIdx: 327 })
  })

  it(`accepts a run of up to ${MAX_QUOTE_SEGMENTS} segments and no longer`, () => {
    const short = [
      seg(0, 0, 'we will move'), seg(1, 1000, 'the launch to'), seg(2, 2000, 'the second week'),
      seg(3, 3000, 'of March'),
    ]
    expect(attestQuote('we will move the launch to the second week', 0, short)).toMatchObject({ segmentIdx: 0 })
    expect(attestQuote('we will move the launch to the second week of March', 0, short)).toBeNull()
  })

  it('does not stitch together segments that are not consecutive in the transcript', () => {
    // A gap in the indices is a different moment of the meeting, even when the
    // two segments sit side by side in the array (as retrieved Q&A windows do).
    const gapped = [seg(10, 0, 'we agreed to keep the current'), seg(40, 90_000, 'scope for customer onboarding')]
    expect(attestQuote('we agreed to keep the current scope for customer onboarding', 10, gapped)).toBeNull()
  })

  it('still rejects words that span segments but were never said together', () => {
    expect(attestQuote('keep the current scope for the data migration', 326, split)).toBeNull()
  })

  it('never cites a segment with no words as where a quote begins', () => {
    // Whisper emits segments like these and normalisation keeps them. Before
    // the fix one standing before the quote won the tie and the citation
    // sought the listener to the music, not the words.
    const noisy = [seg(4, 0, '♪'), seg(5, 1000, '...'), seg(6, 2000, 'we agreed to keep the current scope'), seg(7, 3000, 'for onboarding')]
    expect(attestQuote('agreed to keep the current scope', 6, noisy)).toMatchObject({ segmentIdx: 6 })
    expect(attestQuote('agreed to keep the current scope', 4, noisy)).toMatchObject({ segmentIdx: 6 })
    expect(attestQuote('keep the current scope for onboarding', 6, noisy)).toMatchObject({ segmentIdx: 6 })
    expect(quoteStartsAt(noisy, 4, 'agreed to keep the current scope')).toBe(false)
    expect(quoteStartsAt(noisy, 5, 'agreed to keep the current scope')).toBe(false)
  })

  it('still bridges a wordless segment in the middle of a quote', () => {
    const paused = [seg(1, 0, 'we will ship'), seg(2, 1000, '...'), seg(3, 2000, 'on friday then')]
    expect(attestQuote('we will ship on friday then', 1, paused)).toMatchObject({ segmentIdx: 1 })
  })

  it('applies the fragment floor to a quote that spans segments', () => {
    const tiny = [seg(0, 0, 'ok so'), seg(1, 1000, 'yes we do')]
    // 11 characters across a boundary: real, but too generic to pin a claim to.
    expect(attestQuote('so yes we do', 0, tiny)).toBeNull()
  })

  it('quoteStartsAt states the same contract for checks made outside reconciliation', () => {
    expect(quoteStartsAt(split, 326, decisionQuote)).toBe(true)
    expect(quoteStartsAt(split, 327, decisionQuote)).toBe(false)
    expect(quoteStartsAt(split, 325, decisionQuote)).toBe(false)
    expect(quoteStartsAt(split, 999, decisionQuote)).toBe(false)
    expect(quoteStartsAt(split, 326, '   ')).toBe(false)
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

  it('counts de-duplicated repeats as dropped, so kept + dropped accounts for everything sent', () => {
    // Chunk boundaries make the same decision arrive twice, which the dedupe
    // above is for — but it used to `continue` without incrementing, so the
    // counters silently failed to add up precisely in the case the code says
    // is common. Anything reporting "N of M dropped" was wrong there.
    const decision = { quote: 'ship the billing change', segmentIdx: 1, decision: 'Ship Friday' }
    const action = { quote: 'draft the migration plan', segmentIdx: 2, task: 'Draft the plan' }
    const result = reconcile({
      summary: 'x',
      decisions: [decision, { ...decision }, { ...decision }],
      actionItems: [action, { ...action }],
    }, segments)

    expect(result.decisions).toHaveLength(1)
    expect(result.actionItems).toHaveLength(1)
    expect(result.decisions.length + result.droppedDecisions).toBe(3)
    expect(result.actionItems.length + result.droppedActionItems).toBe(2)
  })
})
