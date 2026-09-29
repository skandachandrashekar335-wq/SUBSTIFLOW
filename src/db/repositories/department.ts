import { BaseRepository } from './base'
import { Department } from '@/types'

export class DepartmentRepository extends BaseRepository<Department> {
  protected tableName = 'departments'

  protected entityFromRow(row: any): Department {
    return {
      id: row.id,
      name: row.name,
      code: row.code,
      description: row.description,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }
  }
}

export const departmentRepository = new DepartmentRepository()