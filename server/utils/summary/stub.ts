import type { MeetingSummary } from '#shared/types/meeting'
import { reconcile } from './reconcile'
import type { SummarizeInput, Summarizer } from './summarizer'

/**
 * Stands in when no API key is configured, so development, CI and the browser
 * driver exercise the whole path without credentials.
 *
 * It quotes the transcript rather than inventing content: every citation it
 * produces is real, so it goes through the same reconciliation as a model's
 * answer and exercises the citation-to-player link end to end. Its wording says
 * plainly that it is not a real summary.
 */
export function createStubSummarizer(): Summarizer {
  return {
    kind: 'stub',

    async summarize({ segments }: SummarizeInput): Promise<MeetingSummary> {
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
        decisions: picked.slice(0, 2).map(s => ({
          quote: s.text,
          segmentIdx: s.idx,
          decision: `[stub] Placeholder decision drawn from segment ${s.idx}`,
        })),
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
