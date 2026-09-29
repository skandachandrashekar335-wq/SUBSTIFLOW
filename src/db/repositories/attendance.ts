import { getDatabase } from '../database'
import { BaseRepository } from './base'
import { Attendance, AttendanceStatus } from '@/types'

export class AttendanceRepository extends BaseRepository<Attendance> {
  protected tableName = 'attendance'

  protected entityFromRow(row: any): Attendance {
    return {
      id: row.id,
      date: row.date,
      facultyId: row.faculty_id,
      status: row.status,
      notes: row.notes,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }
  }

  findByDate(date: string): Attendance[] {
    const rows = this.db().prepare('SELECT * FROM attendance WHERE date = ? ORDER BY faculty_id').all(date) as any[]
    return rows.map(row => this.entityFromRow(row))
  }

  findByDateAndFaculty(date: string, facultyId: string): Attendance | null {
    const row = this.db().prepare('SELECT * FROM attendance WHERE date = ? AND faculty_id = ?').get(date, facultyId) as any
    return row ? this.entityFromRow(row) : null
  }

  getAbsentFacultyIds(date: string): string[] {
    const rows = this.db().prepare('SELECT faculty_id FROM attendance WHERE date = ? AND status = ?').all(date, 'ABSENT') as any[]
    return rows.map(row => row.faculty_id)
  }

  getPresentFacultyIds(date: string): string[] {
    const rows = this.db().prepare('SELECT faculty_id FROM attendance WHERE date = ? AND status = ?').all(date, 'PRESENT') as any[]
    return rows.map(row => row.faculty_id)
  }

  upsert(date: string, facultyId: string, status: AttendanceStatus, notes?: string): Attendance {
    const existing = this.findByDateAndFaculty(date, facultyId)
    if (existing) {
      // Only overwrite notes when the caller actually supplies them, so a
      // simple status toggle never wipes an existing note.
      return notes !== undefined ? this.update(existing.id, { status, notes })! : this.update(existing.id, { status })!
    }
    return this.create({
      id: crypto.randomUUID(),
      date,
      facultyId,
      status,
      notes,
    })
  }

  initializeAllPresent(date: string, facultyIds: string[]): void {
    const db = getDatabase()
    const stmt = db.prepare(`
      INSERT INTO attendance (id, date, faculty_id, status, notes, created_at, updated_at)
      VALUES (?, ?, ?, 'PRESENT', '', datetime('now'), datetime('now'))
      ON CONFLICT(date, faculty_id) DO UPDATE SET status = 'PRESENT'
    `)
    for (const facultyId of facultyIds) {
      stmt.run(crypto.randomUUID(), date, facultyId)
    }
  }
}

export const attendanceRepository = new AttendanceRepository()