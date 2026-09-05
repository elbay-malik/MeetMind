import { describe, expect, it } from 'vitest'
import { contentRangeHeader, parseByteRange, rangeLength } from '../../shared/utils/byte-range'

const SIZE = 1000

describe('parseByteRange', () => {
  it('serves the whole body when no range was asked for', () => {
    expect(parseByteRange(undefined, SIZE)).toEqual({ kind: 'full' })
    expect(parseByteRange(null, SIZE)).toEqual({ kind: 'full' })
    expect(parseByteRange('', SIZE)).toEqual({ kind: 'full' })
  })

  it('handles the open-ended form browsers almost always send', () => {
    // Chromium opens with `bytes=0-` and expects a 206 back; answering 200
    // leaves the resource unseekable.
    expect(parseByteRange('bytes=0-', SIZE)).toEqual({ kind: 'partial', range: { start: 0, end: 999 } })
    expect(parseByteRange('bytes=500-', SIZE)).toEqual({ kind: 'partial', range: { start: 500, end: 999 } })
  })

  it('handles an explicit closed range', () => {
    expect(parseByteRange('bytes=0-99', SIZE)).toEqual({ kind: 'partial', range: { start: 0, end: 99 } })
    expect(parseByteRange('bytes=100-199', SIZE)).toEqual({ kind: 'partial', range: { start: 100, end: 199 } })
  })

  it('clamps an end past the object rather than promising bytes it lacks', () => {
    expect(parseByteRange('bytes=900-99999', SIZE)).toEqual({ kind: 'partial', range: { start: 900, end: 999 } })
  })

  it('handles suffix ranges, which ask for the final N bytes', () => {
    expect(parseByteRange('bytes=-100', SIZE)).toEqual({ kind: 'partial', range: { start: 900, end: 999 } })
  })

  it('clamps a suffix larger than the object to the whole object', () => {
    expect(parseByteRange('bytes=-99999', SIZE)).toEqual({ kind: 'partial', range: { start: 0, end: 999 } })
  })

  it('rejects a start at or past the end, which must be 416', () => {
    expect(parseByteRange('bytes=1000-', SIZE)).toEqual({ kind: 'unsatisfiable' })
    expect(parseByteRange('bytes=5000-6000', SIZE)).toEqual({ kind: 'unsatisfiable' })
  })

  it('rejects a zero-length suffix', () => {
    expect(parseByteRange('bytes=-0', SIZE)).toEqual({ kind: 'unsatisfiable' })
  })

  it('rejects a backwards range', () => {
    expect(parseByteRange('bytes=500-100', SIZE)).toEqual({ kind: 'unsatisfiable' })
  })

  it('falls back to the whole body for anything it does not recognise', () => {
    // RFC 9110 lets a server ignore a Range it will not honour, and no media
    // element sends these, so degrade rather than fail.
    for (const header of ['items=0-100', 'bytes', 'bytes=', 'bytes=abc', 'bytes=--5', 'nonsense']) {
      expect(parseByteRange(header, SIZE), header).toEqual({ kind: 'full' })
    }
  })

  it('ignores multi-range requests instead of answering them wrongly', () => {
    // Answering these needs a multipart/byteranges body; nothing we serve asks.
    expect(parseByteRange('bytes=0-99,200-299', SIZE)).toEqual({ kind: 'full' })
  })

  it('is case-insensitive and tolerates surrounding space', () => {
    expect(parseByteRange('  BYTES=0-9  ', SIZE)).toEqual({ kind: 'partial', range: { start: 0, end: 9 } })
  })

  it('treats a zero-byte object as having nothing to satisfy', () => {
    expect(parseByteRange('bytes=0-', 0)).toEqual({ kind: 'unsatisfiable' })
    expect(parseByteRange('bytes=-10', 0)).toEqual({ kind: 'unsatisfiable' })
  })

  it('refuses to reason about a nonsensical size', () => {
    expect(parseByteRange('bytes=0-99', -1)).toEqual({ kind: 'full' })
    expect(parseByteRange('bytes=0-99', 1.5)).toEqual({ kind: 'full' })
  })

  it('never returns a range outside the object, for any input', () => {
    const inputs = ['bytes=0-', 'bytes=-1', 'bytes=-99999', 'bytes=0-0', 'bytes=999-', 'bytes=998-99999']
    for (const header of inputs) {
      const result = parseByteRange(header, SIZE)
      if (result.kind !== 'partial') continue
      expect(result.range.start, header).toBeGreaterThanOrEqual(0)
      expect(result.range.end, header).toBeLessThan(SIZE)
      expect(result.range.end, header).toBeGreaterThanOrEqual(result.range.start)
    }
  })
})

describe('rangeLength', () => {
  it('counts inclusively, as the wire format does', () => {
    expect(rangeLength({ start: 0, end: 0 })).toBe(1)
    expect(rangeLength({ start: 0, end: 999 })).toBe(1000)
    expect(rangeLength({ start: 100, end: 199 })).toBe(100)
  })
})

describe('contentRangeHeader', () => {
  it('formats the header a 206 must carry', () => {
    expect(contentRangeHeader({ start: 0, end: 999 }, 1000)).toBe('bytes 0-999/1000')
    expect(contentRangeHeader({ start: 500, end: 999 }, 1000)).toBe('bytes 500-999/1000')
  })
})
