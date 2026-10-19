/**
 * Teaching Allocation Service
 *
 * Manages teaching allocations (Faculty × Section × Subject × ClassType + weekly sessions).
 * This is the core input for the timetable generator.
 */

import { teachingAllocationRepository } from '@/db/repositories/teachingAllocation'
import { facultyRepository, sectionRepository, subjectRepository } from '@/db/repositories'
import { TeachingAllocation, TeachingAllocationInput, TeachingAllocationWithRelations } from '@/types'
import { getDatabase } from '@/db/database'
import { withTransaction } from '@/db/transaction'

function toFriendlyError(error: unknown, fallback: string): Error {
  const raw = error instanceof Error ? error.message : String(error)
  console.error('[teaching allocation service]', raw)
  if (error instanceof Error && !/constraint|SQLITE|database/i.test(raw)) {
    return error
  }
  if (/UNIQUE constraint failed/i.test(raw)) {
    return new Error('This teaching allocation already exists.')
  }
  if (/FOREIGN KEY constraint failed/i.test(raw)) {
    return new Error('One of the selected items no longer exists. Refresh the page and try again.')
  }
  if (/NOT NULL constraint failed/i.test(raw)) {
    return new Error('Please fill in all required fields.')
  }
  return new Error(fallback)
}

function assertValid(input: TeachingAllocationInput): void {
  const errors: string[] = []

  if (!input.academicYearId) errors.push('Academic year is required.')
  if (!input.facultyId) errors.push('Faculty is required.')
  if (!input.sectionId) errors.push('Section is required.')
  if (!input.subjectId) errors.push('Subject is required.')
  if (!input.classType) errors.push('Class type is required.')
  if (!Number.isInteger(input.requiredSessionsPerWeek) || input.requiredSessionsPerWeek < 1) {
    errors.push('Required sessions per week must be a positive integer.')
  }
  assertTeachingFaculty(input.facultyId, errors)

  if (errors.length > 0) throw new Error(errors.join('\n'))
}

/**
 * Non-teaching staff can never hold a teaching allocation — the scheduler
 * would otherwise offer their sessions for substitution and count them as
 * teachers. The distinction lives on the Faculty record (staff type), not in
 * anybody's name.
 */
function assertTeachingFaculty(facultyId: string | undefined, errors: string[]): void {
  if (!facultyId) return
  const faculty = facultyRepository.findById(facultyId)
  if (!faculty) {
    errors.push('The selected faculty member no longer exists.')
    return
  }
  if (faculty.staffType === 'NON_TEACHING') {
    errors.push(
      `${faculty.name} is marked as non-teaching staff and cannot be allocated teaching sessions.`
    )
  }
}

export function createTeachingAllocation(input: TeachingAllocationInput): any {
  assertValid(input)
  try {
    const created = teachingAllocationRepository.create({
      id: crypto.randomUUID(),
      ...input,
    })
    return created
  } catch (error) {
    throw toFriendlyError(error, 'Could not create teaching allocation. Please try again.')
  }
}

export function updateTeachingAllocation(id: string, updates: Partial<TeachingAllocationInput>): any {
  if (updates.requiredSessionsPerWeek !== undefined) {
    if (!Number.isInteger(updates.requiredSessionsPerWeek) || updates.requiredSessionsPerWeek < 1) {
      throw new Error('Required sessions per week must be a positive integer.')
    }
  }
  if (updates.facultyId !== undefined) {
    const errors: string[] = []
    assertTeachingFaculty(updates.facultyId, errors)
    if (errors.length > 0) throw new Error(errors.join('\n'))
  }
  try {
    const updated = teachingAllocationRepository.update(id, updates)
    if (!updated) throw new Error('This teaching allocation no longer exists. Reload the page.')
    return updated
  } catch (error) {
    throw toFriendlyError(error, 'Could not update teaching allocation. Please try again.')
  }
}

export function deleteTeachingAllocation(id: string): void {
  try {
    const removed = teachingAllocationRepository.delete(id)
    if (!removed) {
      throw new Error('This teaching allocation no longer exists. Reload the page.')
    }
  } catch (error) {
    throw toFriendlyError(error, 'Could not delete the teaching allocation. Please try again.')
  }
}

/**
 * Delete EVERY allocation row of one activity (section + subject + class
 * type) — what the grouped table's trash button promises. Returns how many
 * rows were removed; a refusal (e.g. referenced by published timetable
 * entries) surfaces as a friendly error, never a silent no-op.
 */
export function deleteTeachingAllocationsForActivity(
  academicYearId: string,
  sectionId: string,
  subjectId: string,
  classType: string
): number {
  const rows = teachingAllocationRepository.findWhere({
    academicYearId,
    sectionId,
    subjectId,
    classType,
  })
  if (rows.length === 0) {
    throw new Error('These teaching allocations no longer exist. Reload the page.')
  }
  let removed = 0
  try {
    // One transaction for the whole group: either every allocation of the
    // activity is gone or none is — never a half-deleted group.
    withTransaction(() => {
      for (const row of rows) {
        teachingAllocationRepository.delete(row.id)
        removed += 1
      }
    })
  } catch (error) {
    throw toFriendlyError(
      error,
      `Could not delete the allocations — nothing was changed. Please try again.`
    )
  }
  return removed
}

export function getTeachingAllocationsForAcademicYear(academicYearId: string) {
  const db = getDatabase()
  const rows = db.prepare(`
    SELECT
      ta.*,
      f.name as faculty_name,
      f.department_id as faculty_department_id,
      sec.name as section_name,
      sec.semester as section_semester,
      s.name as subject_name,
      s.code as subject_code,
      s.default_class_type as subject_default_class_type
    FROM teaching_allocations ta
    JOIN faculty f ON ta.faculty_id = f.id
    JOIN sections sec ON ta.section_id = sec.id
    JOIN subjects s ON ta.subject_id = s.id
    WHERE ta.academic_year_id = ?
    ORDER BY sec.semester, sec.name, s.name, ta.class_type, f.name
  `).all(academicYearId) as any[]
  return rows.map(row => ({
    id: row.id,
    academicYearId: row.academic_year_id,
    facultyId: row.faculty_id,
    sectionId: row.section_id,
    subjectId: row.subject_id,
    classType: row.class_type,
    requiredSessionsPerWeek: row.required_sessions_per_week,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    faculty: { id: row.faculty_id, name: row.faculty_name, departmentId: row.faculty_department_id },
    section: { id: row.section_id, name: row.section_name, semester: row.section_semester },
    subject: { id: row.subject_id, name: row.subject_name, code: row.subject_code, defaultClassType: row.subject_default_class_type },
  }))
}

export function getTeachingAllocationsByFaculty(academicYearId: string, facultyId: string) {
  const db = getDatabase()
  return db.prepare(`
    SELECT ta.*, s.name as subject_name, sec.name as section_name, sec.semester
    FROM teaching_allocations ta
    JOIN subjects s ON ta.subject_id = s.id
    JOIN sections sec ON ta.section_id = sec.id
    WHERE ta.academic_year_id = ? AND ta.faculty_id = ?
    ORDER BY sec.semester, sec.name, s.name
  `).all(academicYearId, facultyId) as any[]
}

export function getTotalSessionsForSectionSubject(academicYearId: string, sectionId: string, subjectId: string): number {
  const db = getDatabase()
  const row = db.prepare(`
    SELECT SUM(required_sessions_per_week) as total
    FROM teaching_allocations
    WHERE academic_year_id = ? AND section_id = ? AND subject_id = ?
  `).get(academicYearId, sectionId, subjectId) as { total: number | null }
  return row?.total ?? 0
}

export function getTeachingAllocationsBySectionSubject(academicYearId: string, sectionId: string, subjectId: string) {
  const db = getDatabase()
  return db.prepare(`
    SELECT ta.*, f.name as faculty_name
    FROM teaching_allocations ta
    JOIN faculty f ON ta.faculty_id = f.id
    WHERE ta.academic_year_id = ? AND ta.section_id = ? AND ta.subject_id = ?
    ORDER BY ta.class_type, f.name
  `).all(academicYearId, sectionId, subjectId) as any[]
}

export function getRequiredSessionsForClassType(academicYearId: string, sectionId: string, subjectId: string, classType: string): number {
  const db = getDatabase()
  const row = db.prepare(`
    SELECT SUM(required_sessions_per_week) as total
    FROM teaching_allocations
    WHERE academic_year_id = ? AND section_id = ? AND subject_id = ? AND class_type = ?
  `).get(academicYearId, sectionId, subjectId, classType) as { total: number | null }
  return row?.total ?? 0
}

export interface AllocationWithRelations {
  id: string
  academicYearId: string
  facultyId: string
  sectionId: string
  subjectId: string
  classType: string
  requiredSessionsPerWeek: number
  createdAt: string
  updatedAt: string
  facultyName: string
  sectionName: string
  semester: number
  subjectName: string
  subjectCode: string
}

export function getAllTeachingAllocationsForGeneration(academicYearId: string): AllocationWithRelations[] {
  const db = getDatabase()
  return db.prepare(`
    SELECT
      ta.*,
      -- Explicit camelCase aliases for the two snake_case ta.* columns: the
      -- grouped UI reads classType and requiredSessionsPerWeek, but raw
      -- ta.* only provides class_type / required_sessions_per_week. They
      -- were undefined before this alias — the grouped row showed empty
      -- chips ("Dr. Asha ()"), the edit dialog prefilled NOTHING for
      -- sessions/class type, and submitting the edit wrote NULL class_type
      -- ("Please fill in all required fields").
      ta.class_type AS classType,
      ta.required_sessions_per_week AS requiredSessionsPerWeek,
      f.id as facultyId, f.name as facultyName, f.max_daily_substitutions,
      sec.id as sectionId, sec.name as sectionName, sec.semester, sec.department_id as sectionDepartmentId,
      s.id as subjectId, s.name as subjectName, s.code as subjectCode
    FROM teaching_allocations ta
    JOIN faculty f ON ta.faculty_id = f.id
    JOIN sections sec ON ta.section_id = sec.id
    JOIN subjects s ON ta.subject_id = s.id
    WHERE ta.academic_year_id = ? AND f.is_active = 1
    ORDER BY sec.semester, sec.name, s.name, ta.class_type, f.priority, f.name
  `).all(academicYearId) as AllocationWithRelations[]
}

export function getAllocationsGroupedBySectionSubject(academicYearId: string) {
  const allocations = getAllTeachingAllocationsForGeneration(academicYearId)
  const grouped = new Map<string, any>()

  for (const alloc of allocations) {
    const key = `${alloc.sectionId}-${alloc.subjectId}-${alloc.classType}`
    if (!grouped.has(key)) {
      grouped.set(key, {
        sectionId: alloc.sectionId,
        sectionName: alloc.sectionName,
        semester: alloc.semester,
        subjectId: alloc.subjectId,
        subjectName: alloc.subjectName,
        subjectCode: alloc.subjectCode,
        classType: alloc.classType,
        faculty: [],
        totalRequiredSessions: 0,
      })
    }
    const group = grouped.get(key)!
    group.faculty.push({
      // The allocation's OWN row id — the edit/delete buttons must address
      // the allocation row, never the faculty record (a faculty id in an
      // `UPDATE ... WHERE id = ?` silently matches zero rows).
      allocationId: alloc.id,
      id: alloc.facultyId,
      name: alloc.facultyName,
      requiredSessions: alloc.requiredSessionsPerWeek,
    })
    group.totalRequiredSessions += alloc.requiredSessionsPerWeek
  }

  return Array.from(grouped.values())
}