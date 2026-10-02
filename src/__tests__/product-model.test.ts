/**
 * Product / data-model correctness tests (phase 38).
 *
 * Covers the new model the coordinator actually works with:
 *
 *  1. Multi-faculty entries: CRUD + duplicate prevention via join tables.
 *  2. Faculty-less activities: valid for LIBRARY/MENTORING/…, still refused
 *     for LECTURE/LAB (validation is never globally weakened).
 *  3. Span validation: contiguity, cannot cross the break, cannot run past
 *     the end of the day, breaks never receive entries.
 *  4. Span-aware conflicts: faculty/room/section clashes reported in BOTH
 *     directions with coordinator-readable messages.
 *  5. Span-aware substitution: a substitute is reserved for the whole
 *     activity — no partial double-booking of a 2-hour lab's second hour.
 *  6. Multi-faculty absence policy: TEAM_SUFFICIENT (default) vs
 *     REPLACE_ABSENT; all-absent is always affected; faculty-less never is.
 *  7. Daily substitution limit counts spans as one assignment.
 *  8. Run lifecycle derivation (NOT_STARTED → … → LOCKED).
 *  9. Audit trail: real actions only, never fabricated rows.
 * 1. Terms: "which timetable is effective today?".
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import { schema } from '@/db/schema'
import { timeSlotRepository } from '@/db/repositories/timeSlot'
import { timetableEntryRepository } from '@/db/repositories/timetableEntry'
import { settingsRepository } from '@/db/repositories/settings'
import { academicYearRepository } from '@/db/repositories/academicYear'
import { termRepository } from '@/db/repositories/term'
import { departmentRepository } from '@/db/repositories/department'
import { facultyRepository } from '@/db/repositories/faculty'
import { subjectRepository } from '@/db/repositories/subject'
import { sectionRepository } from '@/db/repositories/section'
import { attendanceRepository } from '@/db/repositories/attendance'
import { auditLogRepository, AUDIT_ACTIONS } from '@/db/repositories/auditLog'
import { substitutionRunRepository } from '@/db/repositories/substitutionRun'
import {
  createTimetableEntry,
  updateTimetableEntry,
  validateTimetableEntryInput,
  detectConflicts,
  resolveCoveredSlots,
  coveredSlotsOf,
  timeRangeLabel,
} from '@/services/timetable'
import {
  generateSubstitutions,
  getRunLifecycle,
  RUN_LIFECYCLE_LABELS,
} from '@/services/substitution'
import { findAffectedEntries } from '@/services/substitution/engine'
import type { MultiFacultyAbsencePolicy, ClassType, DayOfWeek } from '@/types'

let testDb: Database.Database | null = null

vi.mock('@/db/database', () => ({
  getDatabase: () => testDb,
  closeDatabase: () => undefined,
}))

const YEAR = 'year-1'
const DATE = '2024-09-25' // Wednesday

function seed(): void {
  departmentRepository.create({ id: 'dept-bca', name: 'BCA', code: 'BCA' })
  academicYearRepository.create({
    id: YEAR,
    name: '2024-2025',
    startDate: '2024-06-01',
    endDate: '2025-05-31',
    isActive: true,
  })
  timeSlotRepository.initializeDefaults()
  for (const [id, name] of [
    ['fac-a', 'Mrs. Alpha'],
    ['fac-b', 'Mrs. Beta'],
    ['fac-c', 'Mrs. Gamma'],
    ['fac-d', 'Mrs. Delta'],
  ] as [string, string][]) {
    facultyRepository.create({ id, name, departmentId: 'dept-bca', isActive: true, maxDailySubstitutions: 3 })
  }
  subjectRepository.create({ id: 'sub-lab', name: 'DBMS Lab', code: 'DBMS', departmentId: 'dept-bca', defaultClassType: 'LAB' })
  subjectRepository.create({ id: 'sub-lect', name: 'DBMS', code: 'DBM', departmentId: 'dept-bca', defaultClassType: 'LECTURE' })
  subjectRepository.create({ id: 'sub-lib', name: 'Library', code: 'LIB', departmentId: 'dept-bca', defaultClassType: 'LIBRARY' })
  sectionRepository.create({ id: 'sec-b', name: 'III BCA-B', semester: 5, departmentId: 'dept-bca', academicYearId: YEAR })
  sectionRepository.create({ id: 'sec-a', name: 'III BCA-A', semester: 5, departmentId: 'dept-bca', academicYearId: YEAR })
  for (const fid of ['fac-a', 'fac-b', 'fac-c', 'fac-d']) {
    facultyRepository.setSubjects(fid, [
      { facultyId: fid, subjectId: 'sub-lab', proficiency: 5 },
      { facultyId: fid, subjectId: 'sub-lect', proficiency: 5 },
      { facultyId: fid, subjectId: 'sub-lib', proficiency: 5 },
    ])
  }
  settingsRepository.setMultiFacultyAbsencePolicy('TEAM_SUFFICIENT')
}

beforeEach(() => {
  if (testDb) testDb.close()
  testDb = new Database(':memory:')
  testDb.pragma('foreign_keys = ON')
  testDb.exec(schema)
  seed()
})

afterEach(() => {
  if (testDb) {
    testDb.close()
    testDb = null
  }
})

const base = (overrides: Record<string, unknown> = {}) => ({
  dayOfWeek: 'WEDNESDAY' as DayOfWeek,
  timeSlotId: 'slot-1',
  sectionId: 'sec-b',
  subjectId: 'sub-lab',
  facultyIds: ['fac-a', 'fac-b'],
  roomIds: ['room-1'],
  classType: 'LAB' as ClassType,
  span: 2,
  ...overrides,
})

// ---------------------------------------------------------------------------
// 1. Multi-faculty entries
// ---------------------------------------------------------------------------
describe('multi-faculty timetable entries', () => {
  it('persists an ordered team and every room in the join tables', () => {
    testDb!.prepare('INSERT INTO rooms (id, name, capacity, type) VALUES (?,?,?,?)').run('room-1', 'Lab 1', 40, 'LAB')
    testDb!.prepare('INSERT INTO rooms (id, name, capacity, type) VALUES (?,?,?,?)').run('room-2', 'Lab 2', 40, 'LAB')

    const created = createTimetableEntry(base({ roomIds: ['room-1', 'room-2'] }), YEAR)

    const team = testDb!
      .prepare('SELECT faculty_id, position FROM timetable_entry_faculty WHERE entry_id = ? ORDER BY position')
      .all(created.id) as { faculty_id: string; position: number }[]
    expect(team.map(t => t.faculty_id)).toEqual(['fac-a', 'fac-b'])
    expect(team.map(t => t.position)).toEqual([0, 1]) // position 0 = lead

    const rooms = testDb!
      .prepare('SELECT room_id, position FROM timetable_entry_rooms WHERE entry_id = ? ORDER BY position')
      .all(created.id) as { room_id: string; position: number }[]
    expect(rooms.map(r => r.room_id)).toEqual(['room-1', 'room-2'])

    // Reads hydrate both the lead and the full lists.
    const loaded = timetableEntryRepository.getWithRelations(YEAR).find(e => e.id === created.id)!
    expect(loaded.faculty?.id).toBe('fac-a')
    expect(loaded.facultyIds).toEqual(['fac-a', 'fac-b'])
    expect(loaded.roomIds).toEqual(['room-1', 'room-2'])
    expect(loaded.span).toBe(2)
  })

  it('rejects the same faculty member twice', () => {
    testDb!.prepare('INSERT INTO rooms (id, name, capacity, type) VALUES (?,?,?,?)').run('room-1', 'Lab 1', 40, 'LAB')
    const errors = validateTimetableEntryInput(base({ facultyIds: ['fac-a', 'fac-a'] }))
    expect(errors).toContain('Each faculty member can only be added once.')
  })

  it('updates replace the whole team (no stale join rows left behind)', () => {
    testDb!.prepare('INSERT INTO rooms (id, name, capacity, type) VALUES (?,?,?,?)').run('room-1', 'Lab 1', 40, 'LAB')
    const created = createTimetableEntry(base(), YEAR)
    updateTimetableEntry(created.id, base({ facultyIds: ['fac-c'], span: 1 }))

    const team = testDb!
      .prepare('SELECT faculty_id FROM timetable_entry_faculty WHERE entry_id = ?')
      .all(created.id) as { faculty_id: string }[]
    expect(team.map(t => t.faculty_id)).toEqual(['fac-c'])
  })

  it('a team teaches without double-booking any member (same slot, other class)', () => {
    testDb!.prepare('INSERT INTO rooms (id, name, capacity, type) VALUES (?,?,?,?)').run('room-1', 'Lab 1', 40, 'LAB')
    testDb!.prepare('INSERT INTO rooms (id, name, capacity, type) VALUES (?,?,?,?)').run('room-2', 'Lab 2', 40, 'LAB')
    createTimetableEntry(base(), YEAR)

    // The SECOND team member is already busy → faculty conflict, not silence.
    const conflicts = detectConflicts(
      base({ sectionId: 'sec-a', roomIds: ['room-2'] }),
      YEAR
    )
    const facultyConflicts = conflicts.filter(c => c.kind === 'faculty')
    expect(facultyConflicts.map(c => c.message).join('\n')).toContain('Mrs. Alpha')
    expect(facultyConflicts.map(c => c.message).join('\n')).toContain('Mrs. Beta')
  })
})

// ---------------------------------------------------------------------------
// 2. Faculty-less activities by type
// ---------------------------------------------------------------------------
describe('faculty-less activities (activity type as data)', () => {
  it('LIBRARY / MENTORING / TUTORIAL may have no faculty; LECTURE and LAB may not', () => {
    const typesWithouFaculty: ClassType[] = ['LIBRARY', 'MENTORING', 'TUTORIAL', 'SKILL_BUILD', 'COE', 'OTHER']
    for (const classType of typesWithouFaculty) {
      expect(validateTimetableEntryInput(base({ facultyIds: [], classType, subjectId: 'sub-lib' }))).toEqual([])
    }
    expect(validateTimetableEntryInput(base({ facultyIds: [], classType: 'LECTURE', subjectId: 'sub-lect' }))).toContain(
      'Faculty is required.'
    )
    expect(validateTimetableEntryInput(base({ facultyIds: [], classType: 'LAB', subjectId: 'sub-lab' }))).toContain(
      'At least one faculty member is required for a lab.'
    )
  })

  it('a faculty-less activity saves and is never "affected" by an absence', () => {
    const created = createTimetableEntry(
      base({ facultyIds: [], classType: 'LIBRARY', subjectId: 'sub-lib', span: 1, roomIds: [] }),
      YEAR
    )
    expect(timetableEntryRepository.findById(created.id)!.facultyIds).toEqual([])

    attendanceRepository.upsert(DATE, 'fac-a', 'ABSENT')
    const affected = findAffectedEntries(new Set(['fac-a']), 'WEDNESDAY', YEAR)
    expect(affected.some(e => e.id === created.id)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 3. Span validation
// ---------------------------------------------------------------------------
describe('span (duration) validation', () => {
  it('resolves contiguous periods and labels the range', () => {
    const result = resolveCoveredSlots('slot-1', 2)
    expect('slots' in result && result.slots.map(s => s.id)).toEqual(['slot-1', 'slot-2'])
    expect(timeRangeLabel('slot-1', 2)).toMatch(/^09:00–11:00$/)
    expect(timeRangeLabel('slot-1', 1)).toMatch(/^09:00–10:00$/)
  })

  it('refuses a duration that would cross the break', () => {
    // slot-4 is 12:00-13:00, slot-5 is the 13:00-14:00 break.
    const breakSlot = timeSlotRepository.getBreakSlots()[0]
    expect(breakSlot).toBeTruthy()
    const before = timeSlotRepository.getOrdered().find(s => s.order === breakSlot.order - 1)!
    const result = resolveCoveredSlots(before.id, 2)
    expect('error' in result && result.error).toMatch(/across the break/i)
  })

  it('refuses a duration that would run past the last period of the day', () => {
    const last = timeSlotRepository.getOrdered().filter(s => !s.isBreak).at(-1)!
    const result = resolveCoveredSlots(last.id, 3)
    expect('error' in result && result.error).toMatch(/past the last period/i)
  })

  it('never accepts a break period as the start of an activity', () => {
    const breakSlot = timeSlotRepository.getBreakSlots()[0]
    const errors = validateTimetableEntryInput(base({ timeSlotId: breakSlot.id }))
    expect(errors.join('\n')).toMatch(/break/i)
  })

  it('covers exactly span slots (clamped at a break for legacy rows)', () => {
    const slots = timeSlotRepository.getOrdered()
    const breakSlot = slots.find(s => s.isBreak)!
    const before = slots.find(s => s.order === breakSlot.order - 1)!
    const covered = coveredSlotsOf({ timeSlotId: before.id, span: 3 }, slots)
    expect(covered.map(s => s.id)).toEqual([before.id]) // clamped — never eats the break
    expect(coveredSlotsOf({ timeSlotId: 'slot-1', span: 2 }, slots).map(s => s.id)).toEqual(['slot-1', 'slot-2'])
  })
})

// ---------------------------------------------------------------------------
// 4. Span-aware conflicts
// ---------------------------------------------------------------------------
describe('span-aware conflict detection', () => {
  beforeEach(() => {
    for (const id of ['room-1', 'room-2']) {
      testDb!.prepare('INSERT INTO rooms (id, name, capacity, type) VALUES (?,?,?,?)').run(id, id, 40, 'LAB')
    }
    createTimetableEntry(base(), YEAR) // sec-b, fac-a+fac-b, room-1, slot-1..slot-2
  })

  it('detects an overlap of the SECOND hour (not only the start slot)', () => {
    const conflicts = detectConflicts(
      base({ sectionId: 'sec-a', timeSlotId: 'slot-2', facultyIds: ['fac-c'], roomIds: ['room-2'] }),
      YEAR
    )
    expect(conflicts.some(c => c.kind === 'section' && /slot|already/i.test(c.message))).toBe(false) // other class
    // fac-a/fac-b's existing entry starts at slot-1 and covers slot-2 → clash.
    const faculty = detectConflicts(
      base({ sectionId: 'sec-a', timeSlotId: 'slot-2', facultyIds: ['fac-a'], roomIds: ['room-2'] }),
      YEAR
    )
    expect(faculty.some(c => c.kind === 'faculty')).toBe(true)
  })

  it('detects a NEW activity that starts while an existing long activity runs', () => {
    // Existing entry spans slot-1..slot-2; a slot-2 single period clashes too.
    const conflicts = detectConflicts(
      base({ sectionId: 'sec-b', timeSlotId: 'slot-2', facultyIds: ['fac-c'], roomIds: ['room-2'], span: 1 }),
      YEAR
    )
    expect(conflicts.some(c => c.kind === 'section')).toBe(true)
    expect(conflicts[0].message).toMatch(/already has/)
  })

  it('detects room reuse across the span with a readable message', () => {
    const conflicts = detectConflicts(
      base({ sectionId: 'sec-a', timeSlotId: 'slot-2', facultyIds: ['fac-c'], roomIds: ['room-1'], span: 1 }),
      YEAR
    )
    expect(conflicts.some(c => c.kind === 'room' && /already booked by/.test(c.message))).toBe(true)
  })

  it('reports the TRUE time range of the clash (order must not be used as an array index)', () => {
    // The existing entry is slot-1..slot-2 = 09:00–11:00. time_slots.order is
    // 1-based; indexing the sorted array with it printed 10:00–12:00 — every
    // conflict message read one period late.
    const conflicts = detectConflicts(
      base({ sectionId: 'sec-b', timeSlotId: 'slot-2', facultyIds: ['fac-c'], roomIds: ['room-2'], span: 1 }),
      YEAR
    )
    const section = conflicts.find(c => c.kind === 'section')
    expect(section).toBeTruthy()
    expect(section!.message).toContain('09:00–11:00')
  })

  it('describes a clash in the LAST period of the day without crashing', () => {
    // Regression: the last slot (order 7) is past the end of the 0-based
    // array — describeRange threw "Cannot read properties of undefined
    // (reading 'startTime')" and the coordinator saw a raw JS error instead
    // of the keep/replace dialog.
    const last = timeSlotRepository.getOrdered().filter(s => !s.isBreak).at(-1)!
    createTimetableEntry(base({ timeSlotId: last.id, span: 1, facultyIds: ['fac-c'], roomIds: ['room-2'] }), YEAR)
    const conflicts = detectConflicts(
      base({ timeSlotId: last.id, span: 1, facultyIds: ['fac-c'], roomIds: ['room-2'] }),
      YEAR
    )
    const section = conflicts.find(c => c.kind === 'section')
    expect(section).toBeTruthy()
    expect(section!.message).toContain(`${last.startTime}–${last.endTime}`)
  })

  it('allows a non-overlapping activity in the very next free period', () => {
    const conflicts = detectConflicts(
      base({ sectionId: 'sec-a', timeSlotId: 'slot-3', facultyIds: ['fac-c'], roomIds: ['room-2'], span: 1 }),
      YEAR
    )
    expect(conflicts).toEqual([])
  })

  it('conflict errors carry the structured list for the keep/replace dialog', () => {
    let thrown: any = null
    try {
      createTimetableEntry(
        base({ sectionId: 'sec-a', timeSlotId: 'slot-2', facultyIds: ['fac-a'], roomIds: ['room-1'] }),
        YEAR
      )
    } catch (e) {
      thrown = e
    }
    expect(thrown?.name).toBe('TimetableConflictError')
    expect(Array.isArray(thrown?.conflicts)).toBe(true)
    expect(thrown.conflicts.length).toBeGreaterThan(0)
    for (const c of thrown.conflicts) {
      expect(c.kind).toMatch(/section|faculty|room/)
      expect(typeof c.message).toBe('string')
      expect(c.entryId).toBeTruthy()
    }
  })
})

// ---------------------------------------------------------------------------
// 5 + 6 + 7. Engine: span-aware substitution, team policies, daily limit
// ---------------------------------------------------------------------------
describe('substitution engine: span, team policy and limits', () => {
  /** fac-a loses a 2-period lab (slot-1..slot-2); fac-b/c/d are candidates. */
  function seedLab(overrides: Record<string, unknown> = {}): void {
    testDb!.prepare('INSERT INTO rooms (id, name, capacity, type) VALUES (?,?,?,?)').run('room-1', 'Lab 1', 40, 'LAB')
    testDb!.prepare('INSERT INTO rooms (id, name, capacity, type) VALUES (?,?,?,?)').run('room-2', 'Lab 2', 40, 'LAB')
    // The lab itself: ONE activity, two periods, taught by fac-a alone.
    createTimetableEntry(base({ facultyIds: ['fac-a'], ...overrides }), YEAR)
    attendanceRepository.upsert(DATE, 'fac-a', 'ABSENT')
  }

  it('reserves the substitute for BOTH periods (no partial double-booking)', () => {
    seedLab()
    // fac-c is free at slot-1 (the lab's FIRST period) but teaches in
    // slot-2 (its SECOND period) → a start-slot-only engine would pick her
    // and double-book hour two. A span-aware engine must not.
    createTimetableEntry(
      base({ sectionId: 'sec-a', subjectId: 'sub-lect', facultyIds: ['fac-c'], roomIds: ['room-2'], span: 1, timeSlotId: 'slot-2' }),
      YEAR
    )

    const result = generateSubstitutions(DATE)
    const forLab = result.assignments.find(a => a.substituteFacultyId)
    expect(result.assignments.some(a => a.substituteFacultyId === 'fac-c')).toBe(false)
    expect(forLab).toBeTruthy()

    // The one who IS picked must not be teaching in slot-1 or slot-2.
    const substituteId = forLab!.substituteFacultyId!
    const busy = timetableEntryRepository
      .getWithRelations(YEAR)
      .filter(e => e.facultyIds.includes(substituteId) && ['slot-1', 'slot-2'].includes(e.timeSlotId))
    expect(busy).toHaveLength(0)
  })

  it('daily limit counts a 2-period activity as ONE substitution', () => {
    seedLab()
    settingsRepository.setMaxDailySubstitutions(1)
    const result = generateSubstitutions(DATE)
    const covered = result.assignments.filter(a => a.substituteFacultyId)
    expect(covered).toHaveLength(1) // one activity = one count, even at span 2
    expect(result.statistics.totalAffected).toBe(1)
  })

  describe('multi-faculty absence policy', () => {
    function seedTeam(): void {
      testDb!.prepare('INSERT INTO rooms (id, name, capacity, type) VALUES (?,?,?,?)').run('room-1', 'Lab 1', 40, 'LAB')
      createTimetableEntry(base(), YEAR) // team = fac-a + fac-b
    }

    it('TEAM_SUFFICIENT (default): the remaining team runs the lab — not affected', () => {
      seedTeam()
      expect(settingsRepository.getMultiFacultyAbsencePolicy()).toBe('TEAM_SUFFICIENT')
      attendanceRepository.upsert(DATE, 'fac-a', 'ABSENT')
      const affected = findAffectedEntries(new Set(['fac-a']), 'WEDNESDAY', YEAR)
      expect(affected).toHaveLength(0)

      const result = generateSubstitutions(DATE)
      expect(result.assignments).toHaveLength(0)
      expect(result.statistics.totalAffected).toBe(0)
    })

    it('TEAM_SUFFICIENT: ALL faculty absent → still affected (class cannot run)', () => {
      seedTeam()
      attendanceRepository.upsert(DATE, 'fac-a', 'ABSENT')
      attendanceRepository.upsert(DATE, 'fac-b', 'ABSENT')
      const affected = findAffectedEntries(new Set(['fac-a', 'fac-b']), 'WEDNESDAY', YEAR)
      expect(affected).toHaveLength(1)
    })

    it('REPLACE_ABSENT: one substitution covers the absent member, team continues', () => {
      seedTeam()
      settingsRepository.setMultiFacultyAbsencePolicy('REPLACE_ABSENT')
      attendanceRepository.upsert(DATE, 'fac-a', 'ABSENT')

      const affected = findAffectedEntries(new Set(['fac-a']), 'WEDNESDAY', YEAR)
      expect(affected).toHaveLength(1)

      const result = generateSubstitutions(DATE)
      expect(result.assignments).toHaveLength(1)
      expect(result.assignments[0].substituteFacultyId).toBeTruthy()
      expect(result.assignments[0].reasoning).toMatch(/Covering for absent faculty: Mrs\. Alpha/)
      expect(result.assignments[0].reasoning).toMatch(/rest of the team continues/)
      // The absent teacher never substitutes for themselves.
      expect(result.assignments[0].substituteFacultyId).not.toBe('fac-a')
    })

    it('policy is persisted, not inferred', () => {
      settingsRepository.setMultiFacultyAbsencePolicy('REPLACE_ABSENT')
      expect(settingsRepository.getMultiFacultyAbsencePolicy()).toBe('REPLACE_ABSENT')
      const row = testDb!
        .prepare('SELECT value FROM application_settings WHERE key = ?')
        .get('multi_faculty_absence_policy') as { value: string }
      expect(row.value).toBe('REPLACE_ABSENT')
      // Unknown values fall back to the safe default instead of deciding silently.
      settingsRepository.set('multi_faculty_absence_policy', 'SOMETHING_ELSE')
      expect(settingsRepository.getMultiFacultyAbsencePolicy()).toBe('TEAM_SUFFICIENT')
    })
  })
})

// ---------------------------------------------------------------------------
// 8. Run lifecycle derivation
// ---------------------------------------------------------------------------
describe('run lifecycle (derived, never a stale flag)', () => {
  it('walks NOT_STARTED → ATTENDANCE_* → GENERATED → REVIEW/ALL_COVERED → APPROVED → LOCKED', () => {
    // Nothing marked, no run.
    expect(getRunLifecycle(DATE)).toBe('NOT_STARTED')
    expect(RUN_LIFECYCLE_LABELS.NOT_STARTED).toBe('Not started')

    // One of four marked.
    attendanceRepository.upsert(DATE, 'fac-a', 'ABSENT')
    expect(getRunLifecycle(DATE)).toBe('ATTENDANCE_IN_PROGRESS')

    // All marked, no plan yet.
    for (const fid of ['fac-b', 'fac-c', 'fac-d']) attendanceRepository.upsert(DATE, fid, 'PRESENT')
    expect(getRunLifecycle(DATE)).toBe('ATTENDANCE_COMPLETE')

    // Generate a plan with at least one uncovered row → review required.
    testDb!.prepare('INSERT INTO rooms (id, name, capacity, type) VALUES (?,?,?,?)').run('room-1', 'Lab 1', 40, 'LAB')
    createTimetableEntry(base({ facultyIds: ['fac-a'], span: 1 }), YEAR)
    settingsRepository.setMaxDailySubstitutions(0) // force uncovered
    generateSubstitutions(DATE)
    expect(getRunLifecycle(DATE)).toBe('REVIEW_REQUIRED')

    // Remove the cap and regenerate → everything covered.
    settingsRepository.setMaxDailySubstitutions(3)
    const regen = generateSubstitutions(DATE)
    expect(regen.assignments.every(a => a.substituteFacultyId)).toBe(true)
    expect(getRunLifecycle(DATE)).toBe('ALL_COVERED')
  })

  it('a date with no attendance and no run is NOT_STARTED (nothing invented)', () => {
    expect(getRunLifecycle('2024-01-01')).toBe('NOT_STARTED')
  })
})

// ---------------------------------------------------------------------------
// 9. Audit trail
// ---------------------------------------------------------------------------
describe('audit trail (real actions only)', () => {
  it('records timetable create/update/delete with human-readable detail', () => {
    testDb!.prepare('INSERT INTO rooms (id, name, capacity, type) VALUES (?,?,?,?)').run('room-1', 'Lab 1', 40, 'LAB')
    const created = createTimetableEntry(base(), YEAR)

    let recent = auditLogRepository.findRecent(10)
    expect(recent[0].action).toBe(AUDIT_ACTIONS.TIMETABLE_CREATED)
    expect(recent[0].entityId).toBe(created.id)
    expect(recent[0].detail).toContain('III BCA-B')
    expect(recent[0].detail).toContain('Mrs. Alpha, Mrs. Beta')

    updateTimetableEntry(created.id, base({ span: 1 }))
    expect(auditLogRepository.findRecent(1)[0].action).toBe(AUDIT_ACTIONS.TIMETABLE_UPDATED)

    const before = auditLogRepository.findRecent(100).length
    // A failed action must NOT leave a fake "created" row behind.
    expect(() => createTimetableEntry(base({ timeSlotId: 'slot-99' }), YEAR)).toThrow()
    expect(auditLogRepository.findRecent(100)).toHaveLength(before)
  })

  it('records attendance marking (coordinator action)', () => {
    attendanceRepository.upsert(DATE, 'fac-a', 'ABSENT', 'Medical leave')
    auditLogRepository.record(AUDIT_ACTIONS.ATTENDANCE_MARKED, 'attendance', 'fac-a', 'Mrs. Alpha marked absent')
    const recent = auditLogRepository.findRecent(5)
    expect(recent[0].action).toBe('attendance.marked')
    expect(recent[0].detail).toContain('Mrs. Alpha')
  })

  it('a fresh database has an EMPTY audit log (no fabricated history)', () => {
    expect(auditLogRepository.findRecent(50)).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// 10. Terms — "which timetable is effective today?"
// ---------------------------------------------------------------------------
describe('terms (timetable validity)', () => {
  it('finds the term covering a date, and none outside it', () => {
    termRepository.create({
      id: 'term-1',
      academicYearId: YEAR,
      name: '20 Jul – 11 Nov 2026',
      startDate: '2026-07-20',
      endDate: '2026-11-11',
      isActive: true,
    })

    expect(termRepository.findForDate('2026-10-02')?.id).toBe('term-1')
    expect(termRepository.findForDate('2026-11-12')).toBeNull()
    expect(termRepository.findForDate('2026-07-19')).toBeNull()
    expect(termRepository.getActive()?.name).toBe('20 Jul – 11 Nov 2026')
  })

  it('the active AY stays resolvable (date-aware fallback to is_active)', () => {
    const active = academicYearRepository.getActive()
    expect(active?.id).toBe(YEAR)
    expect(active?.startDate).toBe('2024-06-01')
  })
})
