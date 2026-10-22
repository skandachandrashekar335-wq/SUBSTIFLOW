/**
 * Timetable capacity and weekly allocation counter.
 *
 * Capacity is defined PER SECTION:
 * Under the default configuration: 6 working days x 6 teaching periods
 * = 36 periods per section per week.
 *
 * For all 6 configured sections (I BCA A/B, III BCA A/B, V BCA A/B),
 * aggregate capacity is 6 x 36 = 216 periods per week.
 *
 * Distinction between sessions and periods:
 *  - A lecture lasting 1 period counts as 1 session and occupies 1 period.
 *  - A laboratory lasting 2 periods counts as 1 session but occupies 2 periods.
 *  - A TEAM-taught session (e.g. 2 faculty in the same room) is 1 section activity
 *    and occupies periods corresponding to its span (not 2x).
 *  - An ALTERNATING session (e.g. 2 sessions for Faculty A and 1 session for Faculty B)
 *    is 3 sessions and occupies 3 periods.
 */

export const WEEKLY_SESSION_CAPACITY = 36
export const DEFAULT_PERIODS_PER_SECTION = 36

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

export interface SectionCapacity {
  sectionId: string
  sectionName: string
  semester: number
  allocatedSessions: number
  allocatedPeriods: number
  weeklyCapacity: number
  remainingPeriods: number
  isOverCapacity: boolean
  exceededBy: number
  utilizationPercent: number
}

export interface TimetableCapacitySummary {
  sections: SectionCapacity[]
  totalAllocatedSessions: number
  totalAllocatedPeriods: number
  totalCapacity: number
  remainingPeriods: number
  isOverCapacity: boolean
  exceededBy: number
  utilizationPercent: number
}

export interface SectionSpecInput {
  id: string
  name: string
  semester: number
}

export interface RequirementSpecInput {
  sectionId: string
  subjectId?: string
  classType?: string
  requiredSessionsPerWeek: number
  span?: number
  teachingArrangement?: string
}

export interface AllocationSpecInput {
  sectionId: string
  subjectId: string
  classType: string
  facultyId: string
  requiredSessionsPerWeek: number
}

/**
 * Calculate capacity metrics per section and in aggregate.
 *
 * Correctly distinguishes sessions from span-weighted periods:
 * - Each lecture (span 1) = 1 session, 1 period
 * - Each lab (span 2) = 1 session, 2 periods
 * - TEAM teaching: faculty share the session, so section activity demand is 1x
 * - ALTERNATE teaching: faculty split sessions, demand is sum of sessions
 */
export function calculateSectionCapacities(params: {
  sections: SectionSpecInput[]
  requirements?: RequirementSpecInput[]
  allocations?: AllocationSpecInput[]
  periodsPerSection?: number
}): TimetableCapacitySummary {
  const {
    sections,
    requirements = [],
    allocations = [],
    periodsPerSection = DEFAULT_PERIODS_PER_SECTION,
  } = params

  const reqMap = new Map<string, RequirementSpecInput>()
  for (const r of requirements) {
    if (r.subjectId && r.classType) {
      reqMap.set(`${r.sectionId}|${r.subjectId}|${r.classType}`, r)
    }
  }

  const sectionCapacities: SectionCapacity[] = sections.map((sec) => {
    let allocatedSessions = 0
    let allocatedPeriods = 0

    const secReqs = requirements.filter((r) => r.sectionId === sec.id)

    if (secReqs.length > 0) {
      // Requirements are authoritative for section demand and span
      for (const req of secReqs) {
        const sessions = Number(req.requiredSessionsPerWeek) || 0
        const span = Math.max(1, Number(req.span) || (req.classType === 'LAB' ? 2 : 1))
        allocatedSessions += sessions
        allocatedPeriods += sessions * span
      }
    } else {
      // Fallback: derive from allocations grouped by activity
      const secAllocs = allocations.filter((a) => a.sectionId === sec.id)
      const activityMap = new Map<string, AllocationSpecInput[]>()
      for (const a of secAllocs) {
        const key = `${a.subjectId}|${a.classType}`
        const list = activityMap.get(key) ?? []
        list.push(a)
        activityMap.set(key, list)
      }

      for (const [, allocList] of activityMap) {
        const first = allocList[0]
        const req = reqMap.get(`${sec.id}|${first.subjectId}|${first.classType}`)
        const span = req?.span ?? (first.classType === 'LAB' ? 2 : 1)
        const arrangement = req?.teachingArrangement ?? (allocList.length > 1 ? 'TEAM' : 'AUTO')

        let sessions = 0
        if (arrangement === 'TEAM') {
          // In team teaching, all faculty teach the same session simultaneously
          sessions = Number(first.requiredSessionsPerWeek) || 1
        } else {
          // In alternate or individual teaching, sessions are summed
          sessions = allocList.reduce((s, a) => s + (Number(a.requiredSessionsPerWeek) || 0), 0)
        }

        allocatedSessions += sessions
        allocatedPeriods += sessions * span
      }
    }

    const weeklyCapacity = periodsPerSection
    const isOver = allocatedPeriods > weeklyCapacity
    const remainingPeriods = isOver ? 0 : weeklyCapacity - allocatedPeriods
    const exceededBy = isOver ? allocatedPeriods - weeklyCapacity : 0
    const utilizationPercent = weeklyCapacity > 0
      ? Math.round((allocatedPeriods / weeklyCapacity) * 1000) / 10
      : 0

    return {
      sectionId: sec.id,
      sectionName: sec.name,
      semester: sec.semester,
      allocatedSessions,
      allocatedPeriods,
      weeklyCapacity,
      remainingPeriods,
      isOverCapacity: isOver,
      exceededBy,
      utilizationPercent,
    }
  })

  const totalAllocatedSessions = sectionCapacities.reduce((s, c) => s + c.allocatedSessions, 0)
  const totalAllocatedPeriods = sectionCapacities.reduce((s, c) => s + c.allocatedPeriods, 0)
  const totalCapacity = sections.length * periodsPerSection
  const totalOver = totalAllocatedPeriods > totalCapacity
  const remainingPeriods = totalOver ? 0 : totalCapacity - totalAllocatedPeriods
  const exceededBy = totalOver ? totalAllocatedPeriods - totalCapacity : 0
  const utilizationPercent = totalCapacity > 0
    ? Math.round((totalAllocatedPeriods / totalCapacity) * 1000) / 10
    : 0

  return {
    sections: sectionCapacities,
    totalAllocatedSessions,
    totalAllocatedPeriods,
    totalCapacity,
    remainingPeriods,
    isOverCapacity: totalOver,
    exceededBy,
    utilizationPercent,
  }
}
