import { describe, expect, it } from 'vitest'
import { MAX_QUOTE_SEGMENTS, normalise, occurs, quoteStartsAt } from '../../server/utils/summary/reconcile'
import {
  NO_SPACE_SCRIPT as driverNoSpaceScript,
  normalise as driverNormalise,
  occurs as driverOccurs,
  MAX_QUOTE_SEGMENTS as DRIVER_MAX_QUOTE_SEGMENTS,
  quoteStartsAt as driverQuoteStartsAt,
} from '../../scripts/lib/citation-match.mjs'
import { NO_SPACE_SCRIPT } from '../../server/utils/summary/plan'

/**
 * scripts/lib/citation-match.mjs is a hand-written copy of reconcile.ts's
 * matching contract, because the browser-driver scripts are plain Node and
 * cannot import a TypeScript server module. The copy has silently drifted from
 * the original twice — once when matching became tokenize-based, once when
 * normalise gained NFC — each time leaving the end-to-end smoke check happily
 * accepting citations the real implementation rejects, which is the one thing
 * that check exists to notice.
 *
 * This holds the two to each other so the next drift fails here instead.
 */
describe('driver citation matcher parity', () => {
  it('uses the identical no-space-script detection', () => {
    expect(driverNoSpaceScript.source).toBe(NO_SPACE_SCRIPT.source)
    expect(driverNoSpaceScript.flags).toBe(NO_SPACE_SCRIPT.flags)
  })

  const cases: Array<[string, string, string]> = [
    ['mid-word fabrication', 'The proposal was disapproved by everyone.', 'approved by everyone'],
    ['honest Latin quote', 'The proposal was approved by everyone.', 'approved by everyone'],
    ['quote ending mid-word', 'Has anyone reached out to the vendor about pricing?', 'reached out to the vendo'],
    ['mixed script, honest', 'The proposal was approved by everyone in 東京.', 'approved by everyone in 東京'],
    ['mixed script, fabricated', 'The proposal was disapproved by everyone in 東京.', 'approved by everyone in 東京'],
    ['CJK fragment', '来週までに移行計画を作成します。', '移行計画を作成'],
    ['Thai fragment', 'เราตกลงกันว่าจะส่งการเปลี่ยนแปลงใบแจ้งหนี้', 'ส่งการเปลี่ยนแปลง'],
    ['Khmer fragment', 'យើងបានយល់ព្រមផ្ញើការផ្លាស់ប្តូរវិក្កយបត្រ', 'ផ្ញើការផ្លាស់ប្តូរ'],
    ['Lao fragment', 'ພວກເຮົາຕົກລົງທີ່ຈະສົ່ງການປ່ຽນແປງ', 'ສົ່ງການປ່ຽນແປງ'],
    ['Burmese fragment', 'ကျွန်ုပ်တို့သည် ငွေတောင်းခံလွှာပြောင်းလဲမှုကို ပေးပို့ရန်', 'ငွေတောင်းခံလွှာပြောင်းလဲမှု'],
    ['punctuation differs', 'We agreed, finally, to ship it.', 'We agreed finally to ship it'],
    ['unrelated text', 'We agreed to ship the billing change.', 'we cancelled the project'],
    ['empty needle', 'We agreed to ship it.', '   '],
    ['decimal vs range', 'Revenue grew by 3.5 percent this quarter.', 'grew by 3-5 percent'],
    ['decimal matching itself', 'Revenue grew by 3.5 percent this quarter.', 'grew by 3.5 percent'],
    ['thousands separators', 'That caps exposure at 1,000,000 dollars total.', 'at 1,000,000 dollars'],
    ['separator dropped entirely', 'That caps exposure at 1,000,000 dollars.', 'at 1000000 dollars'],
    ['date-like separator', 'We ship on 3/5 regardless of the weather.', 'ship on 3-5 regardless'],
  ]

  it.each(cases)('agrees on %s', (_label, haystack, needle) => {
    expect(driverOccurs(driverNormalise(haystack), driverNormalise(needle)))
      .toBe(occurs(normalise(haystack), normalise(needle)))
  })

  it('agrees on canonically equivalent text however it is composed', () => {
    const composed = 'Café est prêt'.normalize('NFC')
    const decomposed = 'Café est prêt'.normalize('NFD')
    for (const [haystack, needle] of [[composed, decomposed], [decomposed, composed]] as const) {
      expect(driverOccurs(driverNormalise(haystack), driverNormalise(needle)))
        .toBe(occurs(normalise(haystack), normalise(needle)))
    }
  })

  it('agrees across a randomised corpus, not just the cases someone thought of', () => {
    // A drift that only shows up on an input nobody wrote a case for is
    // exactly the kind that has slipped through twice.
    // Digits matter as much as letters here: normalise treats punctuation
    // BETWEEN digits differently from punctuation anywhere else, and the first
    // version of this corpus had no digits at all — so it sat green through a
    // real change to that very rule, which is the drift it exists to catch.
    const alphabet = [...'abcdef 0123 ', '東', '京', 'ก', 'ក', 'ກ', 'က', '.', ',', '-', '/', ':', 'é',
      'é', String.fromCodePoint(0x20000)]
    let seed = 1337
    const random = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648
    const pick = () => alphabet[Math.floor(random() * alphabet.length)]!
    const build = (n: number) => Array.from({ length: n }, pick).join('')

    for (let i = 0; i < 2000; i++) {
      const haystack = build(4 + Math.floor(random() * 40))
      // Half the needles are drawn FROM the haystack, so true matches are
      // common enough to be meaningful rather than all-false agreement.
      const needle = random() < 0.5
        ? haystack.slice(Math.floor(random() * haystack.length))
        : build(1 + Math.floor(random() * 12))
      expect(
        driverOccurs(driverNormalise(haystack), driverNormalise(needle)),
        `disagreed on haystack=${JSON.stringify(haystack)} needle=${JSON.stringify(needle)}`,
      ).toBe(occurs(normalise(haystack), normalise(needle)))
    }
  })

  // The citation check itself, not only the matching under it: the browser
  // driver verifies every stored citation with this, and a mirror that still
  // demanded one segment would fail the smoke run on a correct summary.
  describe('quoteStartsAt', () => {
    it('allows the same number of segments', () => {
      expect(DRIVER_MAX_QUOTE_SEGMENTS).toBe(MAX_QUOTE_SEGMENTS)
    })

    const seg = (idx: number, text: string) => ({ idx, startMs: idx * 1000, endMs: idx * 1000 + 999, text })
    const split = [seg(5, 'we agreed to keep the current'), seg(6, 'scope for onboarding and'), seg(7, 'revisit it later'), seg(9, 'unrelated')]
    // A wordless segment directly before speech, as Whisper emits them.
    split.unshift(seg(4, '♪'))
    const cases: Array<[string, number, string]> = [
      ['within one segment', 5, 'agreed to keep'],
      ['across two', 5, 'keep the current scope for onboarding'],
      ['across three', 5, 'current scope for onboarding and revisit it'],
      ['begins later, cited early', 5, 'scope for onboarding'],
      ['across an index gap', 7, 'revisit it later unrelated'],
      ['unknown segment', 99, 'agreed to keep'],
      ['empty quote', 5, '  '],
      ['wordless segment before the quote', 4, 'we agreed to keep'],
    ]
    it.each(cases)('agrees on %s', (_label, idx, quote) => {
      expect(driverQuoteStartsAt(split, idx, quote)).toBe(quoteStartsAt(split, idx, quote))
    })

    it('agrees across randomised transcripts, including gaps in the indices', () => {
      // '...' and '♪' normalise to nothing, which is the case the first
      // version of this got wrong.
      const words = ['we', 'agreed', 'to', 'ship', 'it', 'on', 'friday', '3.5', '東京', 'ok', '...', '♪']
      let seed = 4242
      const random = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648
      const pickWords = (n: number) => Array.from({ length: n }, () => words[Math.floor(random() * words.length)]).join(' ')
      for (let round = 0; round < 1000; round++) {
        let idx = 0
        const segments = Array.from({ length: 2 + Math.floor(random() * 5) }, () => {
          idx += random() < 0.2 ? 2 : 1
          return seg(idx, pickWords(1 + Math.floor(random() * 4)))
        })
        // Quotes cut from the joined text, so matches across boundaries are
        // common rather than all-false agreement.
        const joined = segments.map(s => s.text).join(' ').split(' ')
        const from = Math.floor(random() * joined.length)
        const quote = joined.slice(from, from + 1 + Math.floor(random() * 8)).join(' ')
        const cited = segments[Math.floor(random() * segments.length)]!.idx
        expect(
          driverQuoteStartsAt(segments, cited, quote),
          `disagreed on ${JSON.stringify({ segments: segments.map(s => [s.idx, s.text]), cited, quote })}`,
        ).toBe(quoteStartsAt(segments, cited, quote))
      }
    })
  })
})
