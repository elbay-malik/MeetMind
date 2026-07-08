/**
 * Format a duration in seconds as `M:SS` or `H:MM:SS`.
 * Used for transcript timestamps and player positions.
 */
export function formatDuration(totalSeconds: number): string {
  const clamped = Math.max(0, totalSeconds)
  const s = String(Math.floor(clamped % 60)).padStart(2, '0')
  const m = Math.floor((clamped / 60) % 60)
  const h = Math.floor(clamped / 3600)
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`
}

/** Format a byte count as a human-readable megabyte string, e.g. `7.2 MB`. */
export function formatMegabytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
