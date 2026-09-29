import { getDatabase } from '../database'
import { BaseRepository } from './base'
import { TimetableEntry, TimetableEntryWithRelations, DayOfWeek, ClassType } from '@/types'

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
      facultyId: row.faculty_id,
      roomId: row.room_id,
      classType: row.class_type,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }
  }

  findByAcademicYear(academicYearId: string): TimetableEntry[] {
    const rows = this.db().prepare('SELECT * FROM timetable_entries WHERE academic_year_id = ? ORDER BY day_of_week, time_slot_id').all(academicYearId) as any[]
    return rows.map(row => this.entityFromRow(row))
  }

  findByAcademicYearAndDay(academicYearId: string, dayOfWeek: DayOfWeek): TimetableEntry[] {
    const rows = this.db().prepare('SELECT * FROM timetable_entries WHERE academic_year_id = ? AND day_of_week = ? ORDER BY time_slot_id').all(academicYearId, dayOfWeek) as any[]
    return rows.map(row => this.entityFromRow(row))
  }

  findByFacultyAndDay(facultyId: string, dayOfWeek: DayOfWeek, academicYearId: string): TimetableEntry[] {
    const rows = this.db().prepare(`
      SELECT * FROM timetable_entries 
      WHERE faculty_id = ? AND day_of_week = ? AND academic_year_id = ?
      ORDER BY time_slot_id
    `).all(facultyId, dayOfWeek, academicYearId) as any[]
    return rows.map(row => this.entityFromRow(row))
  }

  getWithRelations(academicYearId: string): TimetableEntryWithRelations[] {
    const db = getDatabase()
    const rows = db.prepare(`
      SELECT 
        te.*,
        ts.name as time_slot_name, ts.start_time, ts.end_time, ts."order" as slot_order, ts.is_break,
        sec.name as section_name, sec.semester, sec.department_id as section_department_id,
        s.name as subject_name, s.code as subject_code,
        f.name as faculty_name,
        r.name as room_name
      FROM timetable_entries te
      JOIN time_slots ts ON te.time_slot_id = ts.id
      JOIN sections sec ON te.section_id = sec.id
      JOIN subjects s ON te.subject_id = s.id
      JOIN faculty f ON te.faculty_id = f.id
      JOIN rooms r ON te.room_id = r.id
      WHERE te.academic_year_id = ?
      ORDER BY te.day_of_week, ts."order"
    `).all(academicYearId) as any[]

    return rows.map((row: any) => ({
      id: row.id,
      academicYearId: row.academic_year_id,
      dayOfWeek: row.day_of_week,
      timeSlotId: row.time_slot_id,
      sectionId: row.section_id,
      subjectId: row.subject_id,
      facultyId: row.faculty_id,
      roomId: row.room_id,
      classType: row.class_type,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
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
        defaultClassType: row.class_type as ClassType,
        createdAt: '',
        updatedAt: '',
      },
      faculty: {
        id: row.faculty_id,
        name: row.faculty_name,
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
    }))
  }

  bulkCreate(entries: any[]): void {
    const db = this.db()
    const stmt = db.prepare(`
      INSERT INTO timetable_entries (id, academic_year_id, day_of_week, time_slot_id, section_id, subject_id, faculty_id, room_id, class_type, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
    `)
    for (const entry of entries) {
      stmt.run(entry.id, entry.academicYearId, entry.dayOfWeek, entry.timeSlotId, entry.sectionId, entry.subjectId, entry.facultyId, entry.roomId, entry.classType)
    }
  }

  deleteByAcademicYear(academicYearId: string): number {
    const result = this.db().prepare('DELETE FROM timetable_entries WHERE academic_year_id = ?').run(academicYearId) as any
    return result.changes
  }

  checkConflicts(entry: any, excludeId?: string): string[] {
    const errors: string[] = []
    const db = getDatabase()

    const params = [entry.academicYearId, entry.dayOfWeek, entry.timeSlotId, entry.facultyId]
    let teacherConflict = db.prepare(`
      SELECT 1 FROM timetable_entries 
      WHERE academic_year_id = ? AND day_of_week = ? AND time_slot_id = ? AND faculty_id = ?
      ${excludeId ? 'AND id != ?' : ''}
    `).get(...(excludeId ? [...params, excludeId] : params))
    if (teacherConflict) errors.push('Faculty already has a class at this time')

    const params2 = [entry.academicYearId, entry.dayOfWeek, entry.timeSlotId, entry.roomId]
    let roomConflict = db.prepare(`
      SELECT 1 FROM timetable_entries 
      WHERE academic_year_id = ? AND day_of_week = ? AND time_slot_id = ? AND room_id = ?
      ${excludeId ? 'AND id != ?' : ''}
    `).get(...(excludeId ? [...params2, excludeId] : params2))
    if (roomConflict) errors.push('Room already booked at this time')

    const params3 = [entry.academicYearId, entry.dayOfWeek, entry.timeSlotId, entry.sectionId]
    let sectionConflict = db.prepare(`
      SELECT 1 FROM timetable_entries 
      WHERE academic_year_id = ? AND day_of_week = ? AND time_slot_id = ? AND section_id = ?
      ${excludeId ? 'AND id != ?' : ''}
    `).get(...(excludeId ? [...params3, excludeId] : params3))
    if (sectionConflict) errors.push('Section already has a class at this time')

    return errors
  }
}

export const timetableEntryRepository = new TimetableEntryRepository()