import { BaseRepository } from './base'
import { Section } from '@/types'

export class SectionRepository extends BaseRepository<Section> {
  protected tableName = 'sections'

  protected entityFromRow(row: any): Section {
    return {
      id: row.id,
      name: row.name,
      semester: row.semester,
      departmentId: row.department_id,
      academicYearId: row.academic_year_id,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }
  }

  findByAcademicYear(academicYearId: string): Section[] {
    const rows = this.db().prepare('SELECT * FROM sections WHERE academic_year_id = ? ORDER BY semester, name').all(academicYearId) as any[]
    return rows.map(row => this.entityFromRow(row))
  }

  findByDepartmentAndYear(departmentId: string, academicYearId: string): Section[] {
    const rows = this.db().prepare('SELECT * FROM sections WHERE department_id = ? AND academic_year_id = ? ORDER BY semester, name').all(departmentId, academicYearId) as any[]
    return rows.map(row => this.entityFromRow(row))
  }
}

export const sectionRepository = new SectionRepository()