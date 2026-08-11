/**
 * Time formatting — the only place local clock math lives. Ages derive
 * from `createdAt`/`updatedAt` timestamps and re-render on a 30 s ticker;
 * nothing here ever polls the API (brief rule 8).
 */

/** "2h 3m", "41m", "3d", "just now" — the board's card ages. */
export function formatAge(now: number, then: number): string {
  const diff = Math.max(0, now - then)
  const seconds = Math.floor(diff / 1000)
  if (seconds < 60) return seconds <= 5 ? "just now" : `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ${minutes % 60}m`
  const days = Math.floor(hours / 24)
  return `${days}d`
}

/** "13:04:22" local — log-line clock. */
export function formatClock(epochMs: number): string {
  const d = new Date(epochMs)
  const pad = (n: number): string => String(n).padStart(2, "0")
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

/** Full local date-time, e.g. run starts in the runs list. */
export function formatDateTime(epochMs: number): string {
  const d = new Date(epochMs)
  return `${d.toLocaleDateString()} ${formatClock(epochMs)}`
}
