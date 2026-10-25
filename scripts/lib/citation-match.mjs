// A plain-JS mirror of server/utils/summary/reconcile.ts's normalise/tokenize/
// occurs, for the browser-driver scripts: those are plain Node, not a place a
// TypeScript server module can be imported into.
//
// A weaker approximation here would reintroduce, in the smoke check, exactly
// the bugs reconciliation itself exists to avoid: a raw substring check
// accepts a mid-word fabrication and rejects a no-space-script citation
// differing only by punctuation; deciding token-vs-substring matching from the
// whole quote's script (rather than tokenizing) still fails a quote mixing a
// fabricated Latin phrase with a real CJK one; and skipping NFC/combining-mark
// handling fails a citation that is canonically identical but differently
// composed.
//
// It is still a copy, and it drifted out of sync with the real implementation
// TWICE before this file existed — once for the tokenizing rewrite and once
// for NFC. The point of it being a module rather than a block pasted inside
// drive-upload.mjs is that tests/unit/driver-citation-parity.spec.ts can
// import BOTH this and the real reconcile.ts and prove they agree, so the
// next drift fails a test instead of waiting to be noticed in review.

export const NO_SPACE_SCRIPT
  = /\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}|\p{Script=Thai}|\p{Script=Khmer}|\p{Script=Lao}|\p{Script=Myanmar}|\p{Script=Tibetan}/u

const NO_SPACE_SCRIPT_GLOBAL = new RegExp(NO_SPACE_SCRIPT.source, 'gu')

// Punctuation between digits is spelled out rather than flattened, so a value
// and a range stay distinguishable ("3.5" vs "3-5"). Mirrors reconcile.ts.
const DIGIT_SEPARATOR_WORDS = {
  '.': ' point ',
  ',': ' comma ',
  '-': ' to ',
  '\u2013': ' to ',
  '/': ' slash ',
  ':': ' colon ',
}

export const normalise = text =>
  text
    .normalize('NFC')
    .toLowerCase()
    .replace(/(?<=\p{Nd})[.,\-\u2013/:](?=\p{Nd})/gu, match => DIGIT_SEPARATOR_WORDS[match] ?? ' ')
    .replace(/[^\p{L}\p{N}\p{M}]+/gu, ' ')
    .trim()

export function tokenize(text) {
  return text
    .replace(NO_SPACE_SCRIPT_GLOBAL, match => ` ${match} `)
    .trim()
    .split(/\s+/)
    .filter(Boolean)
}

const TOKEN_SEP = ' '
const tokenKey = text => tokenize(text).join(TOKEN_SEP)

export function occurs(haystack, needle) {
  const needleKey = tokenKey(needle)
  if (!needleKey) return false
  return `${TOKEN_SEP}${tokenKey(haystack)}${TOKEN_SEP}`.includes(`${TOKEN_SEP}${needleKey}${TOKEN_SEP}`)
}

// Mirrors reconcile.ts's MAX_QUOTE_SEGMENTS and quoteStartsAt: a quote may run
// on from the segment it begins in into the next one or two, because Whisper
// splits sentences across segments. A citation points at the segment the
// quote BEGINS in.
export const MAX_QUOTE_SEGMENTS = 3

const bounded = key => `${TOKEN_SEP}${key}${TOKEN_SEP}`
const containsKey = (haystackKey, needleKey) => bounded(haystackKey).includes(bounded(needleKey))

function spanFrom(segments, keys, position, needleKey) {
  const join = (from, to) => keys.slice(from, to + 1).filter(Boolean).join(TOKEN_SEP)
  for (let length = 1; length <= MAX_QUOTE_SEGMENTS; length++) {
    const last = position + length - 1
    if (last >= segments.length) return 0
    if (length > 1 && segments[last].idx !== segments[last - 1].idx + 1) return 0
    if (!containsKey(join(position, last), needleKey)) continue
    if (length > 1 && containsKey(join(position + 1, last), needleKey)) return 0
    return length
  }
  return 0
}

export function quoteStartsAt(segments, segmentIdx, quote) {
  const position = segments.findIndex(segment => segment.idx === segmentIdx)
  const needleKey = tokenKey(normalise(quote))
  if (position < 0 || !needleKey) return false
  const keys = segments.map(segment => tokenKey(normalise(segment.text)))
  return spanFrom(segments, keys, position, needleKey) > 0
}
