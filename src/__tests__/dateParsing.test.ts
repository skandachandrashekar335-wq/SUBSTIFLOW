/**
 * Regression tests for date parsing.
 *
 * Two real bugs shipped behind these helpers:
 *  - SQLite `datetime('now')` writes UTC timestamps WITHOUT a zone marker
 *    ("2026-10-12 08:00:00"); `new Date(...)` parses that as *local* time, so
 *    every generation timestamp displayed 5½ hours ahead for an Indian
 *    college (any offset from UTC, in either direction).
 *  - `new Date('2026-10-12')` parses the calendar date as UTC midnight, so
 *    west of UTC the Attendance header showed the PREVIOUS day and the
 *    monthly report covered the previous month.
 *
 * Assertions are timezone-independent: UTC-instants compare via
 * toISOString(), local values via date/time components.
 */
import { describe, it, expect } from 'vitest'
import { parseDbTimestamp, parseISODate, todayISO } from '@/utils/date'

describe('parseDbTimestamp', () => {
  it('treats a zone-less SQLite timestamp as the UTC instant it is', () => {
    expect(parseDbTimestamp('2026-10-12 08:00:00').toISOString()).toBe('2026-10-12T08:00:00.000Z')
  })

  it('handles the fractional form as well', () => {
    expect(parseDbTimestamp('2026-12-31 23:59:59.500').toISOString()).toBe(
      '2026-12-31T23:59:59.500Z'
    )
  })

  it('passes ISO-8601 values with Z through untouched', () => {
    expect(parseDbTimestamp('2026-10-12T08:00:00.000Z').toISOString()).toBe(
      '2026-10-12T08:00:00.000Z'
    )
  })

  it('respects an explicit offset', () => {
    expect(parseDbTimestamp('2026-10-12T08:00:00+05:30').toISOString()).toBe(
      '2026-10-12T02:30:00.000Z'
    )
  })
})

describe('parseISODate', () => {
  it('parses yyyy-MM-dd as LOCAL midnight (never UTC)', () => {
    const d = parseISODate('2026-10-12')
    expect(d.getFullYear()).toBe(2026)
    expect(d.getMonth()).toBe(9)
    expect(d.getDate()).toBe(12) // the same calendar day in every timezone
    expect(d.getHours()).toBe(0)
    expect(d.getMinutes()).toBe(0)
  })
})

describe('todayISO', () => {
  it('returns the LOCAL calendar date of the given instant', () => {
    const d = new Date(2026, 0, 5, 23, 30) // Jan 5, local, near midnight
    expect(todayISO(d)).toBe('2026-01-05')
  })
})
