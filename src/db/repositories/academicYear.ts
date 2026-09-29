import { BaseRepository } from './base'
import { AcademicYear } from '@/types'

export class AcademicYearRepository extends BaseRepository<AcademicYear> {
  protected tableName = 'academic_years'

  protected entityFromRow(row: any): AcademicYear {
    return {
      id: row.id,
      name: row.name,
      startDate: row.start_date,
      endDate: row.end_date,
      isActive: Boolean(row.is_active),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }
  }

  getActive(): AcademicYear | null {
    const row = this.db().prepare('SELECT * FROM academic_years WHERE is_active = 1 LIMIT 1').get() as any
    return row ? this.entityFromRow(row) : null
  }

  setActive(id: string): void {
    const db = this.db()
    db.prepare('UPDATE academic_years SET is_active = 0').run()
    db.prepare('UPDATE academic_years SET is_active = 1, updated_at = datetime(\'now\') WHERE id = ?').run(id)
  }
}

export const academicYearRepository = new AcademicYearRepository()