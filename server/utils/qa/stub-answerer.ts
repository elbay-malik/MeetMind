import { NO_SPACE_SCRIPT } from '../summary/plan'
import { normalise, tokenize } from '../summary/reconcile'
import type { RequestPacer } from '../summary/groq'
import { INJECTED_FAILURE_TEXT, INJECTED_RATE_LIMIT_MS, injectedFailure } from '../injected-failure'
import { AnswerError, awaitAnswerSlot, type Answerer } from './answerer'

/**
 * Common English function words that are long enough to survive the length
 * filter below on their own. Not exhaustive, and deliberately not a general
 * multi-language stopword list — the length filter already does that job
 * across scripts; this list only closes the specific gap it leaves open for
 * English, where a filler word can be 4+ characters ("about", "which").
 *
 * A self-review of this branch found the length filter alone was not enough:
 * "Which vendors bid for the office lease?" no longer matches through "the"
 * (3 characters, filtered), but a question like "What did the CEO decide
 * about hiring?" could still match an unrelated line through "about" (4
 * characters, previously counted as meaningful) whenever the true answer
 * happens to be worded differently (e.g. "hires" rather than "hiring" — this
 * stub does no stemming, and is not expected to; the fix here is only that a
 * shared filler word must never outrank an absence of real overlap).
 */
const STOPWORDS = new Set([
  'about', 'above', 'after', 'again', 'against', 'also', 'although', 'among', 'another', 'anyone', 'anything',
  'around', 'because', 'been', 'before', 'being', 'below', 'between', 'both', 'cannot', 'could', 'couldn',
  'didn', 'does', 'doesn', 'doing', 'down', 'during', 'each', 'either', 'else', 'ever', 'every', 'everyone',
  'everything', 'from', 'further', 'given', 'going', 'gone', 'hardly', 'have', 'haven', 'having', 'here',
  'hers', 'herself', 'himself', 'however', 'into', 'isn', 'itself', 'just', 'least', 'less', 'like', 'made',
  'make', 'many', 'might', 'mightn', 'more', 'most', 'much', 'must', 'mustn', 'myself', 'need', 'needn',
  'neither', 'never', 'next', 'nobody', 'none', 'nothing', 'nowhere', 'often', 'once', 'only', 'other',
  'others', 'ought', 'ourselves', 'over', 'quite', 'rather', 'really', 'same', 'seem', 'seems', 'several',
  'shall', 'should', 'shouldn', 'since', 'some', 'somebody', 'someone', 'something', 'still', 'such', 'than',
  'that', 'their', 'theirs', 'them', 'themselves', 'then', 'there', 'these', 'they', 'this', 'those', 'though',
  'through', 'throughout', 'thus', 'together', 'under', 'unless', 'until', 'upon', 'very', 'wasn', 'weren',
  'what', 'whatever', 'when', 'whenever', 'where', 'whereas', 'wherever', 'whether', 'which', 'while',
  'whither', 'whoever', 'whole', 'whom', 'whose', 'will', 'with', 'within', 'without', 'would', 'wouldn',
  'yours', 'yourself', 'yourselves',
])

/**
 * Tokens worth matching on. Short words are dropped so "the" or "for" shared
 * with an unrelated line does not read as an answer — before this, "Which
 * vendors bid for the office lease?" cited a budget decision through "the".
 * Longer filler words are dropped too, via STOPWORDS above, for the same
 * reason: length alone does not tell a filler word from a content word once
 * it clears four characters.
 * A no-space-script character is one token by itself (see tokenize) and
 * carries meaning at that length, so those are always kept.
 */
function meaningfulTokens(text: string): Set<string> {
  return new Set(tokenize(normalise(text)).filter(t =>
    (t.length >= 4 && !STOPWORDS.has(t)) || NO_SPACE_SCRIPT.test(t)))
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
export function createStubAnswerer(options: {
  /**
   * Test-only: take a slot like the real answerer does, so the busy path can be
   * proven over HTTP without a provider. The stub otherwise spends no quota.
   */
  pacer?: RequestPacer
  /** Test-only: a question holding this asks for a failure. See injected-failure.ts. */
  failureCanary?: string
} = {}): Answerer {
  return {
    kind: 'stub',
    async reserveSlot() {
      if (options.pacer) await awaitAnswerSlot(options.pacer)
    },
    async answer({ question, segments }, { slotHeld = false } = {}) {
      if (options.pacer && !slotHeld) await awaitAnswerSlot(options.pacer)
      const failure = injectedFailure(options.failureCanary, 'answer', question)
      if (failure === 'internal') throw new Error(INJECTED_FAILURE_TEXT)
      if (failure === 'rate-limited') throw new AnswerError(INJECTED_FAILURE_TEXT, 429, false, new Date(Date.now() + INJECTED_RATE_LIMIT_MS))
      if (failure) throw new AnswerError(INJECTED_FAILURE_TEXT, 502, failure === 'retryable')
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
