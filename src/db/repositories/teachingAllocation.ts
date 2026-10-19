import { BaseRepository } from './base'
import { TeachingAllocation, TeachingAllocationWithRelations } from '@/types'

export class TeachingAllocationRepository extends BaseRepository<TeachingAllocation> {
  protected tableName = 'teaching_allocations'

  protected entityFromRow(row: any): TeachingAllocation {
    return {
      id: row.id,
      academicYearId: row.academic_year_id,
      facultyId: row.faculty_id,
      sectionId: row.section_id,
      subjectId: row.subject_id,
      classType: row.class_type,
      requiredSessionsPerWeek: row.required_sessions_per_week,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }
  }

  findByAcademicYear(academicYearId: string): TeachingAllocation[] {
    const rows = this.db()
      .prepare('SELECT * FROM teaching_allocations WHERE academic_year_id = ? ORDER BY section_id, subject_id, faculty_id')
      .all(academicYearId) as any[]
    return rows.map(row => this.entityFromRow(row))
  }

  findByAcademicYearWithRelations(academicYearId: string): any[] {
    const rows = this.db()
      .prepare(`
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
        ORDER BY sec.semester, sec.name, s.name, f.name
      `)
      .all(academicYearId) as any[]
    return rows.map(row => ({
      ...this.entityFromRow(row),
      faculty: { id: row.faculty_id, name: row.faculty_name, departmentId: row.faculty_department_id },
      section: { id: row.section_id, name: row.section_name, semester: row.section_semester },
      subject: { id: row.subject_id, name: row.subject_name, code: row.subject_code, defaultClassType: row.subject_default_class_type },
    }))
  }

  findBySectionAndSubject(academicYearId: string, sectionId: string, subjectId: string): TeachingAllocation[] {
    const rows = this.db()
      .prepare('SELECT * FROM teaching_allocations WHERE academic_year_id = ? AND section_id = ? AND subject_id = ? ORDER BY class_type, faculty_id')
      .all(academicYearId, sectionId, subjectId) as any[]
    return rows.map(row => this.entityFromRow(row))
  }

  findByFaculty(academicYearId: string, facultyId: string): TeachingAllocation[] {
    const rows = this.db()
      .prepare('SELECT * FROM teaching_allocations WHERE academic_year_id = ? AND faculty_id = ? ORDER BY section_id, subject_id')
      .all(academicYearId, facultyId) as any[]
    return rows.map(row => this.entityFromRow(row))
  }

  getTotalSessionsForSectionSubject(academicYearId: string, sectionId: string, subjectId: string): number {
    const row = this.db()
      .prepare('SELECT SUM(required_sessions_per_week) as total FROM teaching_allocations WHERE academic_year_id = ? AND section_id = ? AND subject_id = ?')
      .get(academicYearId, sectionId, subjectId) as { total: number | null }
    return row?.total ?? 0
  }

  getRequiredSessionsForAllocation(academicYearId: string, sectionId: string, subjectId: string, classType: string): number {
    const row = this.db()
      .prepare('SELECT SUM(required_sessions_per_week) as total FROM teaching_allocations WHERE academic_year_id = ? AND section_id = ? AND subject_id = ? AND class_type = ?')
      .get(academicYearId, sectionId, subjectId, classType) as { total: number | null }
    return row?.total ?? 0
  }
}

export const teachingAllocationRepository = new TeachingAllocationRepository()