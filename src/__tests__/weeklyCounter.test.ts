/**
 * Weekly session & section capacity counter tests.
 *
 * Tests both:
 *  1. Preserved legacy weeklySessionCounter (backward compatibility).
 *  2. Section-wise capacity calculation (36 periods/section, 216 total across 6 sections,
 *     distinguishing sessions from span-weighted periods, TEAM vs ALTERNATE teaching).
 */
import { describe, it, expect } from 'vitest'
import {
  WEEKLY_SESSION_CAPACITY,
  DEFAULT_PERIODS_PER_SECTION,
  weeklySessionCounter,
  calculateSectionCapacities,
} from '@/utils/weeklyCapacity'

const rows = (...sessions: number[]) => sessions.map((s) => ({ requiredSessionsPerWeek: s }))

describe('weeklySessionCounter (legacy backward-compatible)', () => {
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
    const c = weeklySessionCounter(rows(10, 10, 10, 10))
    expect(c.allocated).toBe(40)
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

describe('calculateSectionCapacities (section-wise timetable capacity)', () => {
  const sections = [
    { id: 'sec-i-a', name: 'I BCA A', semester: 1 },
    { id: 'sec-i-b', name: 'I BCA B', semester: 1 },
    { id: 'sec-iii-a', name: 'III BCA A', semester: 3 },
    { id: 'sec-iii-b', name: 'III BCA B', semester: 3 },
    { id: 'sec-v-a', name: 'V BCA A', semester: 5 },
    { id: 'sec-v-b', name: 'V BCA B', semester: 5 },
  ]

  it('default capacity per section is 36 periods, total capacity for 6 sections is 216', () => {
    expect(DEFAULT_PERIODS_PER_SECTION).toBe(36)
    const result = calculateSectionCapacities({ sections })
    expect(result.totalCapacity).toBe(216)
    expect(result.totalAllocatedPeriods).toBe(0)
    expect(result.remainingPeriods).toBe(216)
    expect(result.sections).toHaveLength(6)
    for (const s of result.sections) {
      expect(s.weeklyCapacity).toBe(36)
      expect(s.remainingPeriods).toBe(36)
      expect(s.isOverCapacity).toBe(false)
    }
  })

  it('correctly weights spans: 1 session lab with span 2 occupies 2 periods', () => {
    const requirements = [
      { sectionId: 'sec-i-a', subjectId: 'sub-dms', classType: 'LECTURE', requiredSessionsPerWeek: 4, span: 1 },
      { sectionId: 'sec-i-a', subjectId: 'sub-lab', classType: 'LAB', requiredSessionsPerWeek: 1, span: 2 },
    ]
    const result = calculateSectionCapacities({ sections: [sections[0]], requirements })
    const sec = result.sections[0]
    expect(sec.allocatedSessions).toBe(5) // 4 + 1
    expect(sec.allocatedPeriods).toBe(6) // 4*1 + 1*2
    expect(sec.remainingPeriods).toBe(30) // 36 - 6
  })

  it('TEAM teaching does not double-count periods for the section', () => {
    // ML & NN has 2 faculty allocated, but requirement is 3 sessions with span 1
    const requirements = [
      { sectionId: 'sec-v-a', subjectId: 'sub-ml', classType: 'LECTURE', requiredSessionsPerWeek: 3, span: 1, teachingArrangement: 'TEAM' },
    ]
    const allocations = [
      { sectionId: 'sec-v-a', subjectId: 'sub-ml', classType: 'LECTURE', facultyId: 'f1', requiredSessionsPerWeek: 3 },
      { sectionId: 'sec-v-a', subjectId: 'sub-ml', classType: 'LECTURE', facultyId: 'f2', requiredSessionsPerWeek: 3 },
    ]
    const result = calculateSectionCapacities({ sections: [sections[4]], requirements, allocations })
    const sec = result.sections[0]
    expect(sec.allocatedSessions).toBe(3) // 3 sessions, NOT 6
    expect(sec.allocatedPeriods).toBe(3) // 3 periods, NOT 6
    expect(sec.remainingPeriods).toBe(33)
  })

  it('allocations take precedence over requirements when allocations array is provided', () => {
    const requirements = [
      { sectionId: 'sec-i-a', subjectId: 'sub-dms', classType: 'LECTURE', requiredSessionsPerWeek: 4, span: 1 },
    ]

    // 0 allocations provided even though requirement exists
    const emptyResult = calculateSectionCapacities({
      sections: [sections[0]],
      requirements,
      allocations: [],
    })
    expect(emptyResult.sections[0].allocatedSessions).toBe(0)
    expect(emptyResult.sections[0].allocatedPeriods).toBe(0)
    expect(emptyResult.sections[0].remainingPeriods).toBe(36)

    // 2 sessions allocated so far
    const partialResult = calculateSectionCapacities({
      sections: [sections[0]],
      requirements,
      allocations: [
        { sectionId: 'sec-i-a', subjectId: 'sub-dms', classType: 'LECTURE', facultyId: 'f1', requiredSessionsPerWeek: 2 },
      ],
    })
    expect(partialResult.sections[0].allocatedSessions).toBe(2)
    expect(partialResult.sections[0].allocatedPeriods).toBe(2)
    expect(partialResult.sections[0].remainingPeriods).toBe(34)

    // When allocations parameter is undefined, requirements are used as the demand baseline
    const fallbackResult = calculateSectionCapacities({
      sections: [sections[0]],
      requirements,
    })
    expect(fallbackResult.sections[0].allocatedSessions).toBe(4)
    expect(fallbackResult.sections[0].allocatedPeriods).toBe(4)
    expect(fallbackResult.sections[0].remainingPeriods).toBe(32)
  })

  it('calculates realistic demo fixture numbers (124 sessions, 140 periods, 76 remaining out of 216)', () => {
    // Sem 1 (A & B): 20 sessions, 23 periods each
    // Sem 3 (A & B): 21 sessions, 24 periods each
    // Sem 5 (A & B): 21 sessions, 23 periods each
    const requirements = [
      // I BCA A
      { sectionId: 'sec-i-a', requiredSessionsPerWeek: 4, span: 1 },
      { sectionId: 'sec-i-a', requiredSessionsPerWeek: 4, span: 1 },
      { sectionId: 'sec-i-a', requiredSessionsPerWeek: 4, span: 1 },
      { sectionId: 'sec-i-a', requiredSessionsPerWeek: 3, span: 1 },
      { sectionId: 'sec-i-a', requiredSessionsPerWeek: 1, span: 2 },
      { sectionId: 'sec-i-a', requiredSessionsPerWeek: 1, span: 2 },
      { sectionId: 'sec-i-a', requiredSessionsPerWeek: 1, span: 2 },
      { sectionId: 'sec-i-a', requiredSessionsPerWeek: 2, span: 1 },
      // I BCA B
      { sectionId: 'sec-i-b', requiredSessionsPerWeek: 4, span: 1 },
      { sectionId: 'sec-i-b', requiredSessionsPerWeek: 4, span: 1 },
      { sectionId: 'sec-i-b', requiredSessionsPerWeek: 4, span: 1 },
      { sectionId: 'sec-i-b', requiredSessionsPerWeek: 3, span: 1 },
      { sectionId: 'sec-i-b', requiredSessionsPerWeek: 1, span: 2 },
      { sectionId: 'sec-i-b', requiredSessionsPerWeek: 1, span: 2 },
      { sectionId: 'sec-i-b', requiredSessionsPerWeek: 1, span: 2 },
      { sectionId: 'sec-i-b', requiredSessionsPerWeek: 2, span: 1 },
      // III BCA A
      { sectionId: 'sec-iii-a', requiredSessionsPerWeek: 4, span: 1 },
      { sectionId: 'sec-iii-a', requiredSessionsPerWeek: 4, span: 1 },
      { sectionId: 'sec-iii-a', requiredSessionsPerWeek: 3, span: 1 },
      { sectionId: 'sec-iii-a', requiredSessionsPerWeek: 3, span: 1 },
      { sectionId: 'sec-iii-a', requiredSessionsPerWeek: 2, span: 1 },
      { sectionId: 'sec-iii-a', requiredSessionsPerWeek: 1, span: 2 },
      { sectionId: 'sec-iii-a', requiredSessionsPerWeek: 1, span: 2 },
      { sectionId: 'sec-iii-a', requiredSessionsPerWeek: 1, span: 2 },
      { sectionId: 'sec-iii-a', requiredSessionsPerWeek: 2, span: 1 },
      // III BCA B
      { sectionId: 'sec-iii-b', requiredSessionsPerWeek: 4, span: 1 },
      { sectionId: 'sec-iii-b', requiredSessionsPerWeek: 4, span: 1 },
      { sectionId: 'sec-iii-b', requiredSessionsPerWeek: 3, span: 1 },
      { sectionId: 'sec-iii-b', requiredSessionsPerWeek: 3, span: 1 },
      { sectionId: 'sec-iii-b', requiredSessionsPerWeek: 2, span: 1 },
      { sectionId: 'sec-iii-b', requiredSessionsPerWeek: 1, span: 2 },
      { sectionId: 'sec-iii-b', requiredSessionsPerWeek: 1, span: 2 },
      { sectionId: 'sec-iii-b', requiredSessionsPerWeek: 1, span: 2 },
      { sectionId: 'sec-iii-b', requiredSessionsPerWeek: 2, span: 1 },
      // V BCA A
      { sectionId: 'sec-v-a', requiredSessionsPerWeek: 3, span: 1 },
      { sectionId: 'sec-v-a', requiredSessionsPerWeek: 3, span: 1 },
      { sectionId: 'sec-v-a', requiredSessionsPerWeek: 2, span: 1 },
      { sectionId: 'sec-v-a', requiredSessionsPerWeek: 2, span: 1 },
      { sectionId: 'sec-v-a', requiredSessionsPerWeek: 2, span: 1 },
      { sectionId: 'sec-v-a', requiredSessionsPerWeek: 3, span: 1 },
      { sectionId: 'sec-v-a', requiredSessionsPerWeek: 2, span: 1 },
      { sectionId: 'sec-v-a', requiredSessionsPerWeek: 2, span: 1 },
      { sectionId: 'sec-v-a', requiredSessionsPerWeek: 1, span: 2 },
      { sectionId: 'sec-v-a', requiredSessionsPerWeek: 1, span: 2 },
      // V BCA B
      { sectionId: 'sec-v-b', requiredSessionsPerWeek: 3, span: 1 },
      { sectionId: 'sec-v-b', requiredSessionsPerWeek: 3, span: 1 },
      { sectionId: 'sec-v-b', requiredSessionsPerWeek: 2, span: 1 },
      { sectionId: 'sec-v-b', requiredSessionsPerWeek: 2, span: 1 },
      { sectionId: 'sec-v-b', requiredSessionsPerWeek: 2, span: 1 },
      { sectionId: 'sec-v-b', requiredSessionsPerWeek: 3, span: 1 },
      { sectionId: 'sec-v-b', requiredSessionsPerWeek: 2, span: 1 },
      { sectionId: 'sec-v-b', requiredSessionsPerWeek: 2, span: 1 },
      { sectionId: 'sec-v-b', requiredSessionsPerWeek: 1, span: 2 },
      { sectionId: 'sec-v-b', requiredSessionsPerWeek: 1, span: 2 },
    ]

    const result = calculateSectionCapacities({ sections, requirements })
    expect(result.totalAllocatedSessions).toBe(124)
    expect(result.totalAllocatedPeriods).toBe(140)
    expect(result.totalCapacity).toBe(216)
    expect(result.remainingPeriods).toBe(76)
    expect(result.isOverCapacity).toBe(false)

    // Check individual section loads
    const sec1a = result.sections.find((s) => s.sectionId === 'sec-i-a')!
    expect(sec1a.allocatedSessions).toBe(20)
    expect(sec1a.allocatedPeriods).toBe(23)
    expect(sec1a.remainingPeriods).toBe(13)

    const sec3a = result.sections.find((s) => s.sectionId === 'sec-iii-a')!
    expect(sec3a.allocatedSessions).toBe(21)
    expect(sec3a.allocatedPeriods).toBe(24)
    expect(sec3a.remainingPeriods).toBe(12)

    const sec5a = result.sections.find((s) => s.sectionId === 'sec-v-a')!
    expect(sec5a.allocatedSessions).toBe(21)
    expect(sec5a.allocatedPeriods).toBe(23)
    expect(sec5a.remainingPeriods).toBe(13)
  })

  it('correctly flags over-capacity sections', () => {
    const requirements = [
      { sectionId: 'sec-i-a', requiredSessionsPerWeek: 38, span: 1 },
    ]
    const result = calculateSectionCapacities({ sections: [sections[0]], requirements })
    const sec = result.sections[0]
    expect(sec.isOverCapacity).toBe(true)
    expect(sec.exceededBy).toBe(2)
    expect(sec.remainingPeriods).toBe(0)
  })
})
