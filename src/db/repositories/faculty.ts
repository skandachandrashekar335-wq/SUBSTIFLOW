import { getDatabase } from '../database'
import { BaseRepository } from './base'
import { Faculty, FacultyWithRelations, FacultySubject, FacultySection } from '@/types'

export class FacultyRepository extends BaseRepository<Faculty> {
  protected tableName = 'faculty'

  protected entityFromRow(row: any): Faculty {
    return {
      id: row.id,
      name: row.name,
      employeeId: row.employee_id,
      departmentId: row.department_id,
      isActive: Boolean(row.is_active),
      staffType: (row.staff_type as Faculty['staffType']) ?? 'TEACHING',
      maxDailySubstitutions: row.max_daily_substitutions,
      priority: row.priority,
      notes: row.notes,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }
  }

  findActive(): Faculty[] {
    const rows = this.db().prepare('SELECT * FROM faculty WHERE is_active = 1 ORDER BY name').all() as any[]
    return rows.map(row => this.entityFromRow(row))
  }

  findByDepartment(departmentId: string): Faculty[] {
    const rows = this.db().prepare('SELECT * FROM faculty WHERE department_id = ? AND is_active = 1 ORDER BY name').all(departmentId) as any[]
    return rows.map(row => this.entityFromRow(row))
  }

  getWithRelations(id: string): FacultyWithRelations | null {
    const faculty = this.findById(id)
    if (!faculty) return null

    const db = getDatabase()
    const subjects = db.prepare(`
      SELECT s.*, fs.proficiency 
      FROM subjects s
      JOIN faculty_subjects fs ON s.id = fs.subject_id
      WHERE fs.faculty_id = ?
    `).all(id) as any[]

    const sections = db.prepare(`
      SELECT sec.*
      FROM sections sec
      JOIN faculty_sections fs ON sec.id = fs.section_id
      WHERE fs.faculty_id = ?
    `).all(id) as any[]

    const department = db.prepare('SELECT * FROM departments WHERE id = ?').get(faculty.departmentId) as any

    return {
      ...faculty,
      department,
      subjects,
      sections,
    }
  }

  getSubjects(facultyId: string): FacultySubject[] {
    const rows = this.db().prepare('SELECT * FROM faculty_subjects WHERE faculty_id = ?').all(facultyId) as any[]
    return rows.map(row => ({
      facultyId: row.faculty_id,
      subjectId: row.subject_id,
      proficiency: row.proficiency,
    }))
  }

  setSubjects(facultyId: string, subjects: FacultySubject[]): void {
    // Atomic: a mid-loop failure must not leave the faculty with no (or
    // partial) mappings after the old ones were already deleted.
    this.transaction(() => {
      const db = this.db()
      db.prepare('DELETE FROM faculty_subjects WHERE faculty_id = ?').run(facultyId)
      const stmt = db.prepare('INSERT INTO faculty_subjects (faculty_id, subject_id, proficiency) VALUES (?, ?, ?)')
      for (const s of subjects) {
        stmt.run(s.facultyId, s.subjectId, s.proficiency)
      }
    })
  }

  getSections(facultyId: string): FacultySection[] {
    const rows = this.db().prepare('SELECT * FROM faculty_sections WHERE faculty_id = ?').all(facultyId) as any[]
    return rows.map(row => ({
      facultyId: row.faculty_id,
      sectionId: row.section_id,
    }))
  }

  setSections(facultyId: string, sectionIds: string[]): void {
    // Atomic — see setSubjects.
    this.transaction(() => {
      const db = this.db()
      db.prepare('DELETE FROM faculty_sections WHERE faculty_id = ?').run(facultyId)
      const stmt = db.prepare('INSERT INTO faculty_sections (faculty_id, section_id) VALUES (?, ?)')
      for (const sectionId of sectionIds) {
        stmt.run(facultyId, sectionId)
      }
    })
  }

  /**
   * How many substitutions this faculty member has taken on `date`.
   *
   * ONE counting rule for every surface (generation, manual picker,
   * Dashboard): every assignment row with this faculty as the substitute
   * counts — PENDING, APPROVED and LOCKED all reserve a daily slot; only an
   * explicit REJECTED frees it. (Generation previously counted only
   * APPROVED/LOCKED while the manual picker counted everything but
   * REJECTED, so the same person/date could pass the limit on one surface
   * and fail it on the other.)
   */
  getDailySubstitutionCount(facultyId: string, date: string): number {
    const row = this.db().prepare(`
      SELECT COUNT(*) as count
      FROM substitution_assignments sa
      JOIN substitution_runs sr ON sa.run_id = sr.id
      WHERE sa.substitute_faculty_id = ? AND sr.date = ? AND sa.status <> 'REJECTED'
    `).get(facultyId, date) as { count: number }
    return row.count
  }

  teachesSection(facultyId: string, sectionId: string): boolean {
    const row = this.db().prepare('SELECT 1 FROM faculty_sections WHERE faculty_id = ? AND section_id = ?').get(facultyId, sectionId)
    return !!row
  }

  isQualifiedForSubject(facultyId: string, subjectId: string): boolean {
    const row = this.db().prepare('SELECT 1 FROM faculty_subjects WHERE faculty_id = ? AND subject_id = ?').get(facultyId, subjectId)
    return !!row
  }

  getFacultyForSubject(subjectId: string): Faculty[] {
    const rows = this.db().prepare(`
      SELECT f.* FROM faculty f
      JOIN faculty_subjects fs ON f.id = fs.faculty_id
      WHERE fs.subject_id = ? AND f.is_active = 1
      ORDER BY f.priority, f.name
    `).all(subjectId) as any[]
    return rows.map(row => this.entityFromRow(row))
  }

  /**
   * Delete a faculty member.
   *
   * Timetable usage is checked first so the coordinator gets a friendly,
   * countable message instead of a raw FOREIGN KEY failure (schema:
   * `timetable_entry_faculty.faculty_id` is ON DELETE RESTRICT — membership in
   * a teaching team also counts as scheduling). Subject/section mappings and
   * attendance rows cascade away; substitution history is kept with the
   * substitute set to NULL.
   */
  delete(id: string): boolean {
    const existing = this.findById(id)
    if (!existing) return false
    const usage = this.db()
      .prepare(
        'SELECT COUNT(*) as count FROM timetable_entry_faculty WHERE faculty_id = ?'
      )
      .get(id) as { count: number }
    if (usage.count > 0) {
      const n = usage.count
      throw new Error(
        `${existing.name} is still scheduled in ${n} timetable entr${n === 1 ? 'y' : 'ies'}. ` +
          `Reassign or remove ${n === 1 ? 'it' : 'them'} first.`
      )
    }
    return super.delete(id)
  }
}

export const facultyRepository = new FacultyRepository()