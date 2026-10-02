import { BaseRepository, toColumn } from './base'
import {
  TimetableEntry,
  TimetableEntryWithRelations,
  DayOfWeek,
  ClassType,
  Faculty,
  Room,
} from '@/types'

function rowToFaculty(row: any): Faculty {
  return {
    id: row.id,
    name: row.name,
    employeeId: row.employee_id ?? undefined,
    departmentId: row.department_id,
    isActive: Boolean(row.is_active),
    maxDailySubstitutions: row.max_daily_substitutions,
    priority: row.priority ?? 0,
    notes: row.notes ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function rowToRoom(row: any): Room {
  return {
    id: row.id,
    name: row.name,
    capacity: row.capacity,
    type: row.type,
    departmentId: row.department_id ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

/** Dedupe while preserving order; drop empty/invalid ids. */
function normalizeIds(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  const out: string[] = []
  for (const v of value) {
    if (typeof v === 'string' && v && !seen.has(v)) {
      seen.add(v)
      out.push(v)
    }
  }
  return out
}

function normalizeSpan(value: unknown): number {
  const span = Number(value)
  return Number.isInteger(span) && span >= 1 ? span : 1
}

/**
 * Timetable entries — one row per ACTIVITY.
 *
 * Faculty and rooms live in ordered join tables (`timetable_entry_faculty`,
 * `timetable_entry_rooms`): an activity can be taught by a TEAM or by nobody
 * (library/mentoring/…), and can reference zero or several rooms. Every read
 * path hydrates those joins so callers always see complete `facultyIds` /
 * `roomIds` arrays.
 */
export class TimetableEntryRepository extends BaseRepository<TimetableEntry> {
  protected tableName = 'timetable_entries'

  protected entityFromRow(row: any): TimetableEntry {
    return {
      id: row.id,
      academicYearId: row.academic_year_id,
      dayOfWeek: row.day_of_week,
      timeSlotId: row.time_slot_id,
      sectionId: row.section_id,
      subjectId: row.subject_id,
      facultyIds: [],
      roomIds: [],
      classType: row.class_type,
      span: normalizeSpan(row.span),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }
  }

  // -------------------------------------------------------------------------
  // Join hydration
  // -------------------------------------------------------------------------

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
                f.max_daily_substitutions, f.priority, f.notes, f.created_at, f.updated_at
         FROM timetable_entry_faculty tef
         JOIN faculty f ON f.id = tef.faculty_id
         WHERE tef.entry_id IN (${ph})
         ORDER BY tef.position`
      )
      .all(...ids) as any[]) {
      const list = faculty.get(row.entry_id) ?? []
      list.push(rowToFaculty(row))
      faculty.set(row.entry_id, list)
    }

    for (const row of db
      .prepare(
        `SELECT ter.entry_id, r.id, r.name, r.capacity, r.type, r.department_id, r.created_at, r.updated_at
         FROM timetable_entry_rooms ter
         JOIN rooms r ON r.id = ter.room_id
         WHERE ter.entry_id IN (${ph})
         ORDER BY ter.position`
      )
      .all(...ids) as any[]) {
      const list = rooms.get(row.entry_id) ?? []
      list.push(rowToRoom(row))
      rooms.set(row.entry_id, list)
    }

    return { faculty, rooms }
  }

  private hydrate(rows: any[]): TimetableEntry[] {
    if (rows.length === 0) return []
    const { faculty, rooms } = this.joinMaps(rows.map(r => r.id))
    return rows.map(row => ({
      ...this.entityFromRow(row),
      facultyIds: (faculty.get(row.id) ?? []).map(f => f.id),
      roomIds: (rooms.get(row.id) ?? []).map(r => r.id),
    }))
  }

  // Base overrides — every read must carry the joined faculty/room ids.
  findAll(): TimetableEntry[] {
    const rows = this.db()
      .prepare(`SELECT * FROM ${this.tableName} ORDER BY created_at DESC`)
      .all() as any[]
    return this.hydrate(rows)
  }

  findById(id: string): TimetableEntry | null {
    const row = this.db()
      .prepare(`SELECT * FROM ${this.tableName} WHERE id = ?`)
      .get(id) as any
    return row ? this.hydrate([row])[0] : null
  }

  findWhere(where: Record<string, any>, orderBy?: string): TimetableEntry[] {
    const keys = Object.keys(where)
    const sql = keys.map(k => `${toColumn(k)} = ?`).join(' AND ')
    const query = `SELECT * FROM ${this.tableName} WHERE ${sql} ${
      orderBy ? `ORDER BY ${orderBy}` : ''
    }`
    const rows = this.db()
      .prepare(query)
      .all(...keys.map(k => where[k])) as any[]
    return this.hydrate(rows)
  }

  // -------------------------------------------------------------------------
  // Writes (entry row + join rows as one transaction)
  // -------------------------------------------------------------------------

  private replaceJoins(entryId: string, facultyIds: string[], roomIds: string[]): void {
    const db = this.db()
    db.prepare('DELETE FROM timetable_entry_faculty WHERE entry_id = ?').run(entryId)
    db.prepare('DELETE FROM timetable_entry_rooms WHERE entry_id = ?').run(entryId)
    const insF = db.prepare(
      'INSERT INTO timetable_entry_faculty (entry_id, faculty_id, position) VALUES (?, ?, ?)'
    )
    facultyIds.forEach((fid, i) => insF.run(entryId, fid, i))
    const insR = db.prepare(
      'INSERT INTO timetable_entry_rooms (entry_id, room_id, position) VALUES (?, ?, ?)'
    )
    roomIds.forEach((rid, i) => insR.run(entryId, rid, i))
  }

  create(entity: { id: string } & Record<string, any>): TimetableEntry {
    const facultyIds = normalizeIds(entity.facultyIds)
    const roomIds = normalizeIds(entity.roomIds)
    const span = normalizeSpan(entity.span)

    return this.transaction(() => {
      this.db()
        .prepare(
          `INSERT INTO timetable_entries
             (id, academic_year_id, day_of_week, time_slot_id, section_id,
              subject_id, class_type, span, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`
        )
        .run(
          entity.id,
          entity.academicYearId,
          entity.dayOfWeek,
          entity.timeSlotId,
          entity.sectionId,
          entity.subjectId,
          entity.classType ?? 'LECTURE',
          span
        )
      this.replaceJoins(entity.id, facultyIds, roomIds)
      return this.findById(entity.id)!
    })
  }

  update(id: string, updates: Record<string, any>): TimetableEntry | null {
    const existing = this.findById(id)
    if (!existing) return null

    const merged = {
      ...existing,
      ...updates,
      facultyIds:
        updates.facultyIds !== undefined
          ? normalizeIds(updates.facultyIds)
          : existing.facultyIds,
      roomIds: updates.roomIds !== undefined ? normalizeIds(updates.roomIds) : existing.roomIds,
      span: updates.span !== undefined ? normalizeSpan(updates.span) : existing.span,
    }

    return this.transaction(() => {
      const result = this.db()
        .prepare(
          `UPDATE timetable_entries
           SET academic_year_id = ?, day_of_week = ?, time_slot_id = ?, section_id = ?,
               subject_id = ?, class_type = ?, span = ?, updated_at = datetime('now')
           WHERE id = ?`
        )
        .run(
          merged.academicYearId,
          merged.dayOfWeek,
          merged.timeSlotId,
          merged.sectionId,
          merged.subjectId,
          merged.classType,
          merged.span,
          id
        ) as any
      if (result.changes === 0) return null
      this.replaceJoins(id, merged.facultyIds, merged.roomIds)
      return this.findById(id)
    })
  }

  bulkCreate(entries: any[]): void {
    for (const entry of entries) this.create(entry)
  }

  deleteByAcademicYear(academicYearId: string): number {
    const result = this.db()
      .prepare('DELETE FROM timetable_entries WHERE academic_year_id = ?')
      .run(academicYearId) as any
    return result.changes
  }

  // -------------------------------------------------------------------------
  // Queries
  // -------------------------------------------------------------------------

  findByAcademicYear(academicYearId: string): TimetableEntry[] {
    const rows = this.db()
      .prepare(
        'SELECT * FROM timetable_entries WHERE academic_year_id = ? ORDER BY day_of_week, time_slot_id'
      )
      .all(academicYearId) as any[]
    return this.hydrate(rows)
  }

  findByAcademicYearAndDay(academicYearId: string, dayOfWeek: DayOfWeek): TimetableEntry[] {
    const rows = this.db()
      .prepare(
        'SELECT * FROM timetable_entries WHERE academic_year_id = ? AND day_of_week = ? ORDER BY time_slot_id'
      )
      .all(academicYearId, dayOfWeek) as any[]
    return this.hydrate(rows)
  }

  /** Entries this faculty member teaches on the given day (team memberships included). */
  findByFacultyAndDay(
    facultyId: string,
    dayOfWeek: DayOfWeek,
    academicYearId: string
  ): TimetableEntry[] {
    const rows = this.db()
      .prepare(
        `SELECT te.* FROM timetable_entries te
         JOIN timetable_entry_faculty tef ON tef.entry_id = te.id
         WHERE tef.faculty_id = ? AND te.day_of_week = ? AND te.academic_year_id = ?
         ORDER BY te.time_slot_id`
      )
      .all(facultyId, dayOfWeek, academicYearId) as any[]
    return this.hydrate(rows)
  }

  /** How many entries reference this room (in any position). */
  countByRoom(roomId: string, academicYearId?: string): number {
    const row = this.db()
      .prepare(
        `SELECT COUNT(*) as count FROM timetable_entries te
         JOIN timetable_entry_rooms ter ON ter.entry_id = te.id
         WHERE ter.room_id = ?${academicYearId ? ' AND te.academic_year_id = ?' : ''}`
      )
      .get(...(academicYearId ? [roomId, academicYearId] : [roomId])) as { count: number }
    return row.count
  }

  // -------------------------------------------------------------------------
  // Relations (grid / engine / planner)
  // -------------------------------------------------------------------------

  private relationsSql(): string {
    return `
      SELECT
        te.*,
        ts.name as time_slot_name, ts.start_time, ts.end_time, ts."order" as slot_order, ts.is_break,
        sec.name as section_name, sec.semester, sec.department_id as section_department_id,
        s.name as subject_name, s.code as subject_code, s.default_class_type as subject_default_class_type
      FROM timetable_entries te
      JOIN time_slots ts ON te.time_slot_id = ts.id
      JOIN sections sec ON te.section_id = sec.id
      JOIN subjects s ON te.subject_id = s.id`
  }

  private assembleRelations(rows: any[]): TimetableEntryWithRelations[] {
    if (rows.length === 0) return []
    const { faculty, rooms } = this.joinMaps(rows.map(r => r.id))

    return rows.map(row => {
      const facultyList = faculty.get(row.id) ?? []
      const roomList = rooms.get(row.id) ?? []
      return {
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
          defaultClassType: (row.subject_default_class_type ?? 'LECTURE') as ClassType,
          createdAt: '',
          updatedAt: '',
        },
        faculty: facultyList[0],
        room: roomList[0],
        facultyIds: facultyList.map(f => f.id),
        roomIds: roomList.map(r => r.id),
        facultyList,
        roomList,
      }
    })
  }

  getWithRelations(academicYearId: string): TimetableEntryWithRelations[] {
    const rows = this.db()
      .prepare(
        `${this.relationsSql()}
         WHERE te.academic_year_id = ?
         ORDER BY te.day_of_week, ts."order"`
      )
      .all(academicYearId) as any[]
    return this.assembleRelations(rows)
  }

  getWithRelationsForDay(
    academicYearId: string,
    dayOfWeek: DayOfWeek
  ): TimetableEntryWithRelations[] {
    const rows = this.db()
      .prepare(
        `${this.relationsSql()}
         WHERE te.academic_year_id = ? AND te.day_of_week = ?
         ORDER BY ts."order"`
      )
      .all(academicYearId, dayOfWeek) as any[]
    return this.assembleRelations(rows)
  }

  /** Relations for a specific set of entry ids (any academic year). */
  getWithRelationsByIds(ids: string[]): TimetableEntryWithRelations[] {
    if (ids.length === 0) return []
    const ph = ids.map(() => '?').join(', ')
    const rows = this.db()
      .prepare(
        `${this.relationsSql()}
         WHERE te.id IN (${ph})
         ORDER BY te.day_of_week, ts."order"`
      )
      .all(...ids) as any[]
    return this.assembleRelations(rows)
  }
}

export const timetableEntryRepository = new TimetableEntryRepository()
