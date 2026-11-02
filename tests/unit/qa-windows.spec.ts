import { describe, expect, it } from 'vitest'
import { planWindows, planWindowSlice, windowOver, WINDOW_TARGET_MS, WINDOW_TOKEN_BUDGET } from '../../server/utils/qa/windows'
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

/**
 * ADR-0012 §2 and step 8's first acceptance criterion: reading a transcript a page at
 * a time, from wherever the last step stopped, gives the plan reading it whole gives.
 * This is the loop `advanceIndexing` runs, without the ledger around it.
 */
describe('planWindowSlice', () => {
  interface Reading {
    /** Rows a page starts with. */
    page: number
    /** Windows a slice may hold. */
    maxWindows: number
    /** Of those, how many this step keeps, as a batch that hit its token cap does. */
    keep?: (windows: number) => number
    targetMs?: number
    tokenBudget?: number
  }

  async function readInSlices(segments: TranscriptSegment[], reading: Reading) {
    const ordered = [...segments].sort((a, b) => a.idx - b.idx)
    const windows = []
    let from = ordered[0]?.idx ?? 0
    let width = reading.page
    let guard = 0
    for (;;) {
      if (guard++ > 100_000) throw new Error('the slices never finished')
      const rest = ordered.filter(s => s.idx >= from)
      const rows = rest.slice(0, width)
      const slice = await planWindowSlice(rows, {
        firstWindowIdx: windows.length,
        atEnd: rows.length === rest.length,
        maxWindows: reading.maxWindows,
        targetMs: reading.targetMs,
        tokenBudget: reading.tokenBudget,
      })
      if (slice.windows.length === 0 && !slice.finished) {
        width *= 2
        continue
      }
      width = reading.page
      const kept = reading.keep ? Math.max(1, Math.min(reading.keep(slice.windows.length), slice.windows.length)) : slice.windows.length
      windows.push(...slice.windows.slice(0, kept))
      if (kept < slice.windows.length) {
        from = slice.windows[kept]!.firstSegmentIdx
        continue
      }
      if (slice.finished) return windows
      from = slice.nextSegmentIdx!
    }
  }

  /** A small deterministic generator, so a failure names a seed that reproduces it. */
  function random(seed: number) {
    let state = seed >>> 0 || 1
    return (below: number) => {
      state ^= state << 13
      state >>>= 0
      state ^= state >>> 17
      state ^= state << 5
      state >>>= 0
      return state % below
    }
  }

  /** What a stored transcript can hold, weighted towards the awkward. */
  function wildTranscript(seed: number): TranscriptSegment[] {
    const pick = random(seed * 7919 + 13)
    const count = pick(180)
    const segments: TranscriptSegment[] = []
    let at = pick(5_000)
    let idx = 0
    for (let i = 0; i < count; i++) {
      const length = [0, 200, 1_500, 5_000, 12_000, 47_000, 90_000][pick(7)]!
      const text = [
        `line ${i} about ${pick(1000)}`,
        Array.from({ length: pick(80) + 1 }, (_, w) => `word${w}`).join(' '),
        // Over the budget alone, which is never split.
        Array.from({ length: 1_400 }, (_, w) => `w${w}`).join(' '),
        // No spaces: priced per character.
        '会議の内容'.repeat(pick(60) + 1),
        // The smallest thing a line can cost.
        '字',
      ][pick(10) < 6 ? pick(2) : pick(5)]!
      segments.push({ idx, startMs: at, endMs: at + length, text })
      at += pick(4) === 0 ? 0 : length
      // Old transcripts are gapless, but nothing about the plan may rely on it.
      idx += pick(25) === 0 ? 3 : 1
    }
    return segments
  }

  it('gives the whole plan, hash for hash, however a wild transcript is cut', async () => {
    const readings: Array<Reading & { name: string }> = [
      { name: 'one row at a time', page: 1, maxWindows: 1 },
      { name: 'two rows, one window', page: 2, maxWindows: 1 },
      { name: 'the real step', page: 256, maxWindows: 16 },
      { name: 'a page holding the whole of most transcripts', page: 400, maxWindows: 400 },
      { name: 'the size of a short window', page: 7, maxWindows: 3 },
      { name: 'a batch that stops part-way through every slice', page: 40, maxWindows: 16, keep: n => Math.ceil(n / 2) },
      { name: 'a batch that keeps one window at a time', page: 23, maxWindows: 16, keep: () => 1 },
    ]
    let checked = 0
    for (let seed = 1; seed <= 60; seed++) {
      const segments = wildTranscript(seed)
      const whole = await planWindows(segments)
      for (const { name, ...reading } of readings) {
        expect(await readInSlices(segments, reading), `seed ${seed}, ${name}`).toEqual(whole)
        checked += whole.length
      }
    }
    // A run that planned nothing would pass all of the above.
    expect(checked).toBeGreaterThan(5_000)
  })

  it('gives the whole plan under other targets and budgets, which move every boundary', async () => {
    for (let seed = 61; seed <= 80; seed++) {
      const segments = wildTranscript(seed)
      for (const options of [{ targetMs: 1_000 }, { tokenBudget: 200 }, { targetMs: 300_000, tokenBudget: 5_000 }]) {
        expect(await readInSlices(segments, { page: 11, maxWindows: 4, ...options }), `seed ${seed}`)
          .toEqual(await planWindows(segments, options))
      }
    }
  })

  // The case a slice cannot see from inside: a page that ends exactly where the
  // transcript does looks like one with more to come. Taking its last window as settled
  // would then read that window's last line alone and plan a window the whole plan
  // does not have, so every page size around the transcript's own length is tried.
  it('plans no extra window when a page ends exactly where the transcript does', async () => {
    const segments = transcript(40)
    const whole = await planWindows(segments)
    expect(whole.length).toBeGreaterThan(2)
    for (let page = 1; page <= 45; page++) {
      expect(await readInSlices(segments, { page, maxWindows: 16 }), `a page of ${page}`).toEqual(whole)
    }
  })

  it('settles a window its span has closed only once it knows whether a line follows', async () => {
    // One 50 s line closes on its span alone. Whether another window comes after it
    // depends on whether it is the transcript's last line.
    const line: TranscriptSegment = { idx: 0, startMs: 0, endMs: 50_000, text: 'a long line' }
    const open = await planWindowSlice([line], { firstWindowIdx: 0, atEnd: false, maxWindows: 16 })
    expect(open).toEqual({ windows: [], nextSegmentIdx: 0, finished: false })
    const closed = await planWindowSlice([line], { firstWindowIdx: 0, atEnd: true, maxWindows: 16 })
    expect(closed.finished).toBe(true)
    expect(closed.windows).toHaveLength(1)
  })

  it('numbers its windows as the whole plan does, and says where the next slice starts', async () => {
    const segments = transcript(40)
    const whole = await planWindows(segments)
    const slice = await planWindowSlice(segments, { firstWindowIdx: 0, atEnd: true, maxWindows: 2 })
    expect(slice.windows).toEqual(whole.slice(0, 2))
    expect(slice.nextSegmentIdx).toBe(whole[2]!.firstSegmentIdx)
    expect(slice.finished).toBe(false)

    const later = await planWindowSlice(segments.filter(s => s.idx >= slice.nextSegmentIdx!), {
      firstWindowIdx: 2, atEnd: true, maxWindows: 1,
    })
    expect(later.windows).toEqual([whole[2]])
  })

  it('stops at the number of windows it is allowed, so a step hashes a bounded number', async () => {
    const digest = crypto.subtle.digest.bind(crypto.subtle)
    let hashes = 0
    crypto.subtle.digest = async (...args: Parameters<typeof digest>) => {
      hashes++
      return digest(...args)
    }
    try {
      const slice = await planWindowSlice(transcript(2_000), { firstWindowIdx: 0, atEnd: false, maxWindows: 16 })
      expect(slice.windows).toHaveLength(16)
      expect(hashes).toBe(16)
    }
    finally {
      crypto.subtle.digest = digest
    }
  })

  it('finishes an empty transcript only when it knows the transcript is empty', async () => {
    expect(await planWindowSlice([], { firstWindowIdx: 0, atEnd: true, maxWindows: 16 }))
      .toEqual({ windows: [], nextSegmentIdx: null, finished: true })
  })

  it('refuses options that would never finish, as the whole plan does', async () => {
    await expect(planWindowSlice(transcript(3), { firstWindowIdx: 0, atEnd: true, maxWindows: 0 })).rejects.toThrow(/at least one window/)
    await expect(planWindowSlice(transcript(3), { firstWindowIdx: 0, atEnd: true, maxWindows: 1, targetMs: 0 })).rejects.toThrow(/positive/)
  })

  it('works from the defaults the whole plan uses', async () => {
    const segments = transcript(40)
    expect((await planWindows(segments))).toEqual(await planWindows(segments, { targetMs: WINDOW_TARGET_MS, tokenBudget: WINDOW_TOKEN_BUDGET }))
    expect((await planWindowSlice(segments, { firstWindowIdx: 0, atEnd: true, maxWindows: 1000 })).windows).toEqual(await planWindows(segments))
  })
})

describe('windowOver', () => {
  it('gives the plan\'s own window back from just its lines, so a retrieved window can be checked without the plan', async () => {
    const segments = transcript(40)
    for (const window of await planWindows(segments)) {
      const run = segments.filter(s => s.idx >= window.firstSegmentIdx && s.idx <= window.lastSegmentIdx)
      expect(await windowOver(run, window.idx)).toEqual(window)
    }
  })
})
