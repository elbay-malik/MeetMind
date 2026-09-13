import type { MeetingSummary } from '#shared/types/meeting'
import { reconcile } from './reconcile'
import { SummarizationError, type SummarizeInput, type Summarizer } from './summarizer'

/**
 * A quote that cannot occur in any real transcript: `attestQuote`'s search is
 * substring-based, and no meeting says this. Used only when the canary option
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
  return {
    kind: 'stub',

    async summarize({ segments }: SummarizeInput): Promise<MeetingSummary> {
      if (options.failOnceRetryable && !retryableFailureUsed) {
        retryableFailureUsed = true
        throw new SummarizationError(
          'Summarization service is unavailable (stub-injected for testing).', 502, true,
        )
      }

      if (segments.length === 0) {
        return { summary: '', decisions: [], actionItems: [], provider: 'stub' }
      }

      // A deterministic structural rule, so the same transcript always yields
      // the same result and tests do not flake.
      const step = Math.max(1, Math.ceil(segments.length / 3))
      const picked = segments.filter((_, i) => i % step === 0).slice(0, 3)

      const wire = {
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

      const { decisions, actionItems } = reconcile(wire, segments)
      return { summary: wire.summary, decisions, actionItems, provider: 'stub' }
    },
  }
}
