import { BaseRepository } from './base'
import { Subject } from '@/types'

export class SubjectRepository extends BaseRepository<Subject> {
  protected tableName = 'subjects'

  protected entityFromRow(row: any): Subject {
    return {
      id: row.id,
      name: row.name,
      code: row.code,
      departmentId: row.department_id,
      defaultClassType: row.default_class_type,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }
  }

  findByDepartment(departmentId: string): Subject[] {
    const rows = this.db().prepare('SELECT * FROM subjects WHERE department_id = ? ORDER BY name').all(departmentId) as any[]
    return rows.map(row => this.entityFromRow(row))
  }
}

export const subjectRepository = new SubjectRepository()