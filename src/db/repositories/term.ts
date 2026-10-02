import { BaseRepository } from './base'
import { Term } from '@/types'

/**
 * Terms — timetable validity windows inside an academic year
 * (e.g. "20 Jul – 11 Nov 2026"). They answer the coordinator question
 * "which timetable is effective on <date>?".
 */
export class TermRepository extends BaseRepository<Term> {
  protected tableName = 'terms'

  protected entityFromRow(row: any): Term {
    return {
      id: row.id,
      academicYearId: row.academic_year_id,
      name: row.name,
      startDate: row.start_date,
      endDate: row.end_date,
      isActive: Boolean(row.is_active),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }
  }

  findByAcademicYear(academicYearId: string): Term[] {
    const rows = this.db()
      .prepare('SELECT * FROM terms WHERE academic_year_id = ? ORDER BY start_date')
      .all(academicYearId) as any[]
    return rows.map(row => this.entityFromRow(row))
  }

  getActive(): Term | null {
    const row = this.db()
      .prepare('SELECT * FROM terms WHERE is_active = 1 LIMIT 1')
      .get() as any
    return row ? this.entityFromRow(row) : null
  }

  /** Active term of a specific academic year, if any. */
  getActiveForAcademicYear(academicYearId: string): Term | null {
    const row = this.db()
      .prepare('SELECT * FROM terms WHERE academic_year_id = ? AND is_active = 1 LIMIT 1')
      .get(academicYearId) as any
    return row ? this.entityFromRow(row) : null
  }

  /** The term (in any year) whose date range covers `date` (YYYY-MM-DD). */
  findForDate(date: string): Term | null {
    const row = this.db()
      .prepare(
        'SELECT * FROM terms WHERE ? BETWEEN start_date AND end_date ORDER BY start_date DESC LIMIT 1'
      )
      .get(date) as any
    return row ? this.entityFromRow(row) : null
  }

  /** The single active term becomes inactive whenever another is activated. */
  setActive(id: string): void {
    this.transaction(() => {
      const db = this.db()
      db.prepare('UPDATE terms SET is_active = 0').run()
      db.prepare('UPDATE terms SET is_active = 1, updated_at = datetime(\'now\') WHERE id = ?').run(id)
    })
  }
}

export const termRepository = new TermRepository()
