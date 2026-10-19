/**
 * Date helpers for `yyyy-MM-dd` strings (the format used by date inputs and by
 * every date column in the database).
 */

/** Zero-pad a number to at least two digits. */
function pad(value: number): string {
  return String(value).padStart(2, '0')
}

/**
 * The local calendar date, e.g. `2026-09-29`.
 *
 * Deliberately not `new Date().toISOString().split('T')[0]`: that returns the
 * *UTC* date, which is already tomorrow (or still yesterday) for anyone outside
 * UTC — a timetable app must show the college's local day.
 */
export function todayISO(date: Date = new Date()): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/**
 * Parse `yyyy-MM-dd` into a local-midnight Date.
 *
 * `new Date('2026-09-29')` is parsed as UTC midnight, so formatting it back in
 * a timezone behind UTC yields the previous day. Passing an explicit local time
 * keeps day arithmetic (±1 day) stable everywhere.
 */
export function parseISODate(value: string): Date {
  return new Date(`${value}T00:00:00`)
}

/**
 * Parse a database timestamp into the correct instant.
 *
 * Two writers coexist: `datetime('now')` (UTC, `YYYY-MM-DD HH:MM:SS`, no zone
 * marker) and `new Date().toISOString()` (ISO-8601 with `Z`). V8 parses the
 * zone-less SQLite form as *local* time, so rendering it directly shows times
 * shifted by the offset from UTC (5½ hours in the future for an Indian
 * college). Zone-less values are therefore completed with `Z` — SQLite wrote
 * them in UTC — while already-zoned values pass through untouched.
 */
export function parseDbTimestamp(value: string): Date {
  if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(value)) {
    return new Date(`${value.replace(' ', 'T')}Z`)
  }
  return new Date(value)
}
