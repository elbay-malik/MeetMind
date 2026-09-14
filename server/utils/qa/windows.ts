import type { TranscriptSegment } from '#shared/types/meeting'
import { estimateTokens } from '../summary/plan'

/**
 * A run of consecutive transcript segments, embedded as one retrieval unit.
 *
 * A single segment is a few seconds of speech; embedded alone, "yes, let's do
 * that" retrieves nothing, because what it agrees to is in the segment before.
 * See ADR-0007 decision 2.
 */
export interface TranscriptWindow {
  idx: number
  firstSegmentIdx: number
  lastSegmentIdx: number
  startMs: number
  endMs: number
  text: string
  /**
   * SHA-256 over the window's text AND its segment range and time span. The
   * range is included because two windows can hold identical text at different
   * positions — a transcript replaced by one with a segment inserted earlier —
   * and a hash of the text alone would call the stored window current while its
   * citations point at the wrong segments.
   */
  contentHash: string
}

/** About how long a window spans before it closes. */
export const WINDOW_TARGET_MS = 45_000

/**
 * Upper bound on a window's estimated tokens. Far below the embedding model's
 * 8,192-token input limit on purpose: the windows retrieved for a question are
 * sent together to the answering model, whose per-minute allowance is the
 * binding limit (ADR-0006), so a few retrieved windows must stay small.
 */
export const WINDOW_TOKEN_BUDGET = 1_500

export interface WindowOptions {
  targetMs?: number
  tokenBudget?: number
}

/**
 * Split a transcript into overlapping windows.
 *
 * Greedy, in segment order. A window closes once it spans `targetMs` or the
 * next segment would take it over `tokenBudget`. The next window then starts
 * AT the previous window's last segment, so an exchange crossing a boundary
 * appears whole in at least one window. A segment over the budget on its own
 * becomes its own window rather than being split: segments are the unit every
 * citation speaks in.
 *
 * Deterministic — the same segments always give the same windows and hashes —
 * which is what lets indexing skip windows it has already embedded.
 */
export async function planWindows(
  segments: TranscriptSegment[],
  options: WindowOptions = {},
): Promise<TranscriptWindow[]> {
  const targetMs = options.targetMs ?? WINDOW_TARGET_MS
  const tokenBudget = options.tokenBudget ?? WINDOW_TOKEN_BUDGET
  if (!(targetMs > 0) || !(tokenBudget > 0)) {
    throw new Error('Window target and token budget must be positive')
  }

  const ordered = [...segments].sort((a, b) => a.idx - b.idx)
  const ranges: Array<[number, number]> = []

  let start = 0
  while (start < ordered.length) {
    let end = start
    let tokens = estimateTokens(ordered[start]!.text)
    while (end + 1 < ordered.length) {
      const spanMs = ordered[end]!.endMs - ordered[start]!.startMs
      if (spanMs >= targetMs) break
      const nextTokens = estimateTokens(ordered[end + 1]!.text)
      if (tokens + nextTokens > tokenBudget) break
      end++
      tokens += nextTokens
    }
    ranges.push([start, end])
    if (end === ordered.length - 1) break
    // Overlap by one segment — but a one-segment window has nothing to
    // overlap with, and restarting at itself would never advance.
    start = end > start ? end : end + 1
  }

  return Promise.all(ranges.map(async ([from, to], idx) => {
    const run = ordered.slice(from, to + 1)
    const window = {
      idx,
      firstSegmentIdx: run[0]!.idx,
      lastSegmentIdx: run.at(-1)!.idx,
      startMs: run[0]!.startMs,
      endMs: run.at(-1)!.endMs,
      text: run.map(s => s.text).join('\n'),
    }
    return { ...window, contentHash: await hashWindow(window) }
  }))
}

async function hashWindow(window: Omit<TranscriptWindow, 'contentHash'>): Promise<string> {
  const input = JSON.stringify([
    window.firstSegmentIdx, window.lastSegmentIdx, window.startMs, window.endMs, window.text,
  ])
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input))
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('')
}
