import { getDatabase } from '../database'
import { BaseRepository } from './base'
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
        sa.*,
        f.name as substitute_faculty_name,
        te.day_of_week, te.time_slot_id, te.section_id, te.subject_id, te.faculty_id as original_faculty_id, te.room_id, te.academic_year_id,
        ts.name as time_slot_name, ts.start_time, ts.end_time, ts."order" as slot_order, ts.is_break,
        sec.name as section_name, sec.semester, sec.department_id as section_department_id,
        s.name as subject_name, s.code as subject_code,
        of.name as original_faculty_name,
        r.name as room_name
      FROM substitution_assignments sa
      LEFT JOIN faculty f ON sa.substitute_faculty_id = f.id
      JOIN timetable_entries te ON sa.original_entry_id = te.id
      JOIN time_slots ts ON te.time_slot_id = ts.id
      JOIN sections sec ON te.section_id = sec.id
      JOIN subjects s ON te.subject_id = s.id
      JOIN faculty of ON te.faculty_id = of.id
      JOIN rooms r ON te.room_id = r.id
      WHERE sa.run_id = ?
      ORDER BY te.day_of_week, ts."order"
    `).all(runId) as any[]

    return rows.map((row: any) => ({
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
      substituteFaculty: row.substitute_faculty_id ? {
        id: row.substitute_faculty_id,
        name: row.substitute_faculty_name,
        departmentId: '',
        isActive: true,
        maxDailySubstitutions: 2,
        priority: 0,
        createdAt: '',
        updatedAt: '',
      } : undefined,
      originalEntry: {
        id: row.original_entry_id,
        academicYearId: row.academic_year_id,
        dayOfWeek: row.day_of_week,
        timeSlotId: row.time_slot_id,
        sectionId: row.section_id,
        subjectId: row.subject_id,
        facultyId: row.original_faculty_id,
        roomId: row.room_id,
        classType: 'LECTURE',
        createdAt: '',
        updatedAt: '',
        timeSlot: {
          id: row.time_slot_id,
          name: row.time_slot_name,
          startTime: row.start_time,
          endTime: row.end_time,
          order: row.slot_order,
          isBreak: Boolean(row.is_break),
        },
        section: {
          id: row.section_id,
          name: row.section_name,
          semester: row.semester,
          departmentId: row.section_department_id,
          academicYearId: row.academic_year_id,
          createdAt: '',
          updatedAt: '',
        },
        subject: {
          id: row.subject_id,
          name: row.subject_name,
          code: row.subject_code,
          departmentId: '',
          defaultClassType: 'LECTURE',
          createdAt: '',
          updatedAt: '',
        },
        faculty: {
          id: row.original_faculty_id,
          name: row.original_faculty_name,
          departmentId: '',
          isActive: true,
          maxDailySubstitutions: 2,
          priority: 0,
          createdAt: '',
          updatedAt: '',
        },
        room: {
          id: row.room_id,
          name: row.room_name,
          capacity: 0,
          type: 'CLASSROOM',
          createdAt: '',
          updatedAt: '',
        },
      },
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