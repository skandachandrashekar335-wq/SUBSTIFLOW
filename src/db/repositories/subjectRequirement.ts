import { BaseRepository } from './base'
import { SubjectRequirement, SubjectRequirementWithRelations, SubjectRequirementInput } from '@/types'

export class SubjectRequirementRepository extends BaseRepository<SubjectRequirement> {
  protected tableName = 'subject_requirements'

  protected entityFromRow(row: any): SubjectRequirement {
    return {
      id: row.id,
      academicYearId: row.academic_year_id,
      sectionId: row.section_id,
      subjectId: row.subject_id,
      classType: row.class_type,
      requiredSessionsPerWeek: row.required_sessions_per_week,
      span: row.span,
      teachingArrangement: (row.teaching_arrangement as SubjectRequirement['teachingArrangement']) ?? 'AUTO',
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }
  }

  findByAcademicYear(academicYearId: string): SubjectRequirement[] {
    const rows = this.db()
      .prepare('SELECT * FROM subject_requirements WHERE academic_year_id = ? ORDER BY section_id, subject_id, class_type')
      .all(academicYearId) as any[]
    return rows.map(row => this.entityFromRow(row))
  }

  findByAcademicYearWithRelations(academicYearId: string): SubjectRequirementWithRelations[] {
    const rows = this.db()
      .prepare(`
        SELECT
          sr.*,
          sec.id as section_id, sec.name as section_name, sec.semester as section_semester,
          sec.department_id as section_department_id, sec.academic_year_id as section_academic_year_id,
          sec.created_at as section_created_at, sec.updated_at as section_updated_at,
          s.id as subject_id, s.name as subject_name, s.code as subject_code,
          s.department_id as subject_department_id, s.default_class_type as subject_default_class_type,
          s.created_at as subject_created_at, s.updated_at as subject_updated_at
        FROM subject_requirements sr
        JOIN sections sec ON sr.section_id = sec.id
        JOIN subjects s ON sr.subject_id = s.id
        WHERE sr.academic_year_id = ?
        ORDER BY sec.semester, sec.name, s.name, sr.class_type
      `)
      .all(academicYearId) as any[]
    return rows.map(row => ({
      ...this.entityFromRow(row),
      section: {
        id: row.section_id,
        name: row.section_name,
        semester: row.section_semester,
        departmentId: row.section_department_id,
        academicYearId: row.section_academic_year_id,
        createdAt: row.section_created_at,
        updatedAt: row.section_updated_at,
      },
      subject: {
        id: row.subject_id,
        name: row.subject_name,
        code: row.subject_code,
        departmentId: row.subject_department_id,
        defaultClassType: row.subject_default_class_type,
        createdAt: row.subject_created_at,
        updatedAt: row.subject_updated_at,
      },
    }))
  }

  findBySectionAndSubject(academicYearId: string, sectionId: string, subjectId: string, classType: string): SubjectRequirement | null {
    const row = this.db()
      .prepare('SELECT * FROM subject_requirements WHERE academic_year_id = ? AND section_id = ? AND subject_id = ? AND class_type = ?')
      .get(academicYearId, sectionId, subjectId, classType) as any
    return row ? this.entityFromRow(row) : null
  }

  findBySection(academicYearId: string, sectionId: string): SubjectRequirement[] {
    const rows = this.db()
      .prepare('SELECT * FROM subject_requirements WHERE academic_year_id = ? AND section_id = ? ORDER BY subject_id, class_type')
      .all(academicYearId, sectionId) as any[]
    return rows.map(row => this.entityFromRow(row))
  }

  getRequiredSessionsForSectionSubject(academicYearId: string, sectionId: string, subjectId: string): number {
    const row = this.db()
      .prepare('SELECT SUM(required_sessions_per_week) as total FROM subject_requirements WHERE academic_year_id = ? AND section_id = ? AND subject_id = ?')
      .get(academicYearId, sectionId, subjectId) as { total: number | null }
    return row?.total ?? 0
  }

  getRequiredSessionsForClassType(academicYearId: string, sectionId: string, subjectId: string, classType: string): number {
    const row = this.db()
      .prepare('SELECT SUM(required_sessions_per_week) as total FROM subject_requirements WHERE academic_year_id = ? AND section_id = ? AND subject_id = ? AND class_type = ?')
      .get(academicYearId, sectionId, subjectId, classType) as { total: number | null }
    return row?.total ?? 0
  }
}

export const subjectRequirementRepository = new SubjectRequirementRepository()