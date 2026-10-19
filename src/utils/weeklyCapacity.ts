/**
 * Weekly allocation counter shown in the "Allocations by Section & Subject"
 * card header on the Teaching Allocations page.
 *
 * Capacity is the weekly timetable grid: 6 working days x 6 teaching periods
 * = 36 sessions — the same figure the generator's diagnostics report as
 * "periods available" on a default configuration (see timetableGenerator's
 * capacityPerSection). It is a product constant by specification; deriving it
 * dynamically from Settings (working days x teaching slots) would be a
 * one-line change later if wanted.
 *
 * The allocated total sums the PERSISTED teaching-allocation rows'
 * required_sessions_per_week — each faculty member's own row counts exactly
 * once. That is the app's existing multi-teacher model: the grouped table's
 * per-activity totalRequiredSessions and the "Sessions/Week Required" stat
 * card sum the same rows. Subject requirements are NOT added on top, so a
 * requirement shared by several teachers is never double-counted, and
 * timetable generation is unaffected (the generator reads the requirement
 * and the allocation rows themselves, never this summary).
 */

export const WEEKLY_SESSION_CAPACITY = 36

export interface WeeklySessionCounter {
  /** Total sessions/week across all persisted allocation rows (uncapped). */
  allocated: number
  capacity: number
  /** Sessions still free this week; null while over capacity. */
  remaining: number | null
  /** How far over capacity the allocations run; null while within capacity. */
  exceededBy: number | null
}

export function weeklySessionCounter(
  allocations: Array<{ requiredSessionsPerWeek?: number | null }>,
  capacity: number = WEEKLY_SESSION_CAPACITY
): WeeklySessionCounter {
  const allocated = allocations.reduce((sum, a) => {
    const sessions = a.requiredSessionsPerWeek
    return sum + (typeof sessions === 'number' && Number.isFinite(sessions) ? sessions : 0)
  }, 0)
  const over = allocated > capacity
  return {
    allocated,
    capacity,
    remaining: over ? null : capacity - allocated,
    exceededBy: over ? allocated - capacity : null,
  }
}
