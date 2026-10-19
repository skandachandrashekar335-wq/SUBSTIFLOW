import { BaseRepository } from './base'
import { GenerationDiagnostic, DiagnosticSeverity, GenerationDiagnosticCode } from '@/types'

export class GenerationDiagnosticRepository extends BaseRepository<GenerationDiagnostic> {
  protected tableName = 'generation_diagnostics'

  protected entityFromRow(row: any): GenerationDiagnostic {
    return {
      id: row.id,
      generationId: row.generation_id,
      teachingAllocationId: row.teaching_allocation_id,
      severity: row.severity as DiagnosticSeverity,
      code: row.code as GenerationDiagnosticCode,
      message: row.message,
      details: row.details,
      createdAt: row.created_at,
    }
  }

  findByGeneration(generationId: string): GenerationDiagnostic[] {
    const rows = this.db()
      .prepare('SELECT * FROM generation_diagnostics WHERE generation_id = ? ORDER BY severity DESC, created_at')
      .all(generationId) as any[]
    return rows.map(row => this.entityFromRow(row))
  }

  findErrorsByGeneration(generationId: string): GenerationDiagnostic[] {
    const rows = this.db()
      .prepare('SELECT * FROM generation_diagnostics WHERE generation_id = ? AND severity = "ERROR" ORDER BY created_at')
      .all(generationId) as any[]
    return rows.map(row => this.entityFromRow(row))
  }

  findWarningsByGeneration(generationId: string): GenerationDiagnostic[] {
    const rows = this.db()
      .prepare('SELECT * FROM generation_diagnostics WHERE generation_id = ? AND severity = "WARNING" ORDER BY created_at')
      .all(generationId) as any[]
    return rows.map(row => this.entityFromRow(row))
  }

  create(entity: { id: string } & Record<string, any>): GenerationDiagnostic {
    return this.transaction(() => {
      this.db()
        .prepare(
          `INSERT INTO generation_diagnostics
             (id, generation_id, teaching_allocation_id, severity, code, message, details, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))`
        )
        .run(
          entity.id,
          entity.generationId,
          entity.teachingAllocationId ?? null,
          entity.severity,
          entity.code,
          entity.message,
          entity.details || null,
        )
      return this.findById(entity.id)!
    })
  }

  bulkCreate(diagnostics: any[]): void {
    this.transaction(() => {
      for (const diag of diagnostics) this.create(diag)
    })
  }

  deleteByGeneration(generationId: string): number {
    const result = this.db()
      .prepare('DELETE FROM generation_diagnostics WHERE generation_id = ?')
      .run(generationId) as any
    return result.changes
  }

  countErrorsByGeneration(generationId: string): number {
    const row = this.db()
      .prepare('SELECT COUNT(*) as count FROM generation_diagnostics WHERE generation_id = ? AND severity = "ERROR"')
      .get(generationId) as { count: number }
    return row.count
  }

  getSummaryByGeneration(generationId: string): { errors: number; warnings: number; infos: number } {
    const row = this.db()
      .prepare(`
        SELECT
          SUM(CASE WHEN severity = 'ERROR' THEN 1 ELSE 0 END) as errors,
          SUM(CASE WHEN severity = 'WARNING' THEN 1 ELSE 0 END) as warnings,
          SUM(CASE WHEN severity = 'INFO' THEN 1 ELSE 0 END) as infos
        FROM generation_diagnostics WHERE generation_id = ?
      `)
      .get(generationId) as { errors: number; warnings: number; infos: number }
    return { errors: row.errors, warnings: row.warnings, infos: row.infos }
  }
}

export const generationDiagnosticRepository = new GenerationDiagnosticRepository()