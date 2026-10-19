/**
 * Subject Requirement Service
 *
 * Manages subject requirements (Section × Subject × ClassType + required sessions/week + span).
 * This is the core input for the timetable generator.
 */

import { subjectRequirementRepository } from '@/db/repositories/subjectRequirement'
import { facultyRepository, sectionRepository, subjectRepository } from '@/db/repositories'
import { SubjectRequirement, SubjectRequirementInput, SubjectRequirementWithRelations, TEACHING_ARRANGEMENTS } from '@/types'
import { getDatabase } from '@/db/database'

function toFriendlyError(error: unknown, fallback: string): Error {
  const raw = error instanceof Error ? error.message : String(error)
  console.error('[subject requirement service]', raw)
  if (error instanceof Error && !/constraint|SQLITE|database/i.test(raw)) {
    return error
  }
  if (/UNIQUE constraint failed/i.test(raw)) {
    return new Error('This subject requirement already exists for this section and class type.')
  }
  if (/FOREIGN KEY constraint failed/i.test(raw)) {
    return new Error('One of the selected items no longer exists. Refresh the page and try again.')
  }
  if (/NOT NULL constraint failed/i.test(raw)) {
    return new Error('Please fill in all required fields.')
  }
  return new Error(fallback)
}

function assertValid(input: SubjectRequirementInput): void {
  const errors: string[] = []

  if (!input.academicYearId) errors.push('Academic year is required.')
  if (!input.sectionId) errors.push('Section is required.')
  if (!input.subjectId) errors.push('Subject is required.')
  if (!input.classType) errors.push('Class type is required.')
  if (!Number.isInteger(input.requiredSessionsPerWeek) || input.requiredSessionsPerWeek < 1) {
    errors.push('Required sessions per week must be a positive integer.')
  }
  if (!Number.isInteger(input.span) || input.span < 1) {
    errors.push('Span must be a positive integer.')
  }
  if (
    input.teachingArrangement !== undefined &&
    !TEACHING_ARRANGEMENTS.includes(input.teachingArrangement)
  ) {
    errors.push('Teaching arrangement must be Automatic, Team or Alternate.')
  }

  if (errors.length > 0) throw new Error(errors.join('\n'))
}

export function createSubjectRequirement(input: SubjectRequirementInput): any {
  assertValid(input)
  try {
    const entity = {
      id: crypto.randomUUID(),
      academicYearId: input.academicYearId,
      sectionId: input.sectionId,
      subjectId: input.subjectId,
      classType: input.classType,
      requiredSessionsPerWeek: input.requiredSessionsPerWeek,
      span: input.span,
      teachingArrangement: input.teachingArrangement ?? 'AUTO',
    }
    const created = subjectRequirementRepository.create(entity)
    return created
  } catch (error) {
    throw toFriendlyError(error, 'Could not create subject requirement. Please try again.')
  }
}

export function updateSubjectRequirement(id: string, updates: Partial<SubjectRequirementInput>): any {
  if (updates.requiredSessionsPerWeek !== undefined) {
    if (!Number.isInteger(updates.requiredSessionsPerWeek) || updates.requiredSessionsPerWeek < 1) {
      throw new Error('Required sessions per week must be a positive integer.')
    }
  }
  if (updates.span !== undefined) {
    if (!Number.isInteger(updates.span) || updates.span < 1) {
      throw new Error('Span must be a positive integer.')
    }
  }
  if (
    updates.teachingArrangement !== undefined &&
    !TEACHING_ARRANGEMENTS.includes(updates.teachingArrangement)
  ) {
    throw new Error('Teaching arrangement must be Automatic, Team or Alternate.')
  }
  try {
    const updated = subjectRequirementRepository.update(id, updates)
    if (!updated) throw new Error('This subject requirement no longer exists. Reload the page.')
    return updated
  } catch (error) {
    throw toFriendlyError(error, 'Could not update subject requirement. Please try again.')
  }
}

export function deleteSubjectRequirement(id: string): void {
  try {
    subjectRequirementRepository.delete(id)
  } catch (error) {
    throw toFriendlyError(error, 'Could not delete the subject requirement. Please try again.')
  }
}

export function getSubjectRequirementsForAcademicYear(academicYearId: string) {
  const db = getDatabase()
  const rows = db.prepare(`
    SELECT
      sr.*,
      sec.name as section_name,
      sec.semester as section_semester,
      s.name as subject_name,
      s.code as subject_code,
      s.default_class_type as subject_default_class_type
    FROM subject_requirements sr
    JOIN sections sec ON sr.section_id = sec.id
    JOIN subjects s ON sr.subject_id = s.id
    WHERE sr.academic_year_id = ?
    ORDER BY sec.semester, sec.name, s.name, sr.class_type
  `).all(academicYearId) as any[]
  return rows.map(row => ({
    id: row.id,
    academicYearId: row.academic_year_id,
    sectionId: row.section_id,
    subjectId: row.subject_id,
    classType: row.class_type,
    requiredSessionsPerWeek: row.required_sessions_per_week,
    span: row.span,
    teachingArrangement: row.teaching_arrangement ?? 'AUTO',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    section: { id: row.section_id, name: row.section_name, semester: row.section_semester },
    subject: { id: row.subject_id, name: row.subject_name, code: row.subject_code, defaultClassType: row.subject_default_class_type },
  }))
}

export function getSubjectRequirementsBySection(academicYearId: string, sectionId: string) {
  const db = getDatabase()
  return db.prepare(`
    SELECT sr.*, s.name as subject_name
    FROM subject_requirements sr
    JOIN subjects s ON sr.subject_id = s.id
    WHERE sr.academic_year_id = ? AND sr.section_id = ?
    ORDER BY s.name, sr.class_type
  `).all(academicYearId, sectionId) as any[]
}

export function getSubjectRequirementsBySectionSubject(academicYearId: string, sectionId: string, subjectId: string) {
  const db = getDatabase()
  return db.prepare(`
    SELECT sr.*, s.name as subject_name
    FROM subject_requirements sr
    JOIN subjects s ON sr.subject_id = s.id
    WHERE sr.academic_year_id = ? AND sr.section_id = ? AND sr.subject_id = ?
    ORDER BY sr.class_type
  `).all(academicYearId, sectionId) as any[]
}

export function getSubjectRequirementsBySectionSubjectClassType(academicYearId: string, sectionId: string, subjectId: string, classType: string) {
  const db = getDatabase()
  return db.prepare(`
    SELECT sr.*
    FROM subject_requirements sr
    WHERE sr.academic_year_id = ? AND sr.section_id = ? AND sr.subject_id = ? AND sr.class_type = ?
  `).all(academicYearId, sectionId, subjectId, classType) as any[]
}