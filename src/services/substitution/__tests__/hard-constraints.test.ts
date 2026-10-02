import { describe, it, expect, beforeEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import { schema } from '@/db/schema'
import { facultyRepository } from '@/db/repositories/faculty'
import { subjectRepository } from '@/db/repositories/subject'
import { sectionRepository } from '@/db/repositories/section'
import { timetableEntryRepository } from '@/db/repositories/timetableEntry'
import { attendanceRepository } from '@/db/repositories/attendance'
import { timeSlotRepository } from '@/db/repositories/timeSlot'
import { academicYearRepository } from '@/db/repositories/academicYear'
import { departmentRepository } from '@/db/repositories/department'
import { buildFacultyAvailability, solveSubstitutionProblem } from '@/services/substitution/engine'
import { getEligibleCandidates } from '@/services/substitution/scoring'
import { updateSubstitutionAssignment, availableSubstitutesForAssignment } from '@/services/substitution'
import { DEFAULT_SUBSTITUTION_WEIGHTS } from '@/types'
import type { TimetableEntryWithRelations } from '@/types'
import type { SubstitutionProblem } from '../types'

/**
 * Hard-constraint audit.
 *
 * The main engine suite covers the generated plan. These tests cover the paths
 * that write assignments *outside* generation — the manual override — plus the
 * eligibility question: is any active faculty structurally excluded from ever
 * being considered?
 */

let testDb: Database.Database

const YEAR = 'year-audit'
const DATE = '2024-09-25' // Wednesday

function setup(): void {
  if (testDb) testDb.close()
  testDb = new Database(':memory:')
  testDb.pragma('foreign_keys = ON')
  testDb.exec(schema)

  departmentRepository.create({ id: 'dept-bca', name: 'BCA', code: 'BCA' })
  departmentRepository.create({ id: 'dept-other', name: 'Languages', code: 'LANG' })

  academicYearRepository.create({
    id: YEAR,
    name: '2024-2025',
    startDate: '2024-06-01',
    endDate: '2025-05-31',
    isActive: false,
  })
  academicYearRepository.setActive(YEAR)
  timeSlotRepository.initializeDefaults()

  const faculty: [string, string, string][] = [
    ['fac-absent', 'Mrs. Absent', 'dept-bca'],
    ['fac-absent2', 'Ms. AbsentToo', 'dept-bca'],
    ['fac-same', 'Mrs. SameClass', 'dept-bca'],
    ['fac-busy', 'Mrs. BusyAtSlot4', 'dept-bca'],
    ['fac-freelancer', 'Ms. UnqualifiedOtherDept', 'dept-other'],
  ]
  for (const [id, name, departmentId] of faculty) {
    facultyRepository.create({
      id,
      name,
      employeeId: id.toUpperCase(),
      departmentId,
      isActive: true,
      maxDailySubstitutions: 1,
      priority: 0,
    })
  }

  for (const [id, name, code] of [
    ['sub-math', 'Mathematics', 'M-301'],
    ['sub-eng', 'General English', 'E-101'],
  ] as [string, string, string][]) {
    subjectRepository.create({ id, name, code, departmentId: 'dept-bca', defaultClassType: 'LECTURE' })
  }

  for (const [id, name, semester] of [
    ['sec-a', 'III BCA-A', 3],
    ['sec-b', 'III BCA-B', 3],
    ['sec-c', 'V BCA', 5],
  ] as [string, string, number][]) {
    sectionRepository.create({ id, name, semester, departmentId: 'dept-bca', academicYearId: YEAR })
  }

  testDb.prepare('INSERT INTO rooms (id, name, capacity, type) VALUES (?, ?, ?, ?)').run('room-1', 'Room 1', 60, 'CLASSROOM')
  testDb.prepare('INSERT INTO rooms (id, name, capacity, type) VALUES (?, ?, ?, ?)').run('room-2', 'Room 2', 60, 'CLASSROOM')
  testDb.prepare('INSERT INTO rooms (id, name, capacity, type) VALUES (?, ?, ?, ?)').run('room-3', 'Room 3', 60, 'CLASSROOM')

  // fac-same is the same-class candidate for sec-a and is qualified for math.
  facultyRepository.setSections('fac-same', ['sec-a'])
  facultyRepository.setSubjects('fac-same', [{ facultyId: 'fac-same', subjectId: 'sub-math', proficiency: 5 }])

  // Two absent teachers both lose a slot-4 class ...
  timetableEntryRepository.create({
    id: 'tt-absent-a', academicYearId: YEAR, dayOfWeek: 'WEDNESDAY', timeSlotId: 'slot-4',
    sectionId: 'sec-a', subjectId: 'sub-math', facultyIds: ['fac-absent'], roomIds: ['room-1'], classType: 'LECTURE', span: 1,
  })
  timetableEntryRepository.create({
    id: 'tt-absent-c', academicYearId: YEAR, dayOfWeek: 'WEDNESDAY', timeSlotId: 'slot-4',
    sectionId: 'sec-c', subjectId: 'sub-eng', facultyIds: ['fac-absent2'], roomIds: ['room-2'], classType: 'LECTURE', span: 1,
  })
  // ... and fac-busy is teaching sec-b in that same slot.
  timetableEntryRepository.create({
    id: 'tt-busy', academicYearId: YEAR, dayOfWeek: 'WEDNESDAY', timeSlotId: 'slot-4',
    sectionId: 'sec-b', subjectId: 'sub-eng', facultyIds: ['fac-busy'], roomIds: ['room-3'], classType: 'LECTURE', span: 1,
  })
  // A class in a *different* slot, so the daily limit can be exercised without
  // a same-slot conflict getting in the way.
  timetableEntryRepository.create({
    id: 'tt-extra', academicYearId: YEAR, dayOfWeek: 'WEDNESDAY', timeSlotId: 'slot-2',
    sectionId: 'sec-a', subjectId: 'sub-eng', facultyIds: ['fac-absent2'], roomIds: ['room-1'], classType: 'LECTURE', span: 1,
  })

  attendanceRepository.upsert(DATE, 'fac-absent', 'ABSENT')
  attendanceRepository.upsert(DATE, 'fac-absent2', 'ABSENT')
}

function entry(id: string): TimetableEntryWithRelations {
  const found = timetableEntryRepository.getWithRelations(YEAR).find((e) => e.id === id)
  if (!found) throw new Error(`fixture entry ${id} missing`)
  return found
}

function availability(absent: string[]) {
  return buildFacultyAvailability(
    DATE,
    YEAR,
    timeSlotRepository.getOrdered(),
    new Set(absent)
  )
}

function candidatesFor(entryId: string, absent: string[]): string[] {
  const target = entry(entryId)
  return getEligibleCandidates(
    target,
    facultyRepository.findActive(),
    availability(absent),
    DEFAULT_SUBSTITUTION_WEIGHTS,
    { absentFacultyIds: new Set(absent), lockedAssignments: new Map() }
  ).map((c) => c.faculty.id)
}

/** Insert an assignment into the run for DATE (runs are unique per date). */
function seedAssignment(id: string, originalEntryId: string, substituteFacultyId: string, status = 'APPROVED'): string {
  const runId = `run-${DATE}`
  const existing = testDb.prepare('SELECT id FROM substitution_runs WHERE date = ?').get(DATE)
  if (!existing) {
    testDb
      .prepare('INSERT INTO substitution_runs (id, date, status, generated_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(runId, DATE, 'GENERATED', '2024-09-25 08:00:00', '2024-09-25 08:00:00', '2024-09-25 08:00:00')
  }
  testDb
    .prepare(
      `INSERT INTO substitution_assignments (id, run_id, original_entry_id, substitute_faculty_id, status, score, reasoning, is_locked, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 100, 'seed', 0, ?, ?)`
    )
    .run(id, runId, originalEntryId, substituteFacultyId, status, '2024-09-25 08:00:00', '2024-09-25 08:00:00')
  return id
}

vi.mock('@/db/database', () => ({
  getDatabase: () => testDb,
  transaction: <T,>(fn: (db: unknown) => T): T => fn(testDb),
  closeDatabase: () => undefined,
  backupDatabase: () => undefined,
  restoreDatabase: () => undefined,
}))

describe('Hard-constraint audit', () => {
  beforeEach(setup)

  describe('eligibility (no faculty is structurally excluded)', () => {
    it('offers the slot to an unqualified cross-department teacher', () => {
      const ids = candidatesFor('tt-absent-a', ['fac-absent'])
      expect(ids).toContain('fac-freelancer')
      expect(ids).toContain('fac-same')
    })

    it('excludes absent and busy teachers', () => {
      const ids = candidatesFor('tt-absent-a', ['fac-absent'])
      expect(ids).not.toContain('fac-absent')
      expect(ids).not.toContain('fac-busy')
    })

    it('ranks the same-class teacher first', () => {
      const ids = candidatesFor('tt-absent-a', ['fac-absent'])
      expect(ids[0]).toBe('fac-same')
    })
  })

  describe('engine never double-books', () => {
    it('does not give a slot to a teacher already covering another class in it', () => {
      // fac-freelancer is already the approved substitute for tt-absent-c (slot-4).
      seedAssignment('asg-existing', 'tt-absent-c', 'fac-freelancer', 'APPROVED')

      const problem: SubstitutionProblem = {
        date: DATE,
        absentFacultyIds: ['fac-absent'],
        affectedEntries: [entry('tt-absent-a')],
        allFaculty: facultyRepository.findActive(),
        timeSlots: timeSlotRepository.getOrdered(),
        weights: DEFAULT_SUBSTITUTION_WEIGHTS,
        maxDailySubstitutions: 1,
      }

      const { assignments } = solveSubstitutionProblem(problem)
      expect(assignments.map((a) => a.substituteFacultyId)).not.toContain('fac-freelancer')
      expect(assignments[0]?.substituteFacultyId).toBe('fac-same')
    })
  })

  describe('the assign-substitute picker lists only legal choices', () => {
    it('excludes absent, busy and already-covering faculty but keeps the current pick', () => {
      const id = seedAssignment('asg-picker', 'tt-absent-a', 'fac-freelancer', 'PENDING')
      const ids = availableSubstitutesForAssignment(id).map((f) => f.id)

      expect(ids).toContain('fac-same')
      expect(ids).toContain('fac-freelancer') // current substitute stays selectable
      expect(ids).not.toContain('fac-absent') // absent
      expect(ids).not.toContain('fac-absent2') // absent
      expect(ids).not.toContain('fac-busy') // teaching in this slot
    })

    it('drops the current substitute from fresh picks once they are at the limit', () => {
      // fac-freelancer already covers a class today (a different slot) and the limit is 1.
      seedAssignment('asg-picker-limit-a', 'tt-extra', 'fac-freelancer', 'APPROVED')
      const id = seedAssignment('asg-picker-limit-b', 'tt-absent-a', 'fac-same', 'PENDING')
      const ids = availableSubstitutesForAssignment(id).map((f) => f.id)

      expect(ids).not.toContain('fac-freelancer')
      expect(ids).toContain('fac-same')
    })
  })

  describe('manual override enforces the same constraints', () => {
    it('rejects a teacher who is teaching during that slot', () => {
      const id = seedAssignment('asg-manual', 'tt-absent-a', 'fac-freelancer', 'PENDING')
      const result = updateSubstitutionAssignment(id, { substituteFacultyId: 'fac-busy' })
      expect(result).toBeNull()
    })

    it('rejects an absent teacher', () => {
      const id = seedAssignment('asg-absent', 'tt-absent-a', 'fac-freelancer', 'PENDING')
      expect(updateSubstitutionAssignment(id, { substituteFacultyId: 'fac-absent' })).toBeNull()
    })

    it('rejects a teacher already covering another class in the same slot', () => {
      seedAssignment('asg-existing2', 'tt-absent-c', 'fac-freelancer', 'APPROVED')
      const id = seedAssignment('asg-manual2', 'tt-absent-a', 'fac-same', 'PENDING')
      expect(updateSubstitutionAssignment(id, { substituteFacultyId: 'fac-freelancer' })).toBeNull()
    })

    it('rejects a teacher who is already at the daily limit', () => {
      // fac-freelancer already covers one class today (a different slot) and the limit is 1.
      seedAssignment('asg-limit', 'tt-extra', 'fac-freelancer', 'APPROVED')
      const id = seedAssignment('asg-manual3', 'tt-absent-a', 'fac-same', 'PENDING')
      expect(updateSubstitutionAssignment(id, { substituteFacultyId: 'fac-freelancer' })).toBeNull()
    })

    it('still allows a legitimate override', () => {
      const id = seedAssignment('asg-ok', 'tt-absent-a', 'fac-freelancer', 'PENDING')
      const result = updateSubstitutionAssignment(id, { substituteFacultyId: 'fac-same' })
      expect(result).not.toBeNull()
      expect(result.substituteFacultyId).toBe('fac-same')
    })
  })
})
