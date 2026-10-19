import { BaseRepository } from './base'
import {
  DraftTimetableEntry,
  DraftTimetableEntryWithRelations,
  Faculty,
  Room,
} from '@/types'

export class DraftTimetableEntryRepository extends BaseRepository<DraftTimetableEntry> {
  protected tableName = 'draft_timetable_entries'

  protected entityFromRow(row: any): DraftTimetableEntry {
    return {
      id: row.id,
      generationId: row.generation_id,
      academicYearId: row.academic_year_id,
      dayOfWeek: row.day_of_week,
      timeSlotId: row.time_slot_id,
      sectionId: row.section_id,
      subjectId: row.subject_id,
      classType: row.class_type,
      span: row.span,
      status: row.status,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }
  }

  findByGeneration(generationId: string): DraftTimetableEntry[] {
    const rows = this.db()
      .prepare('SELECT * FROM draft_timetable_entries WHERE generation_id = ? ORDER BY day_of_week, time_slot_id')
      .all(generationId) as any[]
    return rows.map(row => this.entityFromRow(row))
  }

  /** True when any draft row of this generation has already been published. */
  hasPublishedEntries(generationId: string): boolean {
    const row = this.db()
      .prepare('SELECT 1 AS found FROM draft_timetable_entries WHERE generation_id = ? AND status = ? LIMIT 1')
      .get(generationId, 'PUBLISHED') as { found: number } | undefined
    return row !== undefined
  }

  findByGenerationWithRelations(generationId: string): DraftTimetableEntryWithRelations[] {
    const rows = this.db()
      .prepare(`
        SELECT
          dte.*,
          ts.name as time_slot_name, ts.start_time, ts.end_time, ts."order" as slot_order, ts.is_break,
          sec.name as section_name, sec.semester, sec.department_id as section_department_id,
          s.name as subject_name, s.code as subject_code, s.default_class_type as subject_default_class_type
        FROM draft_timetable_entries dte
        JOIN time_slots ts ON dte.time_slot_id = ts.id
        JOIN sections sec ON dte.section_id = sec.id
        JOIN subjects s ON dte.subject_id = s.id
        WHERE dte.generation_id = ?
        ORDER BY dte.day_of_week, ts."order"
      `)
      .all(generationId) as any[]
    return this.assembleRelations(rows)
  }

  /** Hydrate the ordered faculty/room join rows for a set of draft entries. */
  private joinMaps(ids: string[]): {
    faculty: Map<string, Faculty[]>
    rooms: Map<string, Room[]>
  } {
    const db = this.db()
    const faculty = new Map<string, Faculty[]>()
    const rooms = new Map<string, Room[]>()
    if (ids.length === 0) return { faculty, rooms }
    const ph = ids.map(() => '?').join(', ')

    for (const row of db
      .prepare(
        `SELECT tef.entry_id, f.id, f.name, f.employee_id, f.department_id, f.is_active,
                f.staff_type, f.max_daily_substitutions, f.priority, f.notes, f.created_at, f.updated_at
         FROM draft_timetable_entry_faculty tef
         JOIN faculty f ON f.id = tef.faculty_id
         WHERE tef.entry_id IN (${ph})
         ORDER BY tef.position`
      )
      .all(...ids) as any[]) {
      const list = faculty.get(row.entry_id) ?? []
      list.push({
        id: row.id,
        name: row.name,
        employeeId: row.employee_id ?? undefined,
        departmentId: row.department_id,
        isActive: Boolean(row.is_active),
        staffType: row.staff_type ?? 'TEACHING',
        maxDailySubstitutions: row.max_daily_substitutions,
        priority: row.priority ?? 0,
        notes: row.notes ?? undefined,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      })
      faculty.set(row.entry_id, list)
    }

    for (const row of db
      .prepare(
        `SELECT ter.entry_id, r.id, r.name, r.capacity, r.type, r.department_id, r.created_at, r.updated_at
         FROM draft_timetable_entry_rooms ter
         JOIN rooms r ON r.id = ter.room_id
         WHERE ter.entry_id IN (${ph})
         ORDER BY ter.position`
      )
      .all(...ids) as any[]) {
      const list = rooms.get(row.entry_id) ?? []
      list.push({
        id: row.id,
        name: row.name,
        capacity: row.capacity,
        type: row.type,
        departmentId: row.department_id ?? undefined,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      })
      rooms.set(row.entry_id, list)
    }

    return { faculty, rooms }
  }

  private assembleRelations(rows: any[]): DraftTimetableEntryWithRelations[] {
    if (rows.length === 0) return []
    const { faculty, rooms } = this.joinMaps(rows.map(r => r.id))

    return rows.map(row => ({
      ...this.entityFromRow(row),
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
        defaultClassType: (row.subject_default_class_type ?? 'LECTURE') as any,
        createdAt: '',
        updatedAt: '',
      },
      facultyList: faculty.get(row.id) ?? [],
      roomList: rooms.get(row.id) ?? [],
    }))
  }

  create(entity: { id: string } & Record<string, any>): DraftTimetableEntry {
    return this.transaction(() => {
      this.db()
        .prepare(
          `INSERT INTO draft_timetable_entries
             (id, generation_id, academic_year_id, day_of_week, time_slot_id, section_id,
              subject_id, class_type, span, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`
        )
        .run(
          entity.id,
          entity.generationId,
          entity.academicYearId,
          entity.dayOfWeek,
          entity.timeSlotId,
          entity.sectionId,
          entity.subjectId,
          entity.classType ?? 'LECTURE',
          entity.span ?? 1,
          entity.status || 'DRAFT',
        )

      // Ordered teaching team and rooms (join rows), same shape as the
      // published timetable's join tables.
      const facultyIds: string[] = Array.isArray(entity.facultyIds) ? entity.facultyIds : []
      const roomIds: string[] = Array.isArray(entity.roomIds) ? entity.roomIds : []
      const insF = this.db().prepare(
        'INSERT INTO draft_timetable_entry_faculty (entry_id, faculty_id, position) VALUES (?, ?, ?)'
      )
      facultyIds.forEach((fid, i) => insF.run(entity.id, fid, i))
      const insR = this.db().prepare(
        'INSERT INTO draft_timetable_entry_rooms (entry_id, room_id, position) VALUES (?, ?, ?)'
      )
      roomIds.forEach((rid, i) => insR.run(entity.id, rid, i))

      return this.findById(entity.id)!
    })
  }

  bulkCreate(entries: any[]): void {
    this.transaction(() => {
      for (const entry of entries) this.create(entry)
    })
  }

  updateStatus(id: string, status: 'DRAFT' | 'PUBLISHED'): DraftTimetableEntry | null {
    return this.update(id, { status })
  }

  deleteByGeneration(generationId: string): number {
    const result = this.db()
      .prepare('DELETE FROM draft_timetable_entries WHERE generation_id = ?')
      .run(generationId) as any
    return result.changes
  }

  findByIdWithRelations(id: string): DraftTimetableEntryWithRelations | null {
    const row = this.db()
      .prepare(`
        SELECT
          dte.*,
          ts.name as time_slot_name, ts.start_time, ts.end_time, ts."order" as slot_order, ts.is_break,
          sec.name as section_name, sec.semester, sec.department_id as section_department_id,
          s.name as subject_name, s.code as subject_code, s.default_class_type as subject_default_class_type
        FROM draft_timetable_entries dte
        JOIN time_slots ts ON dte.time_slot_id = ts.id
        JOIN sections sec ON dte.section_id = sec.id
        JOIN subjects s ON dte.subject_id = s.id
        WHERE dte.id = ?
      `)
      .get(id) as any
    if (!row) return null
    return this.assembleRelations([row])[0]
  }
}

export const draftTimetableEntryRepository = new DraftTimetableEntryRepository()