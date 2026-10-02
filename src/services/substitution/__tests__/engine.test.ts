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
import {
  substitutionRunRepository,
  substitutionAssignmentRepository,
} from '@/db/repositories/substitutionRun'
import {
  solveSubstitutionProblem,
  buildFacultyAvailability,
} from '@/services/substitution/engine'
import { getEligibleCandidates } from '@/services/substitution/scoring'
import { SubstitutionProblem } from '../types'
import type { TimetableEntryWithRelations } from '@/types'
import { DEFAULT_SUBSTITUTION_WEIGHTS } from '@/types'

// ---------------------------------------------------------------------------
// In-memory test database
// ---------------------------------------------------------------------------
let testDb: Database.Database

function setupTestDb(): void {
  if (testDb) testDb.close()
  testDb = new Database(':memory:')
  testDb.pragma('foreign_keys = ON')
  testDb.exec(schema)
}

const YEAR = 'year-2024'
const DATE = '2024-09-25' // Wednesday

function seedTestData(): void {
  departmentRepository.create({ id: 'dept-bca', name: 'BCA', code: 'BCA' })
  departmentRepository.create({ id: 'dept-other', name: 'Other', code: 'OTH' })

  academicYearRepository.create({
    id: YEAR,
    name: '2024-2025',
    startDate: '2024-06-01',
    endDate: '2025-05-31',
    isActive: false,
  })
  academicYearRepository.setActive(YEAR)

  timeSlotRepository.initializeDefaults()

  // --- Faculty -----------------------------------------------------------
  const facultyData: { id: string; name: string; employeeId: string; deptId?: string }[] = [
    { id: 'fac-ranjini', name: 'Mrs. Ranjini', employeeId: 'EMP001' },
    { id: 'fac-keerthi', name: 'Mrs. Keerthi', employeeId: 'EMP002' },
    { id: 'fac-usha', name: 'Mrs. Usha', employeeId: 'EMP003' },
    { id: 'fac-kohila', name: 'Mrs. Kohila', employeeId: 'EMP004' },
    { id: 'fac-kunkumashri', name: 'Mrs. Kunkumashri', employeeId: 'EMP005' },
    { id: 'fac-geetha', name: 'Dr. Geetha Lakshmi', employeeId: 'EMP006' },
    { id: 'fac-sheethal', name: 'Mr. Sheethal', employeeId: 'EMP007' },
    { id: 'fac-external', name: 'Mr. External', employeeId: 'EMP008', deptId: 'dept-other' },
  ]

  for (const f of facultyData) {
    facultyRepository.create({
      id: f.id,
      name: f.name,
      employeeId: f.employeeId,
      departmentId: f.deptId ?? 'dept-bca',
      isActive: true,
      maxDailySubstitutions: 2,
      priority: 0,
    })
  }

  // --- Subjects ----------------------------------------------------------
  const subjects = [
    { id: 'sub-ai', name: 'Artificial Intelligence', code: 'BCA-301' },
    { id: 'sub-ps', name: 'Probability & Statistics', code: 'BCA-302' },
    { id: 'sub-dbms', name: 'Database Management System', code: 'BCA-303' },
    { id: 'sub-english', name: 'General English', code: 'BCA-101' },
    { id: 'sub-constitution', name: 'Indian Constitution', code: 'BCA-102' },
    { id: 'sub-web', name: 'Web Programming', code: 'BCA-304' },
  ]

  for (const s of subjects) {
    subjectRepository.create({
      id: s.id,
      name: s.name,
      code: s.code,
      departmentId: 'dept-bca',
      defaultClassType: 'LECTURE',
    })
  }

  // --- Sections ----------------------------------------------------------
  const sections = [
    { id: 'sec-iiibca-b', name: 'III BCA-B', semester: 3 },
    { id: 'sec-iiibca-a', name: 'III BCA-A', semester: 3 },
    { id: 'sec-vbca', name: 'V BCA', semester: 5 },
    { id: 'sec-ibca-a', name: 'I BCA-A', semester: 1 },
  ]

  for (const s of sections) {
    sectionRepository.create({
      id: s.id,
      name: s.name,
      semester: s.semester,
      departmentId: 'dept-bca',
      academicYearId: YEAR,
    })
  }

  // --- Qualifications ----------------------------------------------------
  facultyRepository.setSubjects('fac-ranjini', [
    { facultyId: 'fac-ranjini', subjectId: 'sub-ps', proficiency: 5 },
    { facultyId: 'fac-ranjini', subjectId: 'sub-dbms', proficiency: 4 },
  ])
  // Usha is also qualified for P&S -> she wins over Kohila on subject fit
  facultyRepository.setSubjects('fac-usha', [
    { facultyId: 'fac-usha', subjectId: 'sub-english', proficiency: 5 },
    { facultyId: 'fac-usha', subjectId: 'sub-ps', proficiency: 4 },
  ])
  facultyRepository.setSubjects('fac-kohila', [
    { facultyId: 'fac-kohila', subjectId: 'sub-dbms', proficiency: 5 },
  ])
  facultyRepository.setSubjects('fac-geetha', [
    { facultyId: 'fac-geetha', subjectId: 'sub-ai', proficiency: 5 },
  ])
  facultyRepository.setSubjects('fac-sheethal', [
    { facultyId: 'fac-sheethal', subjectId: 'sub-ai', proficiency: 4 },
    { facultyId: 'fac-sheethal', subjectId: 'sub-web', proficiency: 4 },
  ])
  facultyRepository.setSubjects('fac-keerthi', [
    { facultyId: 'fac-keerthi', subjectId: 'sub-constitution', proficiency: 5 },
    { facultyId: 'fac-keerthi', subjectId: 'sub-english', proficiency: 4 },
  ])
  facultyRepository.setSubjects('fac-kunkumashri', [
    { facultyId: 'fac-kunkumashri', subjectId: 'sub-english', proficiency: 5 },
  ])

  // --- Normal section teaching assignments -------------------------------
  facultyRepository.setSections('fac-ranjini', ['sec-iiibca-b', 'sec-iiibca-a'])
  facultyRepository.setSections('fac-usha', ['sec-iiibca-b'])
  facultyRepository.setSections('fac-kohila', ['sec-iiibca-b', 'sec-iiibca-a'])
  facultyRepository.setSections('fac-geetha', ['sec-iiibca-b'])
  facultyRepository.setSections('fac-keerthi', ['sec-ibca-a'])
  facultyRepository.setSections('fac-kunkumashri', ['sec-vbca'])
  facultyRepository.setSections('fac-sheethal', ['sec-iiibca-a', 'sec-vbca'])
  facultyRepository.setSections('fac-external', ['sec-vbca'])

  // --- Rooms -------------------------------------------------------------
  const rooms = [
    { id: 'room-208', name: 'Room 208', capacity: 60, type: 'CLASSROOM' },
    { id: 'room-209', name: 'Room 209', capacity: 60, type: 'CLASSROOM' },
    { id: 'room-210', name: 'Room 210', capacity: 60, type: 'CLASSROOM' },
    { id: 'room-lab1', name: 'Lab 1', capacity: 40, type: 'LAB' },
  ]
  for (const r of rooms) {
    testDb
      .prepare('INSERT INTO rooms (id, name, capacity, type) VALUES (?, ?, ?, ?)')
      .run(r.id, r.name, r.capacity, r.type)
  }

  // --- Wednesday master timetable ----------------------------------------
  // Every row is unique per (year, day, slot, section/faculty/room).
  const entries: [string, string, string, string, string, string][] = [
    // slot-1 (09:00-10:00)
    ['tt-1', 'slot-1', 'sec-iiibca-b', 'sub-ai', 'fac-geetha', 'room-208'],
    ['tt-2', 'slot-1', 'sec-iiibca-a', 'sub-web', 'fac-sheethal', 'room-209'],
    ['tt-3', 'slot-1', 'sec-ibca-a', 'sub-constitution', 'fac-keerthi', 'room-210'],
    ['tt-4', 'slot-1', 'sec-vbca', 'sub-english', 'fac-kunkumashri', 'room-lab1'],
    // slot-2 (10:00-11:00)
    ['tt-5', 'slot-2', 'sec-iiibca-b', 'sub-dbms', 'fac-kohila', 'room-208'],
    ['tt-6', 'slot-2', 'sec-iiibca-a', 'sub-ps', 'fac-ranjini', 'room-209'],
    ['tt-7', 'slot-2', 'sec-ibca-a', 'sub-english', 'fac-usha', 'room-210'],
    ['tt-8', 'slot-2', 'sec-vbca', 'sub-ai', 'fac-sheethal', 'room-lab1'],
    // slot-3 (11:00-12:00)
    ['tt-9', 'slot-3', 'sec-iiibca-b', 'sub-english', 'fac-usha', 'room-208'],
    ['tt-10', 'slot-3', 'sec-iiibca-a', 'sub-dbms', 'fac-kohila', 'room-209'],
    ['tt-11', 'slot-3', 'sec-ibca-a', 'sub-constitution', 'fac-keerthi', 'room-210'],
    ['tt-12', 'slot-3', 'sec-vbca', 'sub-english', 'fac-kunkumashri', 'room-lab1'],
    // slot-4 (12:00-13:00) -- the slot under test
    ['tt-13', 'slot-4', 'sec-iiibca-b', 'sub-ps', 'fac-ranjini', 'room-208'],
    ['tt-14', 'slot-4', 'sec-iiibca-a', 'sub-ai', 'fac-geetha', 'room-209'],
    ['tt-15', 'slot-4', 'sec-ibca-a', 'sub-english', 'fac-kunkumashri', 'room-210'],
    ['tt-16', 'slot-4', 'sec-vbca', 'sub-web', 'fac-sheethal', 'room-lab1'],
    // slot-6 (15:00-16:00)
    ['tt-17', 'slot-6', 'sec-iiibca-b', 'sub-english', 'fac-usha', 'room-208'],
  ]

  for (const [id, slotId, sectionId, subjectId, facultyId, roomId] of entries) {
    timetableEntryRepository.create({
      id,
      academicYearId: YEAR,
      dayOfWeek: 'WEDNESDAY',
      timeSlotId: slotId,
      sectionId,
      subjectId,
      facultyIds: [facultyId],
      roomIds: [roomId],
      classType: 'LECTURE',
      span: 1,
    })
  }
}

function markAbsent(facultyIds: string[]): void {
  for (const id of facultyIds) {
    attendanceRepository.upsert(DATE, id, 'ABSENT')
  }
}

/** All Wednesday entries taught by the given faculty, limited to a slot. */
function entriesFor(facultyId: string, timeSlotId?: string): TimetableEntryWithRelations[] {
  const all = timetableEntryRepository.getWithRelations(YEAR).filter(
    (e) => e.facultyIds.includes(facultyId) && e.dayOfWeek === 'WEDNESDAY'
  )
  return timeSlotId ? all.filter((e) => e.timeSlotId === timeSlotId) : all
}

function buildProblem(
  absentFacultyIds: string[],
  affectedEntries: TimetableEntryWithRelations[],
  maxDailySubstitutions = 2
): SubstitutionProblem {
  return {
    date: DATE,
    absentFacultyIds,
    affectedEntries,
    allFaculty: facultyRepository.findActive(),
    timeSlots: timeSlotRepository.getOrdered(),
    weights: DEFAULT_SUBSTITUTION_WEIGHTS,
    maxDailySubstitutions,
  }
}

// The engine and repositories read the shared connection from this module.
vi.mock('@/db/database', () => ({
  getDatabase: () => testDb,
  transaction: <T,>(fn: (db: unknown) => T): T => fn(testDb),
  closeDatabase: () => undefined,
  backupDatabase: () => undefined,
  restoreDatabase: () => undefined,
}))

describe('Substitution Engine', () => {
  beforeEach(() => {
    setupTestDb()
    seedTestData()
  })

  // -------------------------------------------------------------------------
  // 1. Same-class priority
  // -------------------------------------------------------------------------
  describe('Test 1: one absent teacher, same-class teacher available', () => {
    it('selects the same-class teacher (Usha) over other free teachers', () => {
      markAbsent(['fac-ranjini'])

      const problem = buildProblem(['fac-ranjini'], entriesFor('fac-ranjini', 'slot-4'))
      const { assignments, uncovered } = solveSubstitutionProblem(problem)

      expect(assignments).toHaveLength(1)
      expect(assignments[0].substituteFacultyId).toBe('fac-usha')
      expect(uncovered).toHaveLength(0)
      expect(assignments[0].reasoning).toContain('Normally teaches III BCA-B')
    })
  })

  // -------------------------------------------------------------------------
  // 2. Unavailable cascade -> next priority tier
  // -------------------------------------------------------------------------
  describe('Test 2: same-class teacher absent, next same-class teacher available', () => {
    it('falls through to the next same-class teacher (Kohila)', () => {
      markAbsent(['fac-ranjini', 'fac-usha'])

      const problem = buildProblem(
        ['fac-ranjini', 'fac-usha'],
        entriesFor('fac-ranjini', 'slot-4')
      )
      const { assignments } = solveSubstitutionProblem(problem)

      expect(assignments).toHaveLength(1)
      expect(assignments[0].substituteFacultyId).toBe('fac-kohila')
    })
  })

  describe('Test 3: all same-class teachers absent, same-department teacher available', () => {
    it('falls through to a same-department teacher', () => {
      const absent = [
        'fac-ranjini',
        'fac-usha',
        'fac-kohila',
        'fac-kunkumashri',
        'fac-geetha',
      ]
      markAbsent(absent)

      const problem = buildProblem(absent, entriesFor('fac-ranjini', 'slot-4'))
      const { assignments } = solveSubstitutionProblem(problem)

      expect(assignments).toHaveLength(1)
      const substituteId = assignments[0].substituteFacultyId
      expect(substituteId).toBeTruthy()
      const substitute = facultyRepository.findById(substituteId!)
      expect(substitute?.departmentId).toBe('dept-bca')
    })
  })

  // -------------------------------------------------------------------------
  // 4. Double-booking rejection
  // -------------------------------------------------------------------------
  describe('Test 4: candidate already teaching during the slot', () => {
    it('never selects a teacher who is busy at that time', () => {
      markAbsent(['fac-ranjini'])

      const problem = buildProblem(['fac-ranjini'], entriesFor('fac-ranjini', 'slot-4'))
      const { assignments } = solveSubstitutionProblem(problem)

      expect(assignments).toHaveLength(1)
      // Sheethal and Kunkumashri both teach at slot-4
      expect(assignments[0].substituteFacultyId).not.toBe('fac-sheethal')
      expect(assignments[0].substituteFacultyId).not.toBe('fac-kunkumashri')
      // Geetha also teaches at slot-4
      expect(assignments[0].substituteFacultyId).not.toBe('fac-geetha')
    })
  })

  // -------------------------------------------------------------------------
  // 5. Absent candidate rejection
  // -------------------------------------------------------------------------
  describe('Test 5: candidate absent', () => {
    it('rejects absent teachers', () => {
      const absent = [
        'fac-ranjini',
        'fac-usha',
        'fac-kohila',
        'fac-kunkumashri',
        'fac-geetha',
        'fac-keerthi',
        'fac-external',
      ]
      markAbsent(absent)

      const problem = buildProblem(absent, entriesFor('fac-ranjini', 'slot-4'))
      const { assignments, uncovered } = solveSubstitutionProblem(problem)

      // Only Sheethal remains, but he is busy at slot-4
      expect(assignments).toHaveLength(0)
      expect(uncovered).toHaveLength(1)
    })
  })

  // -------------------------------------------------------------------------
  // 6. Daily substitution limit
  // -------------------------------------------------------------------------
  describe('Test 6: candidate already at the daily substitution limit', () => {
    it('rejects a teacher who already has the maximum substitutions', () => {
      markAbsent(['fac-ranjini'])

      const run = substitutionRunRepository.getOrCreateForDate(DATE)
      const existingEntries = timetableEntryRepository.getWithRelations(YEAR).slice(0, 2)
      for (const entry of existingEntries) {
        substitutionAssignmentRepository.create({
          id: `pre-${entry.id}`,
          runId: run.id,
          originalEntryId: entry.id,
          substituteFacultyId: 'fac-usha',
          status: 'APPROVED',
          score: 50,
          reasoning: 'Pre-existing assignment',
          isLocked: false,
        })
      }

      const problem = buildProblem(['fac-ranjini'], entriesFor('fac-ranjini', 'slot-4'))
      const { assignments } = solveSubstitutionProblem(problem)

      expect(assignments).toHaveLength(1)
      expect(assignments[0].substituteFacultyId).not.toBe('fac-usha')
    })
  })

  // -------------------------------------------------------------------------
  // 7. Global conflict-free assignment
  // -------------------------------------------------------------------------
  describe('Test 7: two absent teachers, one candidate free', () => {
    it('assigns each slot to a unique substitute', () => {
      markAbsent(['fac-ranjini', 'fac-geetha'])

      const affected = [
        ...entriesFor('fac-ranjini', 'slot-4'),
        ...entriesFor('fac-geetha', 'slot-4'),
      ]
      expect(affected).toHaveLength(2)

      const problem = buildProblem(['fac-ranjini', 'fac-geetha'], affected)
      const { assignments } = solveSubstitutionProblem(problem)

      expect(assignments).toHaveLength(2)
      const substitutes = assignments.map((a) => a.substituteFacultyId)
      expect(new Set(substitutes).size).toBe(2)
    })
  })

  // -------------------------------------------------------------------------
  // 8. No valid candidate -> NO SUBSTITUTE FOUND
  // -------------------------------------------------------------------------
  describe('Test 8: no valid candidate', () => {
    it('reports the class as uncovered (NO SUBSTITUTE FOUND)', () => {
      const allIds = facultyRepository.findActive().map((f) => f.id)
      const absent = allIds.filter((id) => id !== 'fac-sheethal')
      markAbsent(absent)

      const problem = buildProblem(absent, entriesFor('fac-ranjini', 'slot-4'))
      const { assignments, uncovered } = solveSubstitutionProblem(problem)

      expect(assignments).toHaveLength(0)
      expect(uncovered).toHaveLength(1)
      expect(uncovered[0].reason).toContain('No eligible faculty available')
    })
  })

  // -------------------------------------------------------------------------
  // 9. Break slot is never substituted
  // -------------------------------------------------------------------------
  describe('Test 9: lunch break', () => {
    it('refuses to assign any substitution inside the break slot', () => {
      markAbsent(['fac-ranjini'])

      const base = entriesFor('fac-ranjini', 'slot-4')[0]
      const breakEntry = {
        ...base,
        id: 'break-entry',
        timeSlotId: 'break',
        timeSlot: {
          id: 'break',
          name: '13:00-14:00',
          startTime: '13:00',
          endTime: '14:00',
          order: 5,
          isBreak: true,
        },
      } as TimetableEntryWithRelations

      const problem = buildProblem(['fac-ranjini'], [breakEntry])
      const { assignments, uncovered } = solveSubstitutionProblem(problem)

      expect(assignments).toHaveLength(0)
      expect(uncovered).toHaveLength(1)
    })
  })

  // -------------------------------------------------------------------------
  // 10. No double-booking across the whole day
  // -------------------------------------------------------------------------
  describe('Test 10: global conflict-free optimization', () => {
    it('never books one teacher into two classes at the same time', () => {
      markAbsent(['fac-ranjini', 'fac-geetha'])

      const affected = timetableEntryRepository
        .getWithRelations(YEAR)
        .filter((e) => e.dayOfWeek === 'WEDNESDAY' && e.timeSlotId === 'slot-4')

      const problem = buildProblem(['fac-ranjini', 'fac-geetha'], affected)
      const { assignments } = solveSubstitutionProblem(problem)

      const seen = new Map<string, string>()
      for (const a of assignments) {
        if (!a.substituteFacultyId) continue
        const key = a.originalEntryId
        const slot = problem.affectedEntries.find((e) => e.id === key)!.timeSlotId
        const mapKey = `${a.substituteFacultyId}@${slot}`
        expect(seen.has(mapKey)).toBe(false)
        seen.set(mapKey, key)
      }
    })
  })

  // -------------------------------------------------------------------------
  // 11. Locked manual assignment is preserved
  // -------------------------------------------------------------------------
  describe('Test 11: locked manual assignment', () => {
    it('stores a locked override that regeneration must respect', () => {
      const run = substitutionRunRepository.getOrCreateForDate(DATE)
      const entry = entriesFor('fac-ranjini', 'slot-4')[0]

      substitutionAssignmentRepository.create({
        id: 'locked-assign-1',
        runId: run.id,
        originalEntryId: entry.id,
        substituteFacultyId: 'fac-external',
        status: 'LOCKED',
        score: 0,
        reasoning: 'Manual override',
        isLocked: true,
      })

      const assignments = substitutionAssignmentRepository.findByRunWithRelations(run.id)
      const locked = assignments.find((a) => a.id === 'locked-assign-1')

      expect(locked).toBeTruthy()
      expect(locked!.substituteFacultyId).toBe('fac-external')
      expect(locked!.isLocked).toBe(true)
      expect(locked!.status).toBe('LOCKED')
    })
  })

  // -------------------------------------------------------------------------
  // 12. Determinism
  // -------------------------------------------------------------------------
  describe('Test 12: determinism', () => {
    it('produces identical output for identical input', () => {
      markAbsent(['fac-ranjini', 'fac-geetha'])

      const affected = timetableEntryRepository
        .getWithRelations(YEAR)
        .filter((e) => e.dayOfWeek === 'WEDNESDAY' && e.timeSlotId === 'slot-4')

      const problem = buildProblem(['fac-ranjini', 'fac-geetha'], affected)

      const result1 = solveSubstitutionProblem(problem)
      const result2 = solveSubstitutionProblem(problem)

      expect(result1.assignments.length).toBe(result2.assignments.length)
      expect(result1.uncovered.length).toBe(result2.uncovered.length)

      for (let i = 0; i < result1.assignments.length; i++) {
        expect(result1.assignments[i].originalEntryId).toBe(
          result2.assignments[i].originalEntryId
        )
        expect(result1.assignments[i].substituteFacultyId).toBe(
          result2.assignments[i].substituteFacultyId
        )
        expect(result1.assignments[i].score).toBe(result2.assignments[i].score)
        expect(result1.assignments[i].reasoning).toBe(result2.assignments[i].reasoning)
      }
    })
  })

  // -------------------------------------------------------------------------
  // Scoring details
  // -------------------------------------------------------------------------
  describe('Scoring', () => {
    it('ranks the same-class candidate first with explainable reasoning', () => {
      markAbsent(['fac-ranjini'])

      const entry = entriesFor('fac-ranjini', 'slot-4')[0]
      const availability = buildFacultyAvailability(
        DATE,
        YEAR,
        timeSlotRepository.getOrdered(),
        new Set(['fac-ranjini'])
      )

      const candidates = getEligibleCandidates(
        entry,
        facultyRepository.findActive(),
        availability,
        DEFAULT_SUBSTITUTION_WEIGHTS,
        { absentFacultyIds: new Set(['fac-ranjini']), lockedAssignments: new Map() }
      )

      expect(candidates.length).toBeGreaterThan(0)
      expect(candidates[0].faculty.id).toBe('fac-usha')
      expect(candidates[0].score).toBeGreaterThan(0)
      expect(candidates[0].reasons.some((r) => r.includes('Normally teaches III BCA-B'))).toBe(
        true
      )
      expect(candidates[0].reasons.some((r) => r.includes('Qualified for'))).toBe(true)
    })

    it('rejects absent, busy and over-limit candidates with a warning', () => {
      markAbsent(['fac-ranjini', 'fac-usha'])

      const entry = entriesFor('fac-ranjini', 'slot-4')[0]
      const availability = buildFacultyAvailability(
        DATE,
        YEAR,
        timeSlotRepository.getOrdered(),
        new Set(['fac-ranjini', 'fac-usha'])
      )

      const candidates = getEligibleCandidates(
        entry,
        facultyRepository.findActive(),
        availability,
        DEFAULT_SUBSTITUTION_WEIGHTS,
        { absentFacultyIds: new Set(['fac-ranjini', 'fac-usha']), lockedAssignments: new Map() }
      )

      const ids = candidates.map((c) => c.faculty.id)
      expect(ids).not.toContain('fac-ranjini')
      expect(ids).not.toContain('fac-usha')
      expect(ids).not.toContain('fac-sheethal') // busy at slot-4
      expect(ids).not.toContain('fac-geetha') // busy at slot-4
    })

    it('honours a custom max-daily-substitution limit', () => {
      markAbsent(['fac-ranjini'])

      const problem = buildProblem(['fac-ranjini'], entriesFor('fac-ranjini', 'slot-4'), 0)
      const { assignments, uncovered } = solveSubstitutionProblem(problem)

      expect(assignments).toHaveLength(0)
      expect(uncovered).toHaveLength(1)
    })
  })
})
