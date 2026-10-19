import { BaseRepository } from './base'
import { TimetableGeneration, TimetableGenerationWithRelations, GenerationStatus } from '@/types'

export class TimetableGenerationRepository extends BaseRepository<TimetableGeneration> {
  protected tableName = 'timetable_generations'

  protected entityFromRow(row: any): TimetableGeneration {
    return {
      id: row.id,
      academicYearId: row.academic_year_id,
      status: row.status as GenerationStatus,
      constraintsSnapshot: typeof row.constraints_snapshot === 'string' ? JSON.parse(row.constraints_snapshot) : (row.constraints_snapshot || {}),
      diagnosticsSummary: row.diagnostics_summary,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      completedAt: row.completed_at,
    }
  }

  findByAcademicYear(academicYearId: string): TimetableGeneration[] {
    const rows = this.db()
      .prepare('SELECT * FROM timetable_generations WHERE academic_year_id = ? ORDER BY created_at DESC')
      .all(academicYearId) as any[]
    return rows.map(row => this.entityFromRow(row))
  }

  findLatestByAcademicYear(academicYearId: string): TimetableGeneration | null {
    const row = this.db()
      .prepare('SELECT * FROM timetable_generations WHERE academic_year_id = ? ORDER BY created_at DESC LIMIT 1')
      .get(academicYearId) as any
    return row ? this.entityFromRow(row) : null
  }

  findByStatus(academicYearId: string, status: string): TimetableGeneration[] {
    const rows = this.db()
      .prepare('SELECT * FROM timetable_generations WHERE academic_year_id = ? AND status = ? ORDER BY created_at DESC')
      .all(academicYearId, status) as any[]
    return rows.map(row => this.entityFromRow(row))
  }

  /** Every generation still marked RUNNING (any academic year) — recovery input. */
  findRunning(): TimetableGeneration[] {
    const rows = this.db()
      .prepare(`SELECT * FROM timetable_generations WHERE status = 'RUNNING' ORDER BY created_at`)
      .all() as any[]
    return rows.map(row => this.entityFromRow(row))
  }

  create(entity: { id: string } & Record<string, any>): TimetableGeneration {
    return this.transaction(() => {
      this.db()
        .prepare(
          `INSERT INTO timetable_generations
             (id, academic_year_id, status, constraints_snapshot, created_at, updated_at)
           VALUES (?, ?, ?, ?, datetime('now'), datetime('now'))`
        )
        .run(
          entity.id,
          entity.academicYearId,
          entity.status || 'PENDING',
          JSON.stringify(entity.constraintsSnapshot || {}),
        )
      return this.findById(entity.id)!
    })
  }

  updateStatus(id: string, status: string, diagnosticsSummary?: string): TimetableGeneration | null {
    const updates: Record<string, any> = { status }
    if (diagnosticsSummary !== undefined) {
      updates.diagnosticsSummary = diagnosticsSummary
    }
    if (status === 'COMPLETED' || status === 'FAILED' || status === 'CANCELLED') {
      updates.completedAt = new Date().toISOString()
    }
    return this.update(id, updates)
  }

  updateConstraintsSnapshot(id: string, snapshot: Record<string, unknown>): TimetableGeneration | null {
    return this.update(id, { constraintsSnapshot: snapshot })
  }

  deleteByAcademicYear(academicYearId: string): number {
    const result = this.db()
      .prepare('DELETE FROM timetable_generations WHERE academic_year_id = ?')
      .run(academicYearId) as any
    return result.changes
  }
}

export const timetableGenerationRepository = new TimetableGenerationRepository()