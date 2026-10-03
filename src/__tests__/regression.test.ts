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
 * 19. QA-012: the Add Entry dialog's displayed Time Slot / Section / Room are
 *     the actual form state — what the selects show is what gets submitted
 *     (and validation still rejects a truly empty state)
 * 20. QA-024: generation reports true statistics immediately (the Locked stat
 *     was hardcoded to 0 until a manual refresh)
 * 21. QA-025: removing/re-picking a substitute replaces the stale reasoning
 *     and score — an uncovered row never shows the old candidate's praise
 * 22. QA-023: APPROVED is a real, visible lifecycle state — editing or
 *     regenerating an approved plan reopens it and clears approval metadata
 * 23. QA-021: uncovered rows resolve to a real assignment id the manual
 *     picker can use (the synthetic id:'' never resolves)
 * 24. Hard constraint (e): periods outside configured working hours can never
 *     receive substitutions — generation or manual
 * 25. Hard constraint (j): unrelated (P5) faculty are excluded from the
 *     manual picker/override while the configuration disallows them
 * 26. Integrity: multi-statement writes are atomic (failed mapping save rolls
 *     back; switching active year always leaves exactly one active year)
 * 27. Integrity: a plain settings set() no longer wipes the stored
 *     description
 * 28. Integrity: assignment status and is_locked can never diverge
 * 29. QA-026: getRevisedTimetable returns a truthful revised day view
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
  buildAddEntryDefaults,
} from '@/services/timetable'
import { substitutionRunRepository, substitutionAssignmentRepository } from '@/db/repositories'
import {
  generateSubstitutions,
  getSubstitutionRun,
  approveSubstitutionRun,
  updateSubstitutionAssignment,
  availableSubstitutesForAssignment,
  validateSubstitute,
  lockAssignment,
  getRevisedTimetable,
} from '@/services/substitution'

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
    facultyIds: ['fac-1'],
    roomIds: ['room-1'],
    classType: 'LECTURE',
    span: 1,
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
        baseEntry({ timeSlotId: '', sectionId: '', facultyIds: [] }) as any,
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
    let thrown: any = null
    try {
      // Same faculty + day + slot, different section → faculty + room clash.
      createTimetableEntry(baseEntry({ sectionId: 'sec-2' }), 'year-1')
    } catch (e: any) {
      message = e.message
      thrown = e
    }
    expect(thrown?.name).toBe('TimetableConflictError') // structured, dialog-ready
    expect(message).toContain('is already teaching III BCA-B from')
    expect(message).toContain('already booked by') // same room reused
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

// ---------------------------------------------------------------------------
// 19. QA-012: Add Entry form state === displayed selects === submitted values
// ---------------------------------------------------------------------------
describe('QA-012: add entry form state matches the displayed selects', () => {
  const teachingSlots = () => timeSlotRepository.getOrdered().filter(s => !s.isBreak)
  const yearSections = () => sectionRepository.findByAcademicYear('year-1')
  const allRooms = () => roomRepository.findAll()
  const defaultsFor = (selectedSectionId?: string) =>
    buildAddEntryDefaults({
      selectedSectionId,
      teachingSlots: teachingSlots(),
      sections: yearSections(),
      rooms: allRooms(),
    })

  it('initializes Time Slot / Section / Room state to exactly the first option the dialog displays', () => {
    const slots = teachingSlots()
    const sections = yearSections()
    const rooms = allRooms()
    // The dialog renders these same arrays as the select options and the
    // browser shows options[0] — the state must be that same first option,
    // never '' (the QA-012 contradiction: displayed value, empty state).
    const defaults = defaultsFor()
    expect(defaults.timeSlotId).toBe(slots[0].id)
    expect(defaults.sectionId).toBe(sections[0].id)
    expect(defaults.roomId).toBe(rooms[0].id)
    expect(defaults.timeSlotId).not.toBe('')
    expect(defaults.sectionId).not.toBe('')
    expect(defaults.roomId).not.toBe('')
    // Break periods are never offered (and never defaulted to).
    expect(slots.some(s => s.id === defaults.timeSlotId && s.isBreak)).toBe(false)
  })

  it("the grid's active class filter wins for Section (context-aware open)", () => {
    const sections = yearSections()
    const defaults = defaultsFor(sections[1].id)
    expect(defaults.sectionId).toBe(sections[1].id)
    // The other two fields still display-first-option defaults.
    expect(defaults.timeSlotId).toBe(teachingSlots()[0].id)
    expect(defaults.roomId).toBe(allRooms()[0].id)
  })

  it('submitting with the initialized defaults succeeds and persists those exact values', () => {
    const defaults = defaultsFor()
    const created = createTimetableEntry(
      {
        dayOfWeek: 'WEDNESDAY',
        ...defaults,
        subjectId: 'sub-1',
        facultyIds: ['fac-1'],
        roomIds: defaults.roomId ? [defaults.roomId] : [],
        classType: 'LECTURE',
        span: 1,
      } as Parameters<typeof createTimetableEntry>[0],
      'year-1'
    )
    expect(created.id).toBeTruthy()

    const saved = timetableEntryRepository.getWithRelations('year-1').find(e => e.id === created.id)
    expect(saved).toBeTruthy()
    expect(saved!.timeSlotId).toBe(defaults.timeSlotId)
    expect(saved!.sectionId).toBe(defaults.sectionId)
    expect(saved!.roomIds).toEqual([defaults.roomId])

    // Source of truth: read the persisted row + joins straight from SQLite.
    const row = testDb!
      .prepare('SELECT time_slot_id, section_id FROM timetable_entries WHERE id = ?')
      .get(created.id) as { time_slot_id: string; section_id: string }
    expect(row.time_slot_id).toBe(defaults.timeSlotId)
    expect(row.section_id).toBe(defaults.sectionId)
    const roomRow = testDb!
      .prepare('SELECT room_id, position FROM timetable_entry_rooms WHERE entry_id = ?')
      .get(created.id) as { room_id: string; position: number }
    expect(roomRow.room_id).toBe(defaults.roomId)
    expect(roomRow.position).toBe(0)
  })

  it('validation still rejects a genuinely empty state with the exact QA-012 messages (not weakened)', () => {
    let message = ''
    try {
      createTimetableEntry(
        {
          dayOfWeek: 'WEDNESDAY',
          ...defaultsFor(),
          timeSlotId: '',
          sectionId: '',
          facultyIds: [],
          roomIds: [],
          subjectId: 'sub-1',
          classType: 'LECTURE',
          span: 1,
        } as Parameters<typeof createTimetableEntry>[0],
        'year-1'
      )
    } catch (e: any) {
      message = e.message
    }
    expect(message).toMatch(/Time period is required/)
    expect(message).toMatch(/Section is required/)
    expect(message).toMatch(/Faculty is required/) // still hard for LECTURE
    // Room is intentionally NOT required — "Not specified" is a valid state
    // (we never force fabricated rooms onto official activities).
    expect(message).not.toMatch(/Room is required/)
    expect(timetableEntryRepository.getWithRelations('year-1')).toHaveLength(0)
  })

  it('with no data at all the defaults stay empty (no fabricated values)', () => {
    expect(
      buildAddEntryDefaults({ teachingSlots: [], sections: [], rooms: [] })
    ).toEqual({ timeSlotId: '', sectionId: '', roomId: '' })
  })
})

// ---------------------------------------------------------------------------
// Shared substitution fixture for blocks 20–29: one absent teacher who loses
// two Wednesday slot-4 classes; two free, related colleagues as candidates.
// ---------------------------------------------------------------------------
const SUB_DATE = '2024-09-25' // Wednesday — matches the entries below

function seedSubstitutionScenario(): void {
  departmentRepository.create({ id: 'dept-other', name: 'Languages', code: 'LANG' })
  facultyRepository.create({ id: 'fac-3', name: 'Mr. Related', departmentId: 'dept-bca', maxDailySubstitutions: 5 })
  facultyRepository.create({ id: 'fac-4', name: 'Ms. Outsider', departmentId: 'dept-other', maxDailySubstitutions: 5 })
  facultyRepository.setSubjects('fac-3', [{ facultyId: 'fac-3', subjectId: 'sub-1', proficiency: 4 }])
  timetableEntryRepository.create({
    id: 'tt-sub-1', academicYearId: 'year-1', dayOfWeek: 'WEDNESDAY', timeSlotId: 'slot-4',
    sectionId: 'sec-1', subjectId: 'sub-1', facultyIds: ['fac-1'], roomIds: ['room-1'], classType: 'LECTURE', span: 1,
  })
  timetableEntryRepository.create({
    id: 'tt-sub-2', academicYearId: 'year-1', dayOfWeek: 'WEDNESDAY', timeSlotId: 'slot-5',
    sectionId: 'sec-2', subjectId: 'sub-1', facultyIds: ['fac-1'], roomIds: ['room-2'], classType: 'LECTURE', span: 1,
  })
  attendanceRepository.upsert(SUB_DATE, 'fac-1', 'ABSENT')
}

function runRow(): any {
  return testDb!.prepare('SELECT * FROM substitution_runs WHERE date = ?').get(SUB_DATE)
}

function assignmentRow(id: string): any {
  return testDb!.prepare('SELECT * FROM substitution_assignments WHERE id = ?').get(id)
}

// ---------------------------------------------------------------------------
// 20. QA-024: generation result statistics reflect the saved run immediately
// ---------------------------------------------------------------------------
describe('QA-024: generation reports true statistics immediately', () => {
  it('the Locked stat matches the locked rows right after Generate (no refresh needed)', () => {
    seedSubstitutionScenario()
    const first = generateSubstitutions(SUB_DATE)
    expect(first.status).toBe('GENERATED')
    expect(first.statistics.manuallyAssigned).toBe(
      first.assignments.filter(a => a.status === 'LOCKED').length
    )

    const covered = first.assignments.find(a => a.substituteFacultyId)!
    expect(covered).toBeTruthy()
    expect(lockAssignment(covered.id)).toBeTruthy()

    const regen = generateSubstitutions(SUB_DATE)
    const locked = regen.assignments.filter(a => a.status === 'LOCKED')
    expect(locked.length).toBeGreaterThanOrEqual(1)
    // The QA-024 symptom: this used to be hardcoded to 0 until Refresh.
    expect(regen.statistics.manuallyAssigned).toBeGreaterThan(0)
    expect(regen.statistics.manuallyAssigned).toBe(locked.length)

    // …and it agrees with what a later reload shows.
    const reloaded = getSubstitutionRun(SUB_DATE)!
    expect(reloaded.statistics.manuallyAssigned).toBe(regen.statistics.manuallyAssigned)
  })

  it('covered/uncovered statistics are counted from the persisted rows', () => {
    seedSubstitutionScenario()
    const result = generateSubstitutions(SUB_DATE)
    const persisted = substitutionAssignmentRepository.findByRunWithRelations(result.runId)
    expect(result.assignments).toHaveLength(persisted.length)
    expect(result.statistics.covered).toBe(persisted.filter(a => a.substituteFacultyId).length)
    expect(result.statistics.uncovered).toBe(persisted.filter(a => !a.substituteFacultyId).length)
    expect(result.statistics.totalAffected).toBeGreaterThanOrEqual(persisted.length)
  })
})

// ---------------------------------------------------------------------------
// 21. QA-025: stale reasoning belonging to a removed substitute
// ---------------------------------------------------------------------------
describe('QA-025: uncovered rows never show a removed substitute reasoning', () => {
  it('removing a substitute replaces the positive reasoning and clears the score', () => {
    seedSubstitutionScenario()
    const result = generateSubstitutions(SUB_DATE)
    const covered = result.assignments.find(a => a.substituteFacultyId)!
    const oldReasoning = covered.reasoning
    expect(oldReasoning).toBeTruthy()
    expect(covered.score).not.toBeNull()

    expect(updateSubstitutionAssignment(covered.id, { substituteFacultyId: null })).toBeTruthy()

    const run = getSubstitutionRun(SUB_DATE)!
    const row = run.assignments.find(a => a.id === covered.id)!
    expect(row.substituteFacultyId).toBeNull()
    expect(row.reasoning).toMatch(/removed by coordinator/i)
    expect(row.reasoning).not.toBe(oldReasoning)
    expect(row.score).toBeNull()

    // The Uncovered card's reason must be truthful too — not the old
    // candidate's praise ("normally teaches this class…").
    const uncovered = run.uncovered.find(u => u.originalEntryId === covered.originalEntryId)
    expect(uncovered).toBeTruthy()
    expect(uncovered!.reason).toMatch(/removed by coordinator/i)
  })

  it('re-picking a different substitute replaces the previous candidate reasoning and score', () => {
    seedSubstitutionScenario()
    const result = generateSubstitutions(SUB_DATE)
    const covered = result.assignments.find(a => a.substituteFacultyId)!
    const oldReasoning = covered.reasoning
    const replacement = availableSubstitutesForAssignment(covered.id).find(
      f => f.id !== covered.substituteFacultyId
    )
    expect(replacement).toBeTruthy()
    expect(
      updateSubstitutionAssignment(covered.id, { substituteFacultyId: replacement!.id })
    ).toBeTruthy()

    const row = getSubstitutionRun(SUB_DATE)!.assignments.find(a => a.id === covered.id)!
    expect(row.substituteFacultyId).toBe(replacement!.id)
    expect(row.reasoning).toMatch(/manually assigned by coordinator/i)
    expect(row.reasoning).not.toBe(oldReasoning)
    expect(row.score).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// 22. QA-023: APPROVED is a visible, never-stale lifecycle state
// ---------------------------------------------------------------------------
describe('QA-023: approval lifecycle is visible and never stale', () => {
  it('the run result carries APPROVED status and approval metadata', () => {
    seedSubstitutionScenario()
    generateSubstitutions(SUB_DATE)
    expect(approveSubstitutionRun(SUB_DATE, 'QA Coordinator')).toBeTruthy()
    const run = getSubstitutionRun(SUB_DATE)!
    expect(run.status).toBe('APPROVED')
    expect(run.approvedBy).toBe('QA Coordinator')
    expect(run.approvedAt).toBeTruthy()
  })

  it('editing an approved plan reopens it and clears the approval metadata', () => {
    seedSubstitutionScenario()
    generateSubstitutions(SUB_DATE)
    approveSubstitutionRun(SUB_DATE, 'QA Coordinator')
    const covered = getSubstitutionRun(SUB_DATE)!.assignments.find(a => a.substituteFacultyId)!
    const replacement = availableSubstitutesForAssignment(covered.id).find(
      f => f.id !== covered.substituteFacultyId
    )!
    expect(
      updateSubstitutionAssignment(covered.id, { substituteFacultyId: replacement.id })
    ).toBeTruthy()

    const row = runRow()
    expect(row.status).toBe('GENERATED')
    expect(row.approved_by).toBeNull()
    expect(row.approved_at).toBeNull()
    // …and the result the planner renders agrees with the database.
    expect(getSubstitutionRun(SUB_DATE)!.status).toBe('GENERATED')
  })

  it('regenerating an approved plan clears approval metadata (no stale approver)', () => {
    seedSubstitutionScenario()
    generateSubstitutions(SUB_DATE)
    approveSubstitutionRun(SUB_DATE, 'QA Coordinator')
    generateSubstitutions(SUB_DATE)

    const row = runRow()
    expect(row.status).toBe('GENERATED')
    expect(row.approved_by).toBeNull()
    expect(row.approved_at).toBeNull()
  })

  it('locking an assignment after approval reopens the plan as well', () => {
    seedSubstitutionScenario()
    generateSubstitutions(SUB_DATE)
    approveSubstitutionRun(SUB_DATE, 'QA Coordinator')
    const covered = getSubstitutionRun(SUB_DATE)!.assignments.find(a => a.substituteFacultyId)!
    expect(lockAssignment(covered.id)).toBeTruthy()

    const row = runRow()
    expect(row.status).toBe('GENERATED')
    expect(row.approved_by).toBeNull()
    expect(row.approved_at).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// 23. QA-021: uncovered rows resolve to a real assignment the picker can use
// ---------------------------------------------------------------------------
describe('QA-021: the uncovered card opens a picker that actually works', () => {
  it('the synthetic id:"" never resolves, but the real uncovered row does', () => {
    seedSubstitutionScenario()
    // Force every affected class uncovered (generation-level daily cap = 0).
    settingsRepository.set('max_daily_substitutions', '0', 'Maximum daily substitutions per faculty')
    const result = generateSubstitutions(SUB_DATE)
    expect(result.uncovered.length).toBeGreaterThan(0)

    const uncoveredRow = result.assignments.find(a => !a.substituteFacultyId)
    expect(uncoveredRow).toBeTruthy()

    // The pre-fix UI sent id:'' — it could never produce a single option.
    expect(availableSubstitutesForAssignment('')).toEqual([])

    // The real row resolves to a usable picker, and every option it offers
    // is accepted by the very function the dialog calls on submit.
    const options = availableSubstitutesForAssignment(uncoveredRow!.id)
    expect(options.length).toBeGreaterThan(0)
    expect(
      updateSubstitutionAssignment(uncoveredRow!.id, { substituteFacultyId: options[0].id })
    ).toBeTruthy()
  })
})

// ---------------------------------------------------------------------------
// 24. Hard constraint (e): outside working hours can never receive substitutions
// ---------------------------------------------------------------------------
describe('hard constraint: periods outside working hours', () => {
  it('neither generation nor the manual validator places a substitute out of hours', () => {
    seedSubstitutionScenario()
    expect(settingsRepository.getWorkingHours().startTime).toBe('09:00')
    expect(settingsRepository.getWorkingHours().endTime).toBe('16:00')

    const early = timeSlotRepository.create({
      id: 'slot-early', name: '07:00-08:00', startTime: '07:00', endTime: '08:00',
    })
    timetableEntryRepository.create({
      id: 'tt-early', academicYearId: 'year-1', dayOfWeek: 'WEDNESDAY', timeSlotId: early.id,
      sectionId: 'sec-1', subjectId: 'sub-1', facultyIds: ['fac-1'], roomIds: ['room-1'], classType: 'LECTURE', span: 1,
    })

    const result = generateSubstitutions(SUB_DATE)
    expect(result.uncovered.some(u => u.originalEntryId === 'tt-early')).toBe(true)
    const earlyRow = result.assignments.find(a => a.originalEntryId === 'tt-early')
    expect(earlyRow).toBeTruthy()
    expect(earlyRow!.substituteFacultyId).toBeNull()

    // Manual override refuses the same period with a clear reason.
    const entry = timetableEntryRepository.getWithRelations('year-1').find(e => e.id === 'tt-early')!
    const check = validateSubstitute(
      {
        date: SUB_DATE,
        academicYearId: 'year-1',
        dayOfWeek: 'WEDNESDAY',
        timeSlotId: early.id,
        isBreak: false,
        entryId: entry.id,
        entry,
      },
      'fac-3'
    )
    expect(check.ok).toBe(false)
    expect(check.reason).toMatch(/outside working hours/i)
  })
})

// ---------------------------------------------------------------------------
// 25. Hard constraint (j): unrelated (P5) faculty only when configured
// ---------------------------------------------------------------------------
describe('hard constraint: unrelated faculty only when configuration allows', () => {
  function slotForCovered() {
    const result = generateSubstitutions(SUB_DATE)
    const covered = result.assignments.find(a => a.substituteFacultyId)!
    const entry = timetableEntryRepository.getWithRelations('year-1').find(e => e.id === covered.originalEntryId)!
    return {
      covered,
      slot: {
        date: SUB_DATE,
        academicYearId: 'year-1',
        dayOfWeek: entry.dayOfWeek,
        timeSlotId: entry.timeSlotId,
        isBreak: false,
        entryId: entry.id,
        entry,
      },
    }
  }

  it('the manual validator and picker refuse unrelated faculty while the setting is off', () => {
    seedSubstitutionScenario()
    const { covered, slot } = slotForCovered()

    settingsRepository.setAllowUnrelatedSubstitutions(false)
    const check = validateSubstitute(slot, 'fac-4') // other dept, no mappings — P5
    expect(check.ok).toBe(false)
    expect(check.reason).toMatch(/not related/i)
    expect(
      availableSubstitutesForAssignment(covered.id).some(f => f.id === 'fac-4')
    ).toBe(false)
  })

  it('the same faculty is allowed when unrelated substitutions are enabled', () => {
    seedSubstitutionScenario()
    const { slot } = slotForCovered()

    settingsRepository.setAllowUnrelatedSubstitutions(true)
    const check = validateSubstitute(slot, 'fac-4')
    expect(check.ok).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 26. Integrity: multi-statement writes are atomic
// ---------------------------------------------------------------------------
describe('integrity: multi-statement writes are atomic', () => {
  it('a failed subject-mapping save rolls back instead of wiping the old mappings', () => {
    facultyRepository.setSubjects('fac-1', [{ facultyId: 'fac-1', subjectId: 'sub-1', proficiency: 5 }])
    expect(facultyRepository.getSubjects('fac-1')).toHaveLength(1)

    expect(() =>
      facultyRepository.setSubjects('fac-1', [
        { facultyId: 'fac-1', subjectId: 'ghost-subject', proficiency: 5 },
      ])
    ).toThrow() // foreign-key violation

    // Rollback preserved the original mapping (pre-fix: it was already deleted).
    const after = facultyRepository.getSubjects('fac-1')
    expect(after).toHaveLength(1)
    expect(after[0].subjectId).toBe('sub-1')
  })

  it('a failed section-mapping save rolls back the same way', () => {
    facultyRepository.setSections('fac-1', ['sec-1'])
    expect(facultyRepository.getSections('fac-1')).toHaveLength(1)
    expect(() => facultyRepository.setSections('fac-1', ['ghost-section'])).toThrow()
    const after = facultyRepository.getSections('fac-1')
    expect(after).toHaveLength(1)
    expect(after[0].sectionId).toBe('sec-1')
  })

  it('switching the active academic year always leaves exactly one active year', () => {
    academicYearRepository.create({
      id: 'year-2', name: '2025-2026', startDate: '2025-06-01', endDate: '2026-05-31', isActive: false,
    })
    academicYearRepository.setActive('year-2')
    let actives = testDb!.prepare('SELECT id FROM academic_years WHERE is_active = 1').all() as any[]
    expect(actives).toHaveLength(1)
    expect(actives[0].id).toBe('year-2')

    academicYearRepository.setActive('year-1')
    actives = testDb!.prepare('SELECT id FROM academic_years WHERE is_active = 1').all() as any[]
    expect(actives).toHaveLength(1)
    expect(actives[0].id).toBe('year-1')
  })
})

// ---------------------------------------------------------------------------
// 27. Integrity: a plain settings set() keeps the stored description
// ---------------------------------------------------------------------------
describe('integrity: settings writes do not destroy metadata', () => {
  it('set(key, value) preserves the row description', () => {
    settingsRepository.set('qa_test_key', 'v1', 'Original description')
    settingsRepository.set('qa_test_key', 'v2')
    const row = testDb!
      .prepare('SELECT value, description FROM application_settings WHERE key = ?')
      .get('qa_test_key') as { value: string; description: string | null }
    expect(row.value).toBe('v2')
    expect(row.description).toBe('Original description')
  })
})

// ---------------------------------------------------------------------------
// 28. Integrity: assignment status and is_locked never diverge
// ---------------------------------------------------------------------------
describe('integrity: status and is_locked never diverge', () => {
  it("status: 'LOCKED' also sets is_locked, and the row survives regeneration", () => {
    seedSubstitutionScenario()
    const result = generateSubstitutions(SUB_DATE)
    const covered = result.assignments.find(a => a.substituteFacultyId)!
    const substitute = covered.substituteFacultyId

    expect(updateSubstitutionAssignment(covered.id, { status: 'LOCKED' })).toBeTruthy()
    let row = assignmentRow(covered.id)
    expect(row.status).toBe('LOCKED')
    expect(row.is_locked).toBe(1)

    expect(updateSubstitutionAssignment(covered.id, { status: 'PENDING' })).toBeTruthy()
    row = assignmentRow(covered.id)
    expect(row.status).toBe('PENDING')
    expect(row.is_locked).toBe(0)

    // Locked for real (both fields), then regenerate: keyed on is_locked=1,
    // the row must survive with its substitute intact.
    expect(updateSubstitutionAssignment(covered.id, { status: 'LOCKED' })).toBeTruthy()
    generateSubstitutions(SUB_DATE)
    row = assignmentRow(covered.id)
    expect(row.status).toBe('LOCKED')
    expect(row.is_locked).toBe(1)
    expect(row.substitute_faculty_id).toBe(substitute)
  })
})

// ---------------------------------------------------------------------------
// 29. QA-026: the revised-timetable service returns a truthful day view
// ---------------------------------------------------------------------------
describe('QA-026: getRevisedTimetable returns a truthful revised day view', () => {
  it('covers every period of the day with per-row substitution status', () => {
    seedSubstitutionScenario()
    generateSubstitutions(SUB_DATE)

    const revised = getRevisedTimetable(SUB_DATE)
    expect(revised.length).toBeGreaterThanOrEqual(2)
    for (const row of revised) {
      expect(row.originalEntry).toBeTruthy()
      expect(row.originalEntry.timeSlot).toBeTruthy()
      expect(row.originalEntry.section).toBeTruthy()
      expect(row.originalEntry.subject).toBeTruthy()
      expect(row.originalEntry.faculty).toBeTruthy()
    }

    const substituted = revised.filter(r => r.isSubstituted)
    expect(substituted.length).toBeGreaterThanOrEqual(1)
    for (const row of substituted) {
      expect(row.substitution?.substituteFacultyId).toBeTruthy()
      expect(row.substituteFaculty?.name).toBeTruthy()
    }
    // isSubstituted is exactly "has a substitute" — never optimistic.
    expect(revised.every(r => r.isSubstituted === !!r.substitution?.substituteFacultyId)).toBe(true)
  })

  it('a date with no run returns rows with no substitutions (nothing invented)', () => {
    seedSubstitutionScenario()
    const revised = getRevisedTimetable(SUB_DATE)
    expect(revised.length).toBeGreaterThanOrEqual(2)
    expect(revised.some(r => r.isSubstituted)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 30. Locked means locked — even when the disabled control is bypassed
//     (found by acceptance test 39R.P10.3b: the service accepted a substitute
//     change on a LOCKED row and silently reopened the approved run)
// ---------------------------------------------------------------------------
describe('locked assignment refuses substitute changes at the service layer', () => {
  it('throws with a locked message, leaves substitute + lock intact, and only unlocks through status', () => {
    seedSubstitutionScenario()
    const result = generateSubstitutions(SUB_DATE)
    const covered = result.assignments.find(a => a.substituteFacultyId)!
    const substitute = covered.substituteFacultyId

    expect(updateSubstitutionAssignment(covered.id, { status: 'LOCKED' })).toBeTruthy()

    // The guard must fire BEFORE constraint validation — an arbitrary id is
    // rejected for being locked, not for being invalid.
    expect(() => updateSubstitutionAssignment(covered.id, { substituteFacultyId: 'fac-bypassed' }))
      .toThrow(/locked/i)

    let row = assignmentRow(covered.id)
    expect(row.substitute_faculty_id).toBe(substitute)
    expect(row.is_locked).toBe(1)
    expect(row.status).toBe('LOCKED')

    // The guard is narrow: unlocking via status still works, and once
    // unlocked a substitute change is accepted again.
    expect(updateSubstitutionAssignment(covered.id, { status: 'PENDING' })).toBeTruthy()
    row = assignmentRow(covered.id)
    expect(row.is_locked).toBe(0)
    expect(updateSubstitutionAssignment(covered.id, { substituteFacultyId: null })).toBeTruthy()
    expect(assignmentRow(covered.id).substitute_faculty_id).toBeFalsy()
  })
})
