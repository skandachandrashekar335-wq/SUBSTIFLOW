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
