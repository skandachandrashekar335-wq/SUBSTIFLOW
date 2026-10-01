/**
 * Regression suite for the full functional audit.
 *
 * Each block pins down a root cause that was proven during the audit, so a
 * future change that reintroduces it fails loudly here:
 *
 *  1. Master Timetable "Add Entry" persists with academic_year_id
 *  2. Break periods cannot receive entries
 *  3. Timetable conflicts surface friendly messages (not raw SQL)
 *  4. Missing required fields are reported to the coordinator
 *  5. Update/delete of a vanished entry fails with a readable error
 *  6. Overlapping time slots are rejected, naming the clash
 *  7. Invalid time input (format, end <= start) is rejected
 *  8. Deleting an in-use period is refused with a friendly message
 *  9. Deleting an unused period works and renumbers orders densely
 * 10. Period reorder (move up/down) swaps positions
 * 11. New periods without an explicit order are appended
 * 12. Rebuild-from-working-hours keeps matching periods, creates new ones,
 *     marks break segments, and refuses to destroy in-use periods
 * 13. Working days round-trip (and fall back to sensible defaults)
 * 14. Negative penalty weights and daily limits survive save/load
 * 15. Attendance toggles never wipe existing notes
 * 16. Mark-all-present never wipes existing notes
 * 17. Everything survives a simulated app restart (SQLite is the source of
 *     truth: write, close, reopen, read)
 * 18. Faculty deletion actually deletes (and cascades mappings/attendance),
 *     with a friendly guard for faculty scheduled in the timetable
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import os from 'os'
import path from 'path'
import fs from 'fs'
import { schema } from '@/db/schema'
import { timeSlotRepository } from '@/db/repositories/timeSlot'
import { timetableEntryRepository } from '@/db/repositories/timetableEntry'
import { settingsRepository } from '@/db/repositories/settings'
import { academicYearRepository } from '@/db/repositories/academicYear'
import { departmentRepository } from '@/db/repositories/department'
import { facultyRepository } from '@/db/repositories/faculty'
import { subjectRepository } from '@/db/repositories/subject'
import { sectionRepository } from '@/db/repositories/section'
import { roomRepository } from '@/db/repositories/room'
import { attendanceRepository } from '@/db/repositories/attendance'
import {
  createTimetableEntry,
  updateTimetableEntry,
  deleteTimetableEntry,
} from '@/services/timetable'

let testDb: Database.Database | null = null

vi.mock('@/db/database', () => ({
  getDatabase: () => testDb,
  closeDatabase: () => undefined,
}))

function seedFixtures(): void {
  departmentRepository.create({ id: 'dept-bca', name: 'BCA', code: 'BCA' })
  academicYearRepository.create({
    id: 'year-1',
    name: '2024-2025',
    startDate: '2024-06-01',
    endDate: '2025-05-31',
    isActive: true,
  })
  timeSlotRepository.initializeDefaults()
  facultyRepository.create({ id: 'fac-1', name: 'Mrs. Ranjini', departmentId: 'dept-bca' })
  facultyRepository.create({ id: 'fac-2', name: 'Mrs. Usha', departmentId: 'dept-bca' })
  subjectRepository.create({ id: 'sub-1', name: 'Probability & Statistics', code: 'PAS', departmentId: 'dept-bca' })
  // fac-1 is linked to sub-1 (the service enforces this pairing on save);
  // fac-2 deliberately has no mappings — used to prove invalid pairs are rejected.
  facultyRepository.setSubjects('fac-1', [{ facultyId: 'fac-1', subjectId: 'sub-1', proficiency: 5 }])
  sectionRepository.create({ id: 'sec-1', name: 'III BCA-B', departmentId: 'dept-bca', semester: 5, academicYearId: 'year-1' })
  sectionRepository.create({ id: 'sec-2', name: 'III BCA-A', departmentId: 'dept-bca', semester: 5, academicYearId: 'year-1' })
  roomRepository.create({ id: 'room-1', name: 'Room 208' })
  roomRepository.create({ id: 'room-2', name: 'Room 209' })
}

function baseEntry(overrides: Record<string, unknown> = {}) {
  return {
    dayOfWeek: 'WEDNESDAY',
    timeSlotId: 'slot-4',
    sectionId: 'sec-1',
    subjectId: 'sub-1',
    facultyId: 'fac-1',
    roomId: 'room-1',
    classType: 'LECTURE',
    ...overrides,
  } as Parameters<typeof createTimetableEntry>[0]
}

beforeEach(() => {
  if (testDb) testDb.close()
  testDb = new Database(':memory:')
  testDb.pragma('foreign_keys = ON')
  testDb.exec(schema)
  seedFixtures()
})

afterEach(() => {
  if (testDb) {
    testDb.close()
    testDb = null
  }
})

// ---------------------------------------------------------------------------
// 1. Master Timetable add-entry (root cause: NOT NULL academic_year_id)
// ---------------------------------------------------------------------------
describe('regression: timetable entry creation', () => {
  it('the exact UI payload persists and stamps academic_year_id', () => {
    const created = createTimetableEntry(baseEntry(), 'year-1')
    // Read straight from SQLite — the source of truth, not repository state.
    const row = testDb!.prepare('SELECT * FROM timetable_entries WHERE id = ?').get(created.id) as any
    expect(row).toBeTruthy()
    expect(row.academic_year_id).toBe('year-1')
    expect(row.day_of_week).toBe('WEDNESDAY')
    expect(timetableEntryRepository.getWithRelations('year-1')).toHaveLength(1)
  })

  it('rejects entries on break periods with a readable message', () => {
    const breakSlot = timeSlotRepository.getBreakSlots()[0]
    expect(breakSlot).toBeTruthy()
    expect(() => createTimetableEntry(baseEntry({ timeSlotId: breakSlot.id }), 'year-1')).toThrow(
      /break/i
    )
    expect(timetableEntryRepository.getWithRelations('year-1')).toHaveLength(0)
  })

  it('rejects missing required fields with one message per problem', () => {
    let message = ''
    try {
      createTimetableEntry(
        baseEntry({ timeSlotId: '', sectionId: '', facultyId: '' }) as any,
        'year-1'
      )
    } catch (e: any) {
      message = e.message
    }
    expect(message).toContain('Time period is required.')
    expect(message).toContain('Section is required.')
    expect(message).toContain('Faculty is required.')
  })

  it('surfaces conflicts as coordinator-readable messages, not SQL', () => {
    createTimetableEntry(baseEntry(), 'year-1')
    let message = ''
    try {
      // Same faculty + day + slot, different section → faculty clash.
      createTimetableEntry(baseEntry({ sectionId: 'sec-2' }), 'year-1')
    } catch (e: any) {
      message = e.message
    }
    expect(message).toContain('Faculty already has a class at this time')
    expect(message).toContain('Room already booked at this time') // same room reused
    expect(message).not.toMatch(/SQLITE|constraint/i)
    expect(timetableEntryRepository.getWithRelations('year-1')).toHaveLength(1)
  })

  it('update of a vanished entry and double delete fail with readable errors', () => {
    const created = createTimetableEntry(baseEntry(), 'year-1')
    deleteTimetableEntry(created.id)
    expect(() => updateTimetableEntry(created.id, baseEntry())).toThrow(/no longer exists/i)
    expect(() => deleteTimetableEntry(created.id)).toThrow(/no longer exists/i)
    expect(timetableEntryRepository.getWithRelations('year-1')).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// 6-11. Time slot (period) management
// ---------------------------------------------------------------------------
describe('regression: time slot validation and management', () => {
  it('rejects an overlapping period and names the clash', () => {
    let message = ''
    try {
      timeSlotRepository.create({
        id: 'slot-overlap',
        name: '09:30-10:30',
        startTime: '09:30',
        endTime: '10:30',
      })
    } catch (e: any) {
      message = e.message
    }
    expect(message).toMatch(/overlaps with/i)
    expect(message).toContain('09:00-10:00')
    expect(timeSlotRepository.findById('slot-overlap')).toBeNull()
  })

  it('rejects invalid time input (format and end-before-start)', () => {
    expect(() =>
      timeSlotRepository.create({ id: 'bad-1', name: 'bad', startTime: '9am', endTime: '10:00' })
    ).toThrow(/HH:mm/)
    expect(() =>
      timeSlotRepository.create({ id: 'bad-2', name: 'bad', startTime: '14:00', endTime: '13:00' })
    ).toThrow(/after start time/i)
    expect(() =>
      timeSlotRepository.create({ id: 'bad-3', name: 'bad', startTime: '11:00', endTime: '11:00' })
    ).toThrow(/after start time/i)
  })

  it('refuses to delete a period in use, with a friendly message (no raw FK)', () => {
    createTimetableEntry(baseEntry(), 'year-1')
    let message = ''
    try {
      timeSlotRepository.delete('slot-4')
    } catch (e: any) {
      message = e.message
    }
    expect(message).toMatch(/used by 1 timetable entr/)
    expect(message).not.toMatch(/FOREIGN KEY/)
    expect(timeSlotRepository.findById('slot-4')).toBeTruthy()
  })

  it('deletes an unused period and keeps orders dense 1..N', () => {
    const before = timeSlotRepository.getOrdered()
    expect(before).toHaveLength(7)
    timeSlotRepository.delete('slot-6') // last period, unused
    const after = timeSlotRepository.getOrdered()
    expect(after).toHaveLength(6)
    expect(after.map(s => s.order)).toEqual([1, 2, 3, 4, 5, 6])
    // Usage counter agrees with reality.
    expect(timeSlotRepository.getUsageCount('slot-6')).toBe(0)
  })

  it('moves a period up/down, swapping positions', () => {
    const before = timeSlotRepository.getOrdered()
    expect(before[0].id).toBe('slot-1')
    expect(before[1].id).toBe('slot-2')
    expect(timeSlotRepository.move('slot-1', 1)).toBe(true)
    const after = timeSlotRepository.getOrdered()
    expect(after[0].id).toBe('slot-2')
    expect(after[1].id).toBe('slot-1')
    expect(after.map(s => s.order)).toEqual([1, 2, 3, 4, 5, 6, 7])
    // Edges are no-ops, not crashes.
    expect(timeSlotRepository.move('slot-2', -1)).toBe(false)
    expect(timeSlotRepository.move('slot-6', 1)).toBe(false)
  })

  it('appends a new period when no order is given', () => {
    const created = timeSlotRepository.create({
      id: 'slot-extra',
      name: '16:00-17:00',
      startTime: '16:00',
      endTime: '17:00',
    })
    expect(created.order).toBe(8)
    expect(timeSlotRepository.getOrdered().at(-1)!.id).toBe('slot-extra')
  })

  it('detects usage of a period', () => {
    expect(timeSlotRepository.getUsageCount('slot-4')).toBe(0)
    createTimetableEntry(baseEntry(), 'year-1')
    expect(timeSlotRepository.getUsageCount('slot-4')).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// 12. Rebuild periods from working hours (previously dead configuration)
// ---------------------------------------------------------------------------
describe('regression: rebuild periods from working hours', () => {
  it('is idempotent for unchanged hours and preserves period ids', () => {
    const idsBefore = timeSlotRepository.getOrdered().map(s => s.id)
    const result = timeSlotRepository.rebuildFromWorkingHours({
      startTime: '09:00',
      endTime: '16:00',
      breakStart: '13:00',
      breakEnd: '14:00',
    })
    expect(result.map(s => s.id)).toEqual(idsBefore)
    expect(result.filter(s => s.isBreak)).toHaveLength(1)
    expect(result.find(s => s.isBreak)!.startTime).toBe('13:00')
  })

  it('creates the new period when the day is extended to 17:00', () => {
    const result = timeSlotRepository.rebuildFromWorkingHours({
      startTime: '09:00',
      endTime: '17:00',
      breakStart: '13:00',
      breakEnd: '14:00',
    })
    expect(result).toHaveLength(8)
    const extended = result.find(s => s.endTime === '17:00')
    expect(extended).toBeTruthy()
    expect(extended!.startTime).toBe('16:00')
    // Existing periods kept their identity.
    expect(timeSlotRepository.findById('slot-4')).toBeTruthy()
    // Orders still follow the clock, densely.
    expect(result.map(s => s.order)).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
  })

  it('refuses to destroy periods that timetable entries use', () => {
    createTimetableEntry(baseEntry(), 'year-1') // uses slot-4 (12:00-13:00)
    const before = timeSlotRepository.getOrdered().map(s => s.id)
    let message = ''
    try {
      // A schedule where 12:00-13:00 no longer exists as a period.
      timeSlotRepository.rebuildFromWorkingHours({
        startTime: '09:30',
        endTime: '16:00',
        breakStart: '13:00',
        breakEnd: '14:00',
      })
    } catch (e: any) {
      message = e.message
    }
    expect(message).toMatch(/used by timetable entries/i)
    // Nothing was deleted or renumbered.
    expect(timeSlotRepository.getOrdered().map(s => s.id)).toEqual(before)
    expect(timeSlotRepository.getUsageCount('slot-4')).toBe(1)
  })

  it('validates its own input', () => {
    expect(() =>
      timeSlotRepository.rebuildFromWorkingHours({
        startTime: '16:00',
        endTime: '09:00',
        breakStart: '',
        breakEnd: '',
      })
    ).toThrow(/after start time/i)
    expect(() =>
      timeSlotRepository.rebuildFromWorkingHours({
        startTime: '09:00',
        endTime: '16:00',
        breakStart: '15:00',
        breakEnd: '17:00',
      })
    ).toThrow(/within working hours/i)
  })
})

// ---------------------------------------------------------------------------
// 13-14. Settings: working days and numeric rules
// ---------------------------------------------------------------------------
describe('regression: settings round-trips', () => {
  it('working days persist, canonicalise order and reject an empty set', () => {
    expect(settingsRepository.getWorkingDays()).toHaveLength(6) // default: all days
    settingsRepository.setWorkingDays(['FRIDAY', 'MONDAY'])
    expect(settingsRepository.getWorkingDays()).toEqual(['MONDAY', 'FRIDAY'])
    expect(() => settingsRepository.setWorkingDays([])).toThrow(/At least one working day/)
    // Corrupted/unknown stored value falls back to the full week.
    settingsRepository.set('working_days', 'FOOBAR,')
    expect(settingsRepository.getWorkingDays()).toHaveLength(6)
  })

  it('negative penalty weights and the daily limit survive save/load', () => {
    settingsRepository.setSubstitutionWeights({ penaltyCrossDepartment: -50, sameClass: 150 })
    const weights = settingsRepository.getSubstitutionWeights()
    expect(weights.penaltyCrossDepartment).toBe(-50) // not coerced to 0
    expect(weights.sameClass).toBe(150)
    expect(weights.penaltyHighSubCount).toBe(-30) // untouched default still present

    settingsRepository.setMaxDailySubstitutions(3)
    expect(settingsRepository.getMaxDailySubstitutions()).toBe(3)

    settingsRepository.setWorkingHours({
      startTime: '09:00',
      endTime: '17:00',
      breakStart: '13:30',
      breakEnd: '14:15',
    })
    const wh = settingsRepository.getWorkingHours()
    expect(wh).toEqual({ startTime: '09:00', endTime: '17:00', breakStart: '13:30', breakEnd: '14:15' })
  })
})

// ---------------------------------------------------------------------------
// 15-16. Attendance never destroys notes
// ---------------------------------------------------------------------------
describe('regression: attendance data safety', () => {
  it('toggling status preserves an existing note', () => {
    attendanceRepository.upsert('2024-09-25', 'fac-1', 'ABSENT', 'Medical leave')
    attendanceRepository.upsert('2024-09-25', 'fac-1', 'PRESENT') // the toggle
    const row = attendanceRepository.findByDateAndFaculty('2024-09-25', 'fac-1')!
    expect(row.status).toBe('PRESENT')
    expect(row.notes).toBe('Medical leave')
    expect(attendanceRepository.findByDate('2024-09-25')).toHaveLength(1)
  })

  it('mark-all-present only fills missing rows and keeps notes', () => {
    attendanceRepository.upsert('2024-09-25', 'fac-1', 'ABSENT', 'Medical leave')
    attendanceRepository.initializeAllPresent('2024-09-25', ['fac-1', 'fac-2'])
    const rows = attendanceRepository.findByDate('2024-09-25')
    expect(rows).toHaveLength(2)
    expect(rows.every(r => r.status === 'PRESENT')).toBe(true)
    expect(attendanceRepository.findByDateAndFaculty('2024-09-25', 'fac-1')!.notes).toBe(
      'Medical leave'
    )
  })
})

// ---------------------------------------------------------------------------
// 17. Simulated restart: write → close → reopen the same database file
// ---------------------------------------------------------------------------
describe('regression: persistence across an app restart', () => {
  it('periods, entries, working days and settings survive close/reopen', () => {
    const dbFile = path.join(os.tmpdir(), `substiflow-regression-${Date.now()}.db`)

    // --- session 1: configure and write -----------------------------------
    testDb = new Database(dbFile)
    testDb.pragma('foreign_keys = ON')
    testDb.exec(schema)
    seedFixtures()

    createTimetableEntry(baseEntry(), 'year-1')
    timeSlotRepository.create({
      id: 'slot-extra',
      name: '16:00-17:00',
      startTime: '16:00',
      endTime: '17:00',
    })
    settingsRepository.setWorkingDays(['MONDAY', 'WEDNESDAY', 'FRIDAY'])
    settingsRepository.setMaxDailySubstitutions(5)
    settingsRepository.setSubstitutionWeights({ sameClass: 42 })

    testDb.close()
    testDb = null

    // --- session 2: "relaunch" the app ------------------------------------
    testDb = new Database(dbFile)
    testDb.pragma('foreign_keys = ON')
    // No schema re-exec needed in the app; migrations are a no-op here anyway.

    expect(timeSlotRepository.getOrdered()).toHaveLength(8)
    expect(timeSlotRepository.findById('slot-extra')!.endTime).toBe('17:00')
    expect(timetableEntryRepository.getWithRelations('year-1')).toHaveLength(1)
    expect(settingsRepository.getWorkingDays()).toEqual([
      'MONDAY',
      'WEDNESDAY',
      'FRIDAY',
    ])
    expect(settingsRepository.getMaxDailySubstitutions()).toBe(5)
    expect(settingsRepository.getSubstitutionWeights().sameClass).toBe(42)

    // --- cleanup ----------------------------------------------------------
    testDb.close()
    testDb = null
    fs.rmSync(dbFile, { force: true })
    fs.rmSync(dbFile + '-wal', { force: true })
    fs.rmSync(dbFile + '-shm', { force: true })
  })
})

// ---------------------------------------------------------------------------
// 18. Faculty deletion
// ---------------------------------------------------------------------------
describe('regression: faculty deletion', () => {
  it('deletes an unused faculty member and cascades their mappings and attendance', () => {
    facultyRepository.setSubjects('fac-2', [
      { facultyId: 'fac-2', subjectId: 'sub-1', proficiency: 3 },
    ])
    facultyRepository.setSections('fac-2', ['sec-2'])
    attendanceRepository.upsert('2024-09-25', 'fac-2', 'ABSENT')
    expect(facultyRepository.findById('fac-2')).toBeTruthy()

    expect(facultyRepository.delete('fac-2')).toBe(true)

    expect(facultyRepository.findById('fac-2')).toBeNull()
    const count = (table: string) =>
      (
        testDb!
          .prepare(`SELECT COUNT(*) as c FROM ${table} WHERE faculty_id = ?`)
          .get('fac-2') as { c: number }
      ).c
    expect(count('faculty_subjects')).toBe(0)
    expect(count('faculty_sections')).toBe(0)
    expect(count('attendance')).toBe(0)
  })

  it('refuses to delete a scheduled faculty member with a friendly message (row preserved)', () => {
    createTimetableEntry(baseEntry(), 'year-1') // fac-1 is now in the timetable

    let message = ''
    try {
      facultyRepository.delete('fac-1')
    } catch (e: any) {
      message = e.message
    }

    expect(message).toContain('Mrs. Ranjini')
    expect(message).toMatch(/still scheduled in 1 timetable entry\./)
    expect(message).not.toMatch(/FOREIGN KEY|SQLITE/i)
    // Nothing was destroyed.
    expect(facultyRepository.findById('fac-1')).toBeTruthy()
    expect(timetableEntryRepository.getWithRelations('year-1')).toHaveLength(1)
  })

  it('deleting a faculty member who no longer exists returns false instead of crashing', () => {
    expect(facultyRepository.delete('fac-missing')).toBe(false)
  })
})
