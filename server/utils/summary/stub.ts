import type { MeetingSummary } from '#shared/types/meeting'
import type { WireSummary } from '#shared/schemas/summary'
import { attestChunk, mergeReconciled, type AttestedChunk } from './reconcile'
import { SummarizationError, type SummarizeInput, type Summarizer } from './summarizer'

/**
 * A quote that cannot occur in any real transcript: `attestQuote` compares
 * token sequences (see reconcile.ts's tokenize), and no meeting says this.
 * Used only when the canary option
 * is on, to prove reconciliation actually rejects an unsupported citation
 * through the real HTTP path — the stub's own quotes are always real, since
 * they are lifted verbatim from the transcript, so without this there is
 * nothing in the credential-free test tiers that ever exercises the drop path
 * end to end.
 */
const CANARY_QUOTE = 'zzz-unsupported-canary-citation-that-nobody-said-zzz'

let retryableFailureUsed = false

export interface StubSummarizerOptions {
  /** Test-only: see CANARY_QUOTE. Never set outside tests. */
  injectCanary?: boolean
  /**
   * Test-only: throw a retryable SummarizationError exactly once (module
   * lifetime, not per-instance), the same shape a transient provider 5xx
   * takes, so tests can prove a retryable summarization failure lands on a
   * cooldown-gated `failed` state rather than the ungated `summarizing` one.
   * Never set outside tests.
   */
  failOnceRetryable?: boolean
}

/**
 * Stands in when no API key is configured, so development, CI and the browser
 * driver exercise the whole path without credentials.
 *
 * It quotes the transcript rather than inventing content: every citation it
 * produces is real, so it goes through the same reconciliation as a model's
 * answer and exercises the citation-to-player link end to end. Its wording says
 * plainly that it is not a real summary.
 */
export function createStubSummarizer(options: StubSummarizerOptions = {}): Summarizer {
  /** What a model would have replied for these lines, before any checking. */
  function reply(segments: SummarizeInput['segments']): WireSummary {
    if (options.failOnceRetryable && !retryableFailureUsed) {
      retryableFailureUsed = true
      throw new SummarizationError(
        'Summarization service is unavailable (stub-injected for testing).', 502, true,
      )
    }

    if (segments.length === 0) return { summary: '', decisions: [], actionItems: [] }

    // A deterministic structural rule, so the same transcript always yields
    // the same result and tests do not flake.
    const step = Math.max(1, Math.ceil(segments.length / 3))
    const picked = segments.filter((_, i) => i % step === 0).slice(0, 3)

    return {
      summary:
        `No summarization provider is configured, so this placeholder stands in for a summary of `
        + `${segments.length} transcript segments.`,
      decisions: [
        ...picked.slice(0, 2).map(s => ({
          quote: s.text,
          segmentIdx: s.idx,
          decision: `[stub] Placeholder decision drawn from segment ${s.idx}`,
        })),
        ...(options.injectCanary
          ? [{ quote: CANARY_QUOTE, segmentIdx: 0, decision: '[canary] should be dropped by reconciliation' }]
          : []),
      ],
      actionItems: picked.slice(0, 2).map(s => ({
        quote: s.text,
        segmentIdx: s.idx,
        task: `[stub] Placeholder action item drawn from segment ${s.idx}`,
        assignee: null,
        dueDateText: null,
      })),
    }
  }

  async function summarizeChunk({ segments }: SummarizeInput): Promise<AttestedChunk> {
    return attestChunk(reply(segments), segments)
  }

  return {
    kind: 'stub',
    summarizeChunk,

    // The whole transcript as one chunk: the stub spends no quota, so it has
    // no reason to split, and its output stays what the tests were written to.
    async summarize({ segments }: SummarizeInput): Promise<MeetingSummary> {
      const { summary, decisions, actionItems } = mergeReconciled([await summarizeChunk({ segments })])
      return { summary, decisions, actionItems, provider: 'stub' }
    },
  }
}
