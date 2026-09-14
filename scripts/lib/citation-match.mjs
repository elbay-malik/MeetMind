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

export const normalise = text =>
  text.normalize('NFC').toLowerCase().replace(/[^\p{L}\p{N}\p{M}]+/gu, ' ').trim()

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
