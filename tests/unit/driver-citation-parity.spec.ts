import { describe, expect, it } from 'vitest'
import { normalise, occurs } from '../../server/utils/summary/reconcile'
import {
  NO_SPACE_SCRIPT as driverNoSpaceScript,
  normalise as driverNormalise,
  occurs as driverOccurs,
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
    const alphabet = [...'abcdef ', '東', '京', 'ก', 'ក', 'ກ', 'က', '.', ',', '-', 'é',
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
})
