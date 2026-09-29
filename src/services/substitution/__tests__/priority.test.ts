/**
 * Substitution priority hierarchy (P1–P5), applied after the hard constraints:
 *
 *  P1 — normally teaches the affected section/class
 *  P2 — normally teaches the same semester/year
 *  P3 — same department and normally teaches another section
 *  P4 — otherwise related (subject qualification, class history, department)
 *  P5 — unrelated faculty (only when configuration permits it)
 *
 * Class familiarity must outrank subject qualification across tiers, while the
 * configurable weights still decide the ranking *within* a tier.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import { schema } from '@/db/schema'
import { facultyRepository } from '@/db/repositories/faculty'
import { subjectRepository } from '@/db/repositories/subject'
import { sectionRepository } from '@/db/repositories/section'
import { timetableEntryRepository } from '@/db/repositories/timetableEntry'
import { timeSlotRepository } from '@/db/repositories/timeSlot'
import { academicYearRepository } from '@/db/repositories/academicYear'
import { departmentRepository } from '@/db/repositories/department'
import { settingsRepository } from '@/db/repositories/settings'
import { buildFacultyAvailability, solveSubstitutionProblem } from '@/services/substitution/engine'
import { getEligibleCandidates } from '@/services/substitution/scoring'
import { DEFAULT_SUBSTITUTION_WEIGHTS } from '@/types'
import type { TimetableEntryWithRelations } from '@/types'
import type { SubstitutionProblem } from '../types'

let testDb: Database.Database

const YEAR = 'year-2024'
const DATE = '2024-09-25' // Wednesday

vi.mock('@/db/database', () => ({
  getDatabase: () => testDb,
  transaction: <T,>(fn: (db: unknown) => T): T => fn(testDb),
  closeDatabase: () => undefined,
  backupDatabase: () => undefined,
  restoreDatabase: () => undefined,
}))

function setupTestDb(): void {
  if (testDb) testDb.close()
  testDb = new Database(':memory:')
  testDb.pragma('foreign_keys = ON')
  testDb.exec(schema)

  departmentRepository.create({ id: 'dept-bca', name: 'BCA', code: 'BCA' })
  departmentRepository.create({ id: 'dept-lang', name: 'Languages', code: 'LANG' })
  academicYearRepository.create({
    id: YEAR,
    name: '2024-2025',
    startDate: '2024-06-01',
    endDate: '2025-05-31',
    isActive: false,
  })
  academicYearRepository.setActive(YEAR)
  timeSlotRepository.initializeDefaults()

  // Sections: the affected class (III BCA-B, sem 3), a sibling (III BCA-A,
  // sem 3) and a later-semester class (V BCA, sem 5).
  for (const [id, name, semester] of [
    ['sec-3b', 'III BCA-B', 3],
    ['sec-3a', 'III BCA-A', 3],
    ['sec-5b', 'V BCA', 5],
  ] as [string, string, number][]) {
    sectionRepository.create({ id, name, semester, departmentId: 'dept-bca', academicYearId: YEAR })
  }

  subjectRepository.create({ id: 'sub-english', name: 'General English', code: 'ENG', departmentId: 'dept-lang', defaultClassType: 'LECTURE' })
  subjectRepository.create({ id: 'sub-math', name: 'Mathematics', code: 'MTH', departmentId: 'dept-bca', defaultClassType: 'LECTURE' })

  const faculty: [string, string, string][] = [
    ['fac-absent', 'Ms. English', 'dept-bca'],
    ['fac-rel1', 'Mr. X', 'dept-bca'],       // P1: teaches the affected class (maths)
    ['fac-sem', 'Mr. Sem', 'dept-bca'],      // P2: teaches another class of the same semester
    ['fac-dept', 'Mrs. Dept', 'dept-bca'],   // P3: same department, other semester
    ['fac-subj', 'Dr. English-Other', 'dept-lang'], // P4: qualified for the subject, unrelated class
    ['fac-unrelated', 'Ms. Stranger', 'dept-lang'], // P5: no relationship at all
  ]
  for (const [id, name, departmentId] of faculty) {
    facultyRepository.create({
      id,
      name,
      employeeId: id.toUpperCase(),
      departmentId,
      isActive: true,
      maxDailySubstitutions: 2,
      priority: 0,
    })
  }

  // Class/subject relationships — deliberately: the P1 teacher is NOT
  // qualified for the absent subject (English); the P4 teacher is.
  facultyRepository.setSections('fac-rel1', ['sec-3b'])
  facultyRepository.setSubjects('fac-rel1', [{ facultyId: 'fac-rel1', subjectId: 'sub-math', proficiency: 5 }])
  facultyRepository.setSections('fac-sem', ['sec-3a'])
  facultyRepository.setSubjects('fac-sem', [{ facultyId: 'fac-sem', subjectId: 'sub-math', proficiency: 5 }])
  facultyRepository.setSections('fac-dept', ['sec-5b'])
  facultyRepository.setSubjects('fac-subj', [{ facultyId: 'fac-subj', subjectId: 'sub-english', proficiency: 5 }])

  testDb.prepare('INSERT INTO rooms (id, name, capacity, type) VALUES (?, ?, ?, ?)').run('room-1', 'Room 1', 60, 'CLASSROOM')

  // The one affected class: Wednesday slot-1, III BCA-B, General English.
  timetableEntryRepository.create({
    id: 'tt-absent',
    academicYearId: YEAR,
    dayOfWeek: 'WEDNESDAY',
    timeSlotId: 'slot-1',
    sectionId: 'sec-3b',
    subjectId: 'sub-english',
    facultyId: 'fac-absent',
    roomId: 'room-1',
    classType: 'LECTURE',
  })
}

function affectedEntry(): TimetableEntryWithRelations {
  const entry = timetableEntryRepository.getWithRelations(YEAR).find(e => e.id === 'tt-absent')
  if (!entry) throw new Error('fixture entry missing')
  return entry
}

function candidateIds(absent: string[] = ['fac-absent']): string[] {
  const availability = buildFacultyAvailability(
    DATE,
    YEAR,
    timeSlotRepository.getOrdered(),
    new Set(absent)
  )
  return getEligibleCandidates(
    affectedEntry(),
    facultyRepository.findActive(),
    availability,
    DEFAULT_SUBSTITUTION_WEIGHTS,
    { absentFacultyIds: new Set(absent), lockedAssignments: new Map() }
  ).map(c => c.faculty.id)
}

function solve(absent: string[]): ReturnType<typeof solveSubstitutionProblem> {
  const problem: SubstitutionProblem = {
    date: DATE,
    absentFacultyIds: absent,
    affectedEntries: [affectedEntry()],
    allFaculty: facultyRepository.findActive(),
    timeSlots: timeSlotRepository.getOrdered(),
    weights: DEFAULT_SUBSTITUTION_WEIGHTS,
    maxDailySubstitutions: 2,
  }
  return solveSubstitutionProblem(problem)
}

describe('substitution priority hierarchy', () => {
  beforeEach(setupTestDb)

  it('9. a teacher of the same class outranks an unrelated free teacher', () => {
    const ids = candidateIds()
    expect(ids[0]).toBe('fac-rel1')
    expect(ids).toContain('fac-unrelated')
    expect(ids.indexOf('fac-rel1')).toBeLessThan(ids.indexOf('fac-unrelated'))
  })

  it('10. same-class teacher from a different subject outranks the subject-qualified stranger', () => {
    const ids = candidateIds()
    // fac-rel1 teaches III BCA-B but is only qualified for Maths;
    // fac-subj is qualified for General English but has no link to the class.
    expect(ids.indexOf('fac-rel1')).toBeLessThan(ids.indexOf('fac-subj'))
    expect(ids.indexOf('fac-rel1')).toBe(0)

    const availability = buildFacultyAvailability(DATE, YEAR, timeSlotRepository.getOrdered(), new Set(['fac-absent']))
    const candidates = getEligibleCandidates(
      affectedEntry(),
      facultyRepository.findActive(),
      availability,
      DEFAULT_SUBSTITUTION_WEIGHTS,
      { absentFacultyIds: new Set(['fac-absent']), lockedAssignments: new Map() }
    )
    const p1 = candidates[0]
    expect(p1.priorityTier).toBe(1)
    expect(p1.reasons.some(r => r.includes('Normally teaches III BCA-B'))).toBe(true)
    expect(p1.reasons.some(r => r.includes('P1'))).toBe(true)
    expect(p1.reasons.some(r => r.includes('Qualified for General English'))).toBe(false)
    const stranger = candidates.find(c => c.faculty.id === 'fac-subj')!
    expect(stranger.priorityTier).toBe(4)
    expect(stranger.reasons.some(r => r.includes('Qualified for General English'))).toBe(true)
  })

  it('11. a same-semester teacher is considered first when no same-class teacher exists', () => {
    const ids = candidateIds(['fac-absent', 'fac-rel1'])
    expect(ids[0]).toBe('fac-sem')
  })

  it('12. a same-department teacher is considered next', () => {
    const ids = candidateIds(['fac-absent', 'fac-rel1', 'fac-sem'])
    expect(ids[0]).toBe('fac-dept')
    expect(ids.indexOf('fac-dept')).toBeLessThan(ids.indexOf('fac-subj'))
    expect(ids.indexOf('fac-dept')).toBeLessThan(ids.indexOf('fac-unrelated'))
  })

  it('13. unrelated faculty are considered only when related candidates are unavailable and configuration permits it', () => {
    // a) Configuration ON (default): unrelated faculty is present but ranked last.
    expect(settingsRepository.getAllowUnrelatedSubstitutions()).toBe(true)
    const allowed = candidateIds()
    expect(allowed).toContain('fac-unrelated')
    expect(allowed[allowed.length - 1]).toBe('fac-unrelated')

    // b) Configuration ON and every related teacher gone → the stranger is used.
    const allRelatedAbsent = ['fac-absent', 'fac-rel1', 'fac-sem', 'fac-dept', 'fac-subj']
    const solvedOn = solve(allRelatedAbsent)
    expect(solvedOn.assignments).toHaveLength(1)
    expect(solvedOn.assignments[0].substituteFacultyId).toBe('fac-unrelated')

    // c) Configuration OFF → P5 disappears entirely from the candidate list…
    settingsRepository.setAllowUnrelatedSubstitutions(false)
    const denied = candidateIds()
    expect(denied).not.toContain('fac-unrelated')
    expect(denied).toContain('fac-rel1')
    // …and with no related candidate left the class stays uncovered.
    const solvedOff = solve(allRelatedAbsent)
    expect(solvedOff.assignments).toHaveLength(0)
    expect(solvedOff.uncovered).toHaveLength(1)
    expect(solvedOff.uncovered[0].reason).toContain('No eligible faculty available')
  })

  it('the chosen substitute is explained, including when class familiarity beat a subject-qualified teacher', () => {
    const result = solve(['fac-absent'])
    expect(result.assignments).toHaveLength(1)
    expect(result.assignments[0].substituteFacultyId).toBe('fac-rel1')
    const reasoning = result.assignments[0].reasoning
    expect(reasoning).toContain('Normally teaches III BCA-B')
    expect(reasoning).toContain('P1')
    expect(reasoning).toContain('Class familiarity (P1) prioritized over 1 subject-qualified candidate')
  })

  it('hard constraints still dominate: the absent teacher is never chosen', () => {
    const ids = candidateIds()
    expect(ids).not.toContain('fac-absent')
  })
})
