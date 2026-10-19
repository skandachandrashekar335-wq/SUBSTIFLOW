/**
 * Teaching-allocation edit path — regression tests.
 *
 * E2E found this defect: `getAllTeachingAllocationsForGeneration` selected
 * raw `ta.*` (snake_case) while the grouped UI read `classType` /
 * `requiredSessionsPerWeek` in camelCase. Both were therefore `undefined`:
 *  - the faculty chips rendered as "Dr. Asha ()",
 *  - the edit dialog prefilled NOTHING for sessions/class type,
 *  - submitting the edit wrote NULL class_type → SQLite NOT NULL →
 *    "Please fill in all required fields." — the edit could never succeed.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import os from 'os'
import path from 'path'
import fs from 'fs'
import { schema } from '@/db/schema'
import {
  departmentRepository,
  academicYearRepository,
  facultyRepository,
  sectionRepository,
  subjectRepository,
} from '@/db/repositories'
import {
  createTeachingAllocation,
  updateTeachingAllocation,
  getAllocationsGroupedBySectionSubject,
} from '@/services/timetableGeneration'

let testDb: Database.Database | null = null

vi.mock('@/db/database', () => ({
  getDatabase: () => testDb,
  closeDatabase: () => undefined,
}))

describe('teaching allocation edit path', () => {
  let dbDir = ''

  beforeEach(() => {
    dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'substiflow-alloc-'))
    testDb = new Database(path.join(dbDir, 'test.db'))
    testDb.exec(schema)
    departmentRepository.create({ id: 'dept-1', name: 'BCA', code: 'BCA' })
    academicYearRepository.create({
      id: 'year-1',
      name: '2026-2027',
      startDate: '2026-06-01',
      endDate: '2027-05-31',
      isActive: true,
    })
    facultyRepository.create({ id: 'fac-1', name: 'Dr. Asha', departmentId: 'dept-1' })
    facultyRepository.create({ id: 'fac-2', name: 'Dr. Binu', departmentId: 'dept-1' })
    subjectRepository.create({ id: 'sub-1', name: 'CS', code: 'CS101', departmentId: 'dept-1' })
    sectionRepository.create({
      id: 'sec-1',
      name: 'III BCA-A',
      departmentId: 'dept-1',
      semester: 5,
      academicYearId: 'year-1',
    })
  })

  afterEach(() => {
    testDb?.close()
    testDb = null
    if (dbDir) fs.rmSync(dbDir, { recursive: true, force: true })
  })

  function seedAllocations() {
    createTeachingAllocation({
      academicYearId: 'year-1',
      facultyId: 'fac-1',
      sectionId: 'sec-1',
      subjectId: 'sub-1',
      classType: 'LECTURE',
      requiredSessionsPerWeek: 2,
    })
    createTeachingAllocation({
      academicYearId: 'year-1',
      facultyId: 'fac-2',
      sectionId: 'sec-1',
      subjectId: 'sub-1',
      classType: 'LECTURE',
      requiredSessionsPerWeek: 1,
    })
    createTeachingAllocation({
      academicYearId: 'year-1',
      facultyId: 'fac-1',
      sectionId: 'sec-1',
      subjectId: 'sub-1',
      classType: 'LAB',
      requiredSessionsPerWeek: 3,
    })
  }

  it('the grouped UI carries classType and requiredSessions (chips, prefill, delete)', () => {
    seedAllocations()
    const groups = getAllocationsGroupedBySectionSubject('year-1')
    expect(groups).toHaveLength(2) // LECTURE and LAB stay separate groups

    const lecture = groups.find((g) => g.classType === 'LECTURE')!
    expect(lecture).toBeTruthy()
    expect(lecture.faculty).toHaveLength(2)
    expect(lecture.faculty.map((f: any) => f.requiredSessions).sort()).toEqual([1, 2])
    expect(lecture.totalRequiredSessions).toBe(3)

    const lab = groups.find((g) => g.classType === 'LAB')!
    expect(lab).toBeTruthy()
    expect(lab.faculty[0].requiredSessions).toBe(3)
    expect(lab.classType).toBe('LAB')

    // No phantom `undefined` class types anywhere (the pre-fix state).
    for (const g of groups) {
      expect(g.classType).toBeTypeOf('string')
      for (const f of g.faculty) expect(f.requiredSessions).toBeTypeOf('number')
    }
  })

  it('the edit dialog payload updates the row and the grouped view reflects it', () => {
    seedAllocations()
    const lecture = getAllocationsGroupedBySectionSubject('year-1').find(
      (g) => g.classType === 'LECTURE'
    )!
    const binu = lecture.faculty.find((f: any) => f.name === 'Dr. Binu')!

    // Exactly what the edit dialog submits (prefilled from the chip).
    updateTeachingAllocation(binu.allocationId, {
      facultyId: 'fac-2',
      sectionId: 'sec-1',
      subjectId: 'sub-1',
      classType: 'LECTURE',
      requiredSessionsPerWeek: 5,
    })

    const row = testDb!
      .prepare('SELECT class_type, required_sessions_per_week FROM teaching_allocations WHERE id = ?')
      .get(binu.allocationId) as { class_type: string; required_sessions_per_week: number }
    expect(row.class_type).toBe('LECTURE')
    expect(row.required_sessions_per_week).toBe(5)

    const after = getAllocationsGroupedBySectionSubject('year-1').find(
      (g) => g.classType === 'LECTURE'
    )!
    expect(after.totalRequiredSessions).toBe(7) // 2 (Asha) + 5 (Binu)
  })
})
