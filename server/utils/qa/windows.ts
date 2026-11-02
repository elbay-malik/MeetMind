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
 *
 * The estimate can undercount, but on nothing measured by enough: the worst at this
 * size was 5,923 real tokens, on text that is nothing but emoji (ADR-0014). So a
 * single segment over the budget, which is never split, is the case to expect. A
 * character that expands under the tokenizer's normalization, such as U+FDFA, can
 * pass the limit inside a window under budget. Speech does not produce that, and
 * the provider refuses it rather than truncating.
 */
export const WINDOW_TOKEN_BUDGET = 1_500

export interface WindowOptions {
  targetMs?: number
  tokenBudget?: number
}

/** Where one scan over ordered segments got to. Positions are array positions, not indexes. */
interface WindowScan {
  /** Inclusive position ranges of the windows that are settled. */
  ranges: Array<[from: number, to: number]>
  /** Where the next window starts. Meaningless once `finished`. */
  next: number
  /** The plan ends with the last of `ranges`: nothing follows it in the transcript. */
  finished: boolean
}

/**
 * The one definition of where windows fall, greedy and forward only: everything a
 * window's end depends on comes after its start. Over a whole transcript this is the
 * whole plan; over a slice it stops where the slice stops deciding anything.
 *
 * A window that reaches the last row held is not settled unless `atEnd`, even when its
 * span has closed it. Whether another window follows it depends on whether that row is
 * the transcript's last, and the next slice starts over at this window's first segment
 * to find out. That is the whole of why a sliced plan is the same plan.
 */
function scanWindows(
  ordered: readonly TranscriptSegment[],
  { targetMs, tokenBudget, atEnd, maxWindows }: { targetMs: number, tokenBudget: number, atEnd: boolean, maxWindows: number },
): WindowScan {
  const ranges: WindowScan['ranges'] = []
  let start = 0
  while (start < ordered.length && ranges.length < maxWindows) {
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
    if (end === ordered.length - 1) {
      if (!atEnd) return { ranges, next: start, finished: false }
      ranges.push([start, end])
      return { ranges, next: ordered.length, finished: true }
    }
    ranges.push([start, end])
    // Overlap by one segment — but a one-segment window has nothing to
    // overlap with, and restarting at itself would never advance.
    start = end > start ? end : end + 1
  }
  return { ranges, next: start, finished: atEnd && ordered.length === 0 }
}

function assertValidOptions(targetMs: number, tokenBudget: number): void {
  if (!(targetMs > 0) || !(tokenBudget > 0)) {
    throw new Error('Window target and token budget must be positive')
  }
}

/** The window over a contiguous run of segments, with its hash. */
export async function windowOver(run: readonly TranscriptSegment[], idx: number): Promise<TranscriptWindow> {
  const window = {
    idx,
    firstSegmentIdx: run[0]!.idx,
    lastSegmentIdx: run.at(-1)!.idx,
    startMs: run[0]!.startMs,
    endMs: run.at(-1)!.endMs,
    text: run.map(s => s.text).join('\n'),
  }
  return { ...window, contentHash: await hashWindow(window) }
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
  assertValidOptions(targetMs, tokenBudget)

  const ordered = [...segments].sort((a, b) => a.idx - b.idx)
  const { ranges } = scanWindows(ordered, { targetMs, tokenBudget, atEnd: true, maxWindows: Number.POSITIVE_INFINITY })
  return Promise.all(ranges.map(([from, to], idx) => windowOver(ordered.slice(from, to + 1), idx)))
}

export interface WindowSliceOptions extends WindowOptions {
  /** The index the first window of this slice gets in the whole plan. */
  firstWindowIdx: number
  /** The slice runs to the end of the transcript. */
  atEnd: boolean
  /** Stop after this many windows, so one step hashes a bounded number. */
  maxWindows: number
}

export interface WindowSlice {
  /** Windows of the whole plan, with the hashes and indexes they have there. */
  windows: TranscriptWindow[]
  /** The segment index the next slice must start at. Null once `finished`. */
  nextSegmentIdx: number | null
  /** The plan ends with the last of `windows`. */
  finished: boolean
}

/**
 * The next windows of the plan, from segments in `idx` order that start at a window's
 * first segment (ADR-0012 §2). No window here depends on anything before the slice or
 * after what it settles, so a transcript read a page at a time gives the windows
 * {@link planWindows} gives it read whole, and only as many hashes as asked for.
 *
 * No windows and not `finished` means the slice ended inside its first window: read
 * more from the same place.
 */
export async function planWindowSlice(
  ordered: readonly TranscriptSegment[],
  options: WindowSliceOptions,
): Promise<WindowSlice> {
  const targetMs = options.targetMs ?? WINDOW_TARGET_MS
  const tokenBudget = options.tokenBudget ?? WINDOW_TOKEN_BUDGET
  assertValidOptions(targetMs, tokenBudget)
  if (!(options.maxWindows > 0)) throw new Error('A slice must be allowed at least one window')

  const scan = scanWindows(ordered, { targetMs, tokenBudget, atEnd: options.atEnd, maxWindows: options.maxWindows })
  return {
    windows: await Promise.all(scan.ranges.map(([from, to], i) =>
      windowOver(ordered.slice(from, to + 1), options.firstWindowIdx + i))),
    nextSegmentIdx: scan.finished ? null : ordered[scan.next]?.idx ?? null,
    finished: scan.finished,
  }
}

async function hashWindow(window: Omit<TranscriptWindow, 'contentHash'>): Promise<string> {
  const input = JSON.stringify([
    window.firstSegmentIdx, window.lastSegmentIdx, window.startMs, window.endMs, window.text,
  ])
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input))
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('')
}
