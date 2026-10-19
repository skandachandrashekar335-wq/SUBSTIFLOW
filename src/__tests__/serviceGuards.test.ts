/**
 * Service-level guards for the manual-testing fixes (isolated in-memory
 * database — never the production file):
 *
 *  1. Non-teaching staff can never hold a teaching allocation. The distinction
 *     lives on the Faculty record (staff type); no name is ever hardcoded.
 *  2. The configurable teaching arrangement (AUTO / TEAM / ALTERNATE) is
 *     validated on create and update and persisted exactly.
 *  3. Rejection messages stay administrator-readable (they name the person or
 *     list the legal values).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import { schema } from '@/db/schema'
import { departmentRepository } from '@/db/repositories/department'
import { academicYearRepository } from '@/db/repositories/academicYear'
import { facultyRepository } from '@/db/repositories/faculty'
import { subjectRepository } from '@/db/repositories/subject'
import { sectionRepository } from '@/db/repositories/section'
import { subjectRequirementRepository } from '@/db/repositories/subjectRequirement'
import { teachingAllocationRepository } from '@/db/repositories/teachingAllocation'
import { createSubjectRequirement, updateSubjectRequirement } from '@/services/subjectRequirement'
import { createTeachingAllocation, updateTeachingAllocation } from '@/services/timetableGeneration'
import { SubjectRequirementInput, TeachingAllocationInput } from '@/types'

let testDb: Database.Database | null = null

vi.mock('@/db/database', () => ({
  getDatabase: () => testDb,
  closeDatabase: () => undefined,
}))

const YEAR = 'year-1'

beforeEach(() => {
  if (testDb) testDb.close()
  testDb = new Database(':memory:')
  testDb.pragma('foreign_keys = ON')
  testDb.exec(schema)

  departmentRepository.create({ id: 'dept-bca', name: 'BCA', code: 'BCA' })
  academicYearRepository.create({
    id: YEAR,
    name: '2026-2027',
    startDate: '2026-06-01',
    endDate: '2027-05-31',
    isActive: true,
  })
  facultyRepository.create({ id: 'fac-1', name: 'Dr. Asha', departmentId: 'dept-bca' })
  facultyRepository.create({ id: 'fac-2', name: 'Dr. Binu', departmentId: 'dept-bca' })
  facultyRepository.create({
    id: 'fac-office',
    name: 'Office Incharge',
    departmentId: 'dept-bca',
    staffType: 'NON_TEACHING',
  })
  subjectRepository.create({ id: 'sub-cs', name: 'Computer Science', code: 'CS101', departmentId: 'dept-bca' })
  sectionRepository.create({
    id: 'sec-a',
    name: 'III BCA-A',
    semester: 5,
    departmentId: 'dept-bca',
    academicYearId: YEAR,
  })
})

afterEach(() => {
  vi.restoreAllMocks()
  if (testDb) {
    testDb.close()
    testDb = null
  }
})

function allocationInput(overrides: Partial<TeachingAllocationInput> = {}): TeachingAllocationInput {
  return {
    academicYearId: YEAR,
    facultyId: 'fac-1',
    sectionId: 'sec-a',
    subjectId: 'sub-cs',
    classType: 'LECTURE',
    requiredSessionsPerWeek: 2,
    ...overrides,
  }
}

function requirementInput(overrides: Partial<SubjectRequirementInput> = {}): SubjectRequirementInput {
  return {
    academicYearId: YEAR,
    sectionId: 'sec-a',
    subjectId: 'sub-cs',
    classType: 'LECTURE',
    requiredSessionsPerWeek: 2,
    span: 1,
    ...overrides,
  }
}

describe('teaching allocation guard: non-teaching staff', () => {
  it('refuses to create an allocation for a non-teaching staff member', () => {
    expect(() => createTeachingAllocation(allocationInput({ facultyId: 'fac-office' }))).toThrow(
      /non-teaching/i
    )
    expect(teachingAllocationRepository.findAll()).toHaveLength(0)
  })

  it('accepts teaching staff but refuses re-pointing an allocation at non-teaching staff', () => {
    const created = createTeachingAllocation(allocationInput())
    expect(created.facultyId).toBe('fac-1')

    expect(() => updateTeachingAllocation(created.id, { facultyId: 'fac-office' })).toThrow(/non-teaching/i)
    expect(teachingAllocationRepository.findById(created.id)!.facultyId).toBe('fac-1') // unchanged
  })

  it('reports a vanished faculty reference clearly instead of a raw SQL error', () => {
    expect(() => createTeachingAllocation(allocationInput({ facultyId: 'fac-gone' }))).toThrow(
      /no longer exists/i
    )
  })
})

describe('subject requirement guard: teaching arrangement', () => {
  it('persists an explicit TEAM arrangement and defaults to AUTO', () => {
    const team = createSubjectRequirement(
      requirementInput({ classType: 'LAB', requiredSessionsPerWeek: 3, span: 2, teachingArrangement: 'TEAM' })
    )
    expect(subjectRequirementRepository.findById(team.id)!.teachingArrangement).toBe('TEAM')

    const auto = createSubjectRequirement(requirementInput({ classType: 'TUTORIAL' }))
    expect(subjectRequirementRepository.findById(auto.id)!.teachingArrangement).toBe('AUTO')
  })

  it('rejects an unknown arrangement on create and on update', () => {
    expect(() =>
      createSubjectRequirement(requirementInput({ teachingArrangement: 'WHATEVER' as any }))
    ).toThrow(/Automatic, Team or Alternate/i)

    const req = createSubjectRequirement(requirementInput({ classType: 'LAB', span: 2 }))
    expect(() => updateSubjectRequirement(req.id, { teachingArrangement: 'PAIR' as any })).toThrow(
      /Automatic, Team or Alternate/i
    )
    expect(subjectRequirementRepository.findById(req.id)!.teachingArrangement).toBe('AUTO')
  })

  it('round-trips an arrangement change through update', () => {
    const req = createSubjectRequirement(requirementInput({ classType: 'LAB', span: 2 }))
    updateSubjectRequirement(req.id, { teachingArrangement: 'ALTERNATE' })
    expect(subjectRequirementRepository.findById(req.id)!.teachingArrangement).toBe('ALTERNATE')
    updateSubjectRequirement(req.id, { teachingArrangement: 'TEAM' })
    expect(subjectRequirementRepository.findById(req.id)!.teachingArrangement).toBe('TEAM')
  })
})
