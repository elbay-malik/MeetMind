import { describe, expect, it } from 'vitest'
import { planWindows } from '../../server/utils/qa/windows'
import type { TranscriptSegment } from '../../shared/types/meeting'

/** `count` five-second segments of `words` words each, back to back. */
const transcript = (count: number, words = 10): TranscriptSegment[] =>
  Array.from({ length: count }, (_, i) => ({
    idx: i,
    startMs: i * 5_000,
    endMs: i * 5_000 + 4_800,
    text: `segment ${i} ${Array.from({ length: words - 2 }, () => 'word').join(' ')}`,
  }))

describe('planWindows', () => {
  it('returns nothing for an empty transcript', async () => {
    expect(await planWindows([])).toEqual([])
  })

  it('keeps a short transcript in one window', async () => {
    const windows = await planWindows(transcript(3))
    expect(windows).toHaveLength(1)
    expect(windows[0]).toMatchObject({ idx: 0, firstSegmentIdx: 0, lastSegmentIdx: 2, startMs: 0, endMs: 14_800 })
  })

  it('prices text that expands under normalization at the floor, so the budget does not bound its real tokens', async () => {
    // U+FDFA counts 4 tokens per character in bge-m3's tokenizer (ADR-0014 decision 4),
    // so this one window is about 23,000 real tokens, far over the 8,192 limit, and
    // no segment in it is over the budget. Speech does not produce this.
    const text = '\uFDFA'.repeat(2_900)
    const windows = await planWindows([
      { idx: 0, startMs: 0, endMs: 5_000, text },
      { idx: 1, startMs: 5_000, endMs: 10_000, text },
    ])
    expect(windows).toHaveLength(1)
    expect([...windows[0]!.text].length).toBeGreaterThan(5_800)
  })

  it('closes a window once it spans the target duration', async () => {
    const windows = await planWindows(transcript(40), { targetMs: 20_000 })
    for (const w of windows.slice(0, -1)) {
      expect(w.endMs - w.startMs).toBeGreaterThanOrEqual(20_000)
      // …and not by more than the one segment that crossed the line.
      expect(w.endMs - w.startMs).toBeLessThan(20_000 + 5_000)
    }
  })

  it('overlaps consecutive windows by exactly one segment', async () => {
    // So an exchange crossing a boundary is whole in at least one window.
    const windows = await planWindows(transcript(40), { targetMs: 20_000 })
    expect(windows.length).toBeGreaterThan(2)
    for (let i = 1; i < windows.length; i++) {
      expect(windows[i]!.firstSegmentIdx).toBe(windows[i - 1]!.lastSegmentIdx)
    }
  })

  it('covers every segment, in order, and ends at the last one', async () => {
    const segments = transcript(57)
    const windows = await planWindows(segments, { targetMs: 20_000 })
    const covered = new Set(windows.flatMap(w =>
      Array.from({ length: w.lastSegmentIdx - w.firstSegmentIdx + 1 }, (_, k) => w.firstSegmentIdx + k)))
    expect([...covered].sort((a, b) => a - b)).toEqual(segments.map(s => s.idx))
    expect(windows.at(-1)!.lastSegmentIdx).toBe(56)
    expect(windows.map(w => w.idx)).toEqual(windows.map((_, i) => i))
  })

  it('does not end with a window holding only the previous window\'s last segment', async () => {
    const windows = await planWindows(transcript(9), { targetMs: 20_000 })
    const last = windows.at(-1)!
    expect(last.lastSegmentIdx).toBeGreaterThan(last.firstSegmentIdx)
  })

  it('closes a window before it would exceed the token budget', async () => {
    // 100-word segments estimate at 144 tokens each, so three fit in 450.
    const windows = await planWindows(transcript(12, 100), { targetMs: 10 * 60_000, tokenBudget: 450 })
    expect(windows.length).toBeGreaterThan(1)
    for (const w of windows) expect(w.lastSegmentIdx - w.firstSegmentIdx + 1).toBeLessThanOrEqual(3)
  })

  it('gives an over-budget segment its own window and still advances past it', async () => {
    // A one-segment window has nothing to overlap with; restarting at itself
    // would loop forever.
    const segments = transcript(4)
    segments[1] = { ...segments[1]!, text: Array.from({ length: 2_000 }, () => 'word').join(' ') }
    const windows = await planWindows(segments, { tokenBudget: 200 })
    expect(windows.some(w => w.firstSegmentIdx === 1 && w.lastSegmentIdx === 1)).toBe(true)
    expect(windows.at(-1)!.lastSegmentIdx).toBe(3)
  })

  it('orders segments by idx even when given out of order', async () => {
    const windows = await planWindows(transcript(3).reverse())
    expect(windows[0]!.text.split('\n')[0]).toMatch(/^segment 0/)
  })

  it('is deterministic, hashes included', async () => {
    const a = await planWindows(transcript(30), { targetMs: 20_000 })
    const b = await planWindows(transcript(30), { targetMs: 20_000 })
    expect(a).toEqual(b)
    expect(a[0]!.contentHash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('changes a window\'s hash when its text changes', async () => {
    const before = await planWindows(transcript(3))
    const edited = transcript(3)
    edited[1] = { ...edited[1]!, text: 'something else was said' }
    const after = await planWindows(edited)
    expect(after[0]!.contentHash).not.toBe(before[0]!.contentHash)
  })

  it('changes a window\'s hash when identical text moves to different segments', async () => {
    // Same words, shifted one segment later. A text-only hash would call the
    // stored window current while its segment range cited the wrong lines.
    const original = transcript(3)
    const shifted = original.map(s => ({ ...s, idx: s.idx + 1, startMs: s.startMs + 5_000, endMs: s.endMs + 5_000 }))
    const [a] = await planWindows(original)
    const [b] = await planWindows(shifted)
    expect(b!.text).toBe(a!.text)
    expect(b!.contentHash).not.toBe(a!.contentHash)
  })

  it('refuses a nonsensical target or budget instead of looping', async () => {
    await expect(planWindows(transcript(3), { targetMs: 0 })).rejects.toThrow(/positive/)
    await expect(planWindows(transcript(3), { tokenBudget: Number.NaN })).rejects.toThrow(/positive/)
  })
})
