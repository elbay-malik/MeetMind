import { NO_SPACE_SCRIPT } from '../summary/plan'
import { normalise, tokenize } from '../summary/reconcile'
import type { Answerer } from './answerer'

/**
 * Tokens worth matching on. Short words are dropped so "the" or "for" shared
 * with an unrelated line does not read as an answer — before this, "Which
 * vendors bid for the office lease?" cited a budget decision through "the".
 * A no-space-script character is one token by itself (see tokenize) and
 * carries meaning at that length, so those are always kept.
 */
function meaningfulTokens(text: string): Set<string> {
  return new Set(tokenize(normalise(text)).filter(t => t.length >= 4 || NO_SPACE_SCRIPT.test(t)))
}

/**
 * Stands in for the answering model when no Groq key is configured.
 *
 * Cites the retrieved line sharing the most words with the question, quoting it
 * verbatim, so the whole path — retrieval, the citation check, the response and
 * the player link — runs end to end without credentials. When no line shares a
 * meaningful word it cites nothing, which exercises the not-found path. It says in its own
 * text that it is a placeholder.
 */
export function createStubAnswerer(): Answerer {
  return {
    kind: 'stub',
    async answer({ question, segments }) {
      const wanted = meaningfulTokens(question)
      let best: { idx: number, text: string, overlap: number } | null = null
      for (const segment of segments) {
        const overlap = [...meaningfulTokens(segment.text)].filter(t => wanted.has(t)).length
        if (overlap > 0 && (!best || overlap > best.overlap)) {
          best = { idx: segment.idx, text: segment.text, overlap }
        }
      }
      if (!best) {
        return { citations: [], answer: '[stub] None of the retrieved lines share a meaningful word with the question.' }
      }
      return {
        citations: [{ quote: best.text, segmentIdx: best.idx }],
        answer: `[stub] Line ${best.idx} is the closest match to the question; no answering model is configured.`,
      }
    },
  }
}
