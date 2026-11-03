import { meetingIdSchema } from '../schemas/meeting'

/**
 * The optional retention purge's setting, read the same way by what deletes and what says so
 * (ADR-0017). Off unless it says otherwise, as it is irreversible and nobody is watching. Off by
 * mistake only leaves something stored, and that is the mistake to make.
 */

/** A hundred years. Past this a date in Postgres runs out, and it is a typing mistake anyway. */
export const MAX_RETENTION_DAYS = 36_500

export interface RetentionSetting {
  /** How many days a meeting is kept, or null when the purge is off. */
  days: number | null
  /** Something was set that is not a positive whole number, which is off too, and worth saying. */
  unusable: boolean
}

const OFF: RetentionSetting = { days: null, unusable: false }
const UNUSABLE: RetentionSetting = { days: null, unusable: true }

/**
 * `NUXT_RETENTION_PURGE_DAYS` as it reaches the runtime config, where destr has turned `30` into a
 * number and `true` into a boolean. Empty or 0 is off. So is anything but a positive whole number,
 * and that says so: `30.5`, `-1`, `30d`, `true`.
 */
export function readRetentionDays(value: unknown): RetentionSetting {
  if (value === undefined || value === null) return OFF
  const text = typeof value === 'number' ? String(value) : typeof value === 'string' ? value.trim() : null
  if (text === null) return UNUSABLE
  if (text === '' || /^0+$/.test(text)) return OFF
  if (!/^\d+$/.test(text)) return UNUSABLE
  const days = Number(text)
  return Number.isSafeInteger(days) && days <= MAX_RETENTION_DAYS ? { days, unusable: false } : UNUSABLE
}

/**
 * The days the purge really runs at, or null when it does not run: only with a usable setting,
 * and only with a public demo the database can be told to leave alone. With that setting
 * empty or wrong there is no telling which meeting is the demo, and `wrangler deploy` removing a
 * dashboard variable (ADR-0015) is an easy way to get there. It would delete the demo for good.
 */
export function purgeDaysInEffect(setting: unknown, demoMeetingId: unknown): number | null {
  const { days } = readRetentionDays(setting)
  if (days === null) return null
  return meetingIdSchema.safeParse(String(demoMeetingId ?? '').trim()).success ? days : null
}

/** Whether a meeting created at this moment is past its days, on this clock. A date it cannot read is not. */
export function isPastRetention(createdAt: string, days: number, now: number): boolean {
  const created = Date.parse(createdAt)
  return Number.isFinite(created) && created < now - days * 86_400_000
}
