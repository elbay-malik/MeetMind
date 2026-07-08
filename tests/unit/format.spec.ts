import { describe, expect, it } from 'vitest'
import { formatDuration, formatMegabytes } from '../../shared/utils/format'

describe('formatDuration', () => {
  it('formats sub-minute durations', () => {
    expect(formatDuration(0)).toBe('0:00')
    expect(formatDuration(9)).toBe('0:09')
    expect(formatDuration(59.9)).toBe('0:59')
  })

  it('formats minutes and seconds', () => {
    expect(formatDuration(75)).toBe('1:15')
    expect(formatDuration(600)).toBe('10:00')
  })

  it('formats hours with zero-padded minutes', () => {
    expect(formatDuration(3600)).toBe('1:00:00')
    expect(formatDuration(3661)).toBe('1:01:01')
    expect(formatDuration(7325)).toBe('2:02:05')
  })

  it('clamps negative input to zero', () => {
    expect(formatDuration(-5)).toBe('0:00')
  })
})

describe('formatMegabytes', () => {
  it('converts bytes to a one-decimal MB string', () => {
    expect(formatMegabytes(0)).toBe('0.0 MB')
    expect(formatMegabytes(7.2 * 1024 * 1024)).toBe('7.2 MB')
  })
})
