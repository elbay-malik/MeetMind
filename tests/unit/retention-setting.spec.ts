import { describe, expect, it } from 'vitest'
import { isPastRetention, MAX_RETENTION_DAYS, purgeDaysInEffect, readRetentionDays } from '../../shared/utils/retention'

const DEMO = '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d'

describe('NUXT_RETENTION_PURGE_DAYS', () => {
  it.each<[string, unknown]>([
    ['nothing', undefined],
    ['null', null],
    ['empty', ''],
    ['whitespace', '   '],
    ['zero', 0],
    ['zero, as text', '0'],
    ['zeros', '000'],
  ])('is off and says nothing for %s, which is the default', (_name, value) => {
    expect(readRetentionDays(value)).toEqual({ days: null, unusable: false })
  })

  it.each<[string, unknown, number]>([
    ['a whole number', 30, 30],
    ['one', 1, 1],
    ['a whole number as text', '30', 30],
    ['with whitespace a secret store kept', ' 30\n', 30],
    ['the most there can be', MAX_RETENTION_DAYS, MAX_RETENTION_DAYS],
  ])('is on for %s', (_name, value, days) => {
    expect(readRetentionDays(value)).toEqual({ days, unusable: false })
  })

  it.each<[string, unknown]>([
    ['a fraction', 30.5],
    ['a fraction as text', '30.5'],
    ['negative', -1],
    ['negative as text', '-1'],
    ['a word', 'thirty'],
    ['a unit', '30d'],
    ['two numbers', '30 60'],
    ['an exponent as text', '3e1'],
    ['hex', '0x1e'],
    ['true', true],
    ['false', false],
    ['an object', { days: 30 }],
    ['a list', [30]],
    ['infinity', Number.POSITIVE_INFINITY],
    ['not a number', Number.NaN],
    ['past what a date can hold', MAX_RETENTION_DAYS + 1],
    ['past what a number can hold', '99999999999999999999'],
  ])('is off, and says it was not understood, for %s', (_name, value) => {
    expect(readRetentionDays(value)).toEqual({ days: null, unusable: true })
  })
})

describe('the days the purge really runs at', () => {
  it('are the setting\'s, beside a public demo it can leave out', () => {
    expect(purgeDaysInEffect(30, DEMO)).toBe(30)
    expect(purgeDaysInEffect('7', ` ${DEMO.toUpperCase()}\n`)).toBe(7)
  })

  it.each<[string, unknown, unknown]>([
    ['with the setting off', '', DEMO],
    ['with the setting wrong', 'thirty', DEMO],
    ['with no demo named, when the demo could not be told from any other', 30, ''],
    ['with a demo that is not an id', 30, 'not-a-uuid'],
    ['with no demo setting at all', 30, undefined],
  ])('are none %s', (_name, setting, demo) => {
    expect(purgeDaysInEffect(setting, demo)).toBeNull()
  })
})

describe('whether a meeting is past its days', () => {
  const NOW = Date.parse('2026-11-03T12:00:00.000Z')
  const DAY = 86_400_000
  const created = (daysAgo: number) => new Date(NOW - daysAgo * DAY).toISOString()

  it('goes by the stored time, on the clock it is given', () => {
    expect(isPastRetention(created(31), 30, NOW)).toBe(true)
    expect(isPastRetention(created(29), 30, NOW)).toBe(false)
    // With a Postgres offset, as the database writes it.
    expect(isPastRetention('2026-10-01T12:00:00+00:00', 30, NOW)).toBe(true)
  })

  it('is not, at exactly its days', () => {
    expect(isPastRetention(created(30), 30, NOW)).toBe(false)
    expect(isPastRetention(new Date(NOW - 30 * DAY - 1).toISOString(), 30, NOW)).toBe(true)
  })

  it.each(['', 'yesterday', 'not a date'])('is not when the time cannot be read: %s', (createdAt) => {
    expect(isPastRetention(createdAt, 30, NOW)).toBe(false)
  })
})
