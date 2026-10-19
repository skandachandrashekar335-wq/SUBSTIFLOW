/**
 * Weekly session counter (Teaching Allocations card header).
 *
 * Pins the product spec: capacity 36, allocated total = sum of the persisted
 * allocation rows (each teacher's own row counts once — multi-teacher
 * activities are NOT double-counted against their requirement), true total
 * shown over capacity with an explicit exceeded indication.
 */
import { describe, it, expect } from 'vitest'
import { WEEKLY_SESSION_CAPACITY, weeklySessionCounter } from '@/utils/weeklyCapacity'

const rows = (...sessions: number[]) => sessions.map((s) => ({ requiredSessionsPerWeek: s }))

describe('weeklySessionCounter', () => {
  it('capacity is the specified 36 sessions/week', () => {
    expect(WEEKLY_SESSION_CAPACITY).toBe(36)
  })

  it('0 allocated → 0 / 36 with all 36 remaining', () => {
    const c = weeklySessionCounter([])
    expect(c).toEqual({ allocated: 0, capacity: 36, remaining: 36, exceededBy: null })
  })

  it('3 allocated → 33 remaining', () => {
    const c = weeklySessionCounter(rows(2, 1))
    expect(c.allocated).toBe(3)
    expect(c.remaining).toBe(33)
    expect(c.exceededBy).toBeNull()
  })

  it('7 allocated → 29 remaining (the spec example)', () => {
    const c = weeklySessionCounter(rows(2, 1, 1, 1, 1, 1))
    expect(c.allocated).toBe(7)
    expect(c.remaining).toBe(29)
  })

  it('multi-teacher activity: each faculty row counts once, requirement not added on top', () => {
    // CS101 LECTURE with Asha (2) + Binu (1) = 3 allocated; the matching
    // subject requirement (e.g. 2 sessions/week) must NOT be summed too.
    const c = weeklySessionCounter(rows(2, 1))
    expect(c.allocated).toBe(3)
  })

  it('exactly at capacity → 36 / 36, 0 remaining, not exceeded', () => {
    const c = weeklySessionCounter(rows(10, 10, 10, 6))
    expect(c.allocated).toBe(36)
    expect(c.remaining).toBe(0)
    expect(c.exceededBy).toBeNull()
  })

  it('over capacity → true total shown, exceededBy reported, remaining withheld', () => {
    const c = weeklySessionCounter(rows(10, 10, 10, 10)) // 40 via the real dialog
    expect(c.allocated).toBe(40) // never capped
    expect(c.exceededBy).toBe(4)
    expect(c.remaining).toBeNull()
  })

  it('tolerates rows with null/undefined session counts', () => {
    const c = weeklySessionCounter([
      { requiredSessionsPerWeek: 3 },
      { requiredSessionsPerWeek: null },
      { requiredSessionsPerWeek: undefined },
    ])
    expect(c.allocated).toBe(3)
  })
})
