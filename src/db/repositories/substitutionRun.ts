import { getDatabase } from '../database'
import { BaseRepository } from './base'
import { timetableEntryRepository } from './timetableEntry'
import { SubstitutionRun, SubstitutionAssignment, SubstitutionAssignmentWithRelations } from '@/types'

export class SubstitutionRunRepository extends BaseRepository<SubstitutionRun> {
  protected tableName = 'substitution_runs'

  protected entityFromRow(row: any): SubstitutionRun {
    return {
      id: row.id,
      date: row.date,
      status: row.status,
      generatedAt: row.generated_at,
      approvedAt: row.approved_at,
      approvedBy: row.approved_by,
      notes: row.notes,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }
  }

  findByDate(date: string): SubstitutionRun | null {
    const row = this.db().prepare('SELECT * FROM substitution_runs WHERE date = ?').get(date) as any
    return row ? this.entityFromRow(row) : null
  }

  getOrCreateForDate(date: string): SubstitutionRun {
    let run = this.findByDate(date)
    if (!run) {
      run = this.create({
        id: crypto.randomUUID(),
        date,
        status: 'DRAFT',
        generatedAt: '',
        approvedAt: undefined,
        approvedBy: undefined,
        notes: undefined,
      } as any)
    }
    return run
  }

  approve(id: string, approvedBy: string): SubstitutionRun | null {
    return this.update(id, {
      status: 'APPROVED',
      approvedAt: new Date().toISOString(),
      approvedBy,
    })
  }

  /**
   * Reopen an approved plan after a manual edit — status and approval
   * metadata must be cleared together so the UI can never show a stale
   * APPROVED badge on a plan that has changed since approval.
   */
  reopen(id: string): SubstitutionRun | null {
    return this.update(id, { status: 'GENERATED', approvedAt: null, approvedBy: null })
  }

  publish(id: string): SubstitutionRun | null {
    return this.update(id, { status: 'PUBLISHED' })
  }
}

export class SubstitutionAssignmentRepository extends BaseRepository<SubstitutionAssignment> {
  protected tableName = 'substitution_assignments'

  protected entityFromRow(row: any): SubstitutionAssignment {
    return {
      id: row.id,
      runId: row.run_id,
      originalEntryId: row.original_entry_id,
      substituteFacultyId: row.substitute_faculty_id,
      status: row.status,
      score: row.score,
      reasoning: row.reasoning,
      isLocked: Boolean(row.is_locked),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }
  }

  findByRun(runId: string): SubstitutionAssignment[] {
    const rows = this.db().prepare('SELECT * FROM substitution_assignments WHERE run_id = ? ORDER BY created_at').all(runId) as any[]
    return rows.map(row => this.entityFromRow(row))
  }

  findByRunWithRelations(runId: string): SubstitutionAssignmentWithRelations[] {
    const db = getDatabase()
    const rows = db.prepare(`
      SELECT
        sa.id, sa.run_id, sa.original_entry_id, sa.substitute_faculty_id,
        sa.status, sa.score, sa.reasoning, sa.is_locked, sa.created_at, sa.updated_at,
        f.name as substitute_faculty_name
      FROM substitution_assignments sa
      LEFT JOIN faculty f ON sa.substitute_faculty_id = f.id
      WHERE sa.run_id = ?
    `).all(runId) as any[]

    if (rows.length === 0) return []

    // Original entries carry team/room/span via the shared hydration path.
    const entries = timetableEntryRepository.getWithRelationsByIds(
      rows.map(r => r.original_entry_id)
    )
    const entryById = new Map(entries.map(e => [e.id, e]))

    const dayIndex: Record<string, number> = {
      MONDAY: 0, TUESDAY: 1, WEDNESDAY: 2, THURSDAY: 3, FRIDAY: 4, SATURDAY: 5,
    }
    const ordered = [...rows].sort((a, b) => {
      const ea = entryById.get(a.original_entry_id)
      const eb = entryById.get(b.original_entry_id)
      const da = ea ? dayIndex[ea.dayOfWeek] ?? 9 : 9
      const db_ = eb ? dayIndex[eb.dayOfWeek] ?? 9 : 9
      if (da !== db_) return da - db_
      const sa = ea?.timeSlot?.order ?? 0
      const sb = eb?.timeSlot?.order ?? 0
      return sa - sb
    })

    return ordered.map((row: any) => ({
      id: row.id,
      runId: row.run_id,
      originalEntryId: row.original_entry_id,
      substituteFacultyId: row.substitute_faculty_id,
      status: row.status,
      score: row.score,
      reasoning: row.reasoning,
      isLocked: Boolean(row.is_locked),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      substituteFaculty: row.substitute_faculty_id
        ? {
            id: row.substitute_faculty_id,
            name: row.substitute_faculty_name,
            departmentId: '',
            isActive: true,
            maxDailySubstitutions: 2,
            priority: 0,
            createdAt: '',
            updatedAt: '',
          }
        : undefined,
      originalEntry: entryById.get(row.original_entry_id),
    }))
  }

  bulkCreate(assignments: any[]): void {
    const db = this.db()
    const stmt = db.prepare(`
      INSERT INTO substitution_assignments (id, run_id, original_entry_id, substitute_faculty_id, status, score, reasoning, is_locked, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
    `)
    for (const a of assignments) {
      stmt.run(a.id, a.runId, a.originalEntryId, a.substituteFacultyId || null, a.status, a.score || null, a.reasoning || null, a.isLocked ? 1 : 0)
    }
  }

  lock(id: string): SubstitutionAssignment | null {
    return this.update(id, { isLocked: true, status: 'LOCKED' })
  }

  unlock(id: string): SubstitutionAssignment | null {
    return this.update(id, { isLocked: false, status: 'PENDING' })
  }

  deleteByRun(runId: string): number {
    const result = this.db().prepare('DELETE FROM substitution_assignments WHERE run_id = ?').run(runId) as any
    return result.changes
  }
}

export const substitutionRunRepository = new SubstitutionRunRepository()
export const substitutionAssignmentRepository = new SubstitutionAssignmentRepository()