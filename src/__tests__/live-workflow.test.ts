/**
 * Live workflow verification against a copy of the real production database.
 *
 * This is the "launch the app and click through it" pass, expressed as an
 * executable test: it snapshots the actual SQLite file the desktop app uses,
 * runs a full coordinator workflow against the snapshot (dynamic periods,
 * timetable CRUD, attendance, substitution generation, locks, approvals),
 * simulates an app restart, and finally deletes the snapshot. The production
 * database itself is never written to.
 *
 * Skips automatically when the app database does not exist (e.g. CI).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import Database from 'better-sqlite3'
import os from 'os'
import path from 'path'
import fs from 'fs'
import { timeSlotRepository } from '@/db/repositories/timeSlot'
import { timetableEntryRepository } from '@/db/repositories/timetableEntry'
import { settingsRepository } from '@/db/repositories/settings'
import { academicYearRepository } from '@/db/repositories/academicYear'
import { facultyRepository } from '@/db/repositories/faculty'
import { subjectRepository } from '@/db/repositories/subject'
import { sectionRepository } from '@/db/repositories/section'
import { roomRepository } from '@/db/repositories/room'
import { attendanceRepository } from '@/db/repositories/attendance'
import { substitutionRunRepository, substitutionAssignmentRepository } from '@/db/repositories'
import {
  createTimetableEntry,
  updateTimetableEntry,
  deleteTimetableEntry,
} from '@/services/timetable'
import {
  generateSubstitutions,
  getSubstitutionRun,
  approveSubstitutionRun,
  updateSubstitutionAssignment,
  lockAssignment,
  unlockAssignment,
  availableSubstitutesForAssignment,
} from '@/services/substitution'

let testDb: Database.Database | null = null

vi.mock('@/db/database', () => ({
  getDatabase: () => testDb,
  closeDatabase: () => undefined,
}))

const PROD_DB = path.join(
  os.homedir(),
  'Library',
  'Application Support',
  'SubstiFlow',
  'database',
  'substiflow.db'
)
const HAS_PROD_DB = fs.existsSync(PROD_DB)
const SNAPSHOT = path.join(os.tmpdir(), `substiflow-live-${Date.now()}.db`)
/** Wednesday with real seed entries in the production database. */
const WEDNESDAY = '2024-09-25'

describe.skipIf(!HAS_PROD_DB)('live workflow on a copy of the production database', () => {
  let activeYearId = ''
  let entrySnapshotSql = ''

  beforeAll(() => {
    // Snapshot: database + WAL/SHM so nothing the app has pending is missed.
    fs.copyFileSync(PROD_DB, SNAPSHOT)
    for (const suffix of ['-wal', '-shm']) {
      if (fs.existsSync(PROD_DB + suffix)) fs.copyFileSync(PROD_DB + suffix, SNAPSHOT + suffix)
    }
    testDb = new Database(SNAPSHOT)
    testDb.pragma('foreign_keys = ON')
    activeYearId = academicYearRepository.getActive()?.id ?? ''
    entrySnapshotSql =
      'SELECT id, academic_year_id, day_of_week, time_slot_id, section_id, subject_id, faculty_id, room_id, class_type FROM timetable_entries ORDER BY id'
  })

  afterAll(() => {
    if (testDb) {
      testDb.close()
      testDb = null
    }
    for (const f of [SNAPSHOT, SNAPSHOT + '-wal', SNAPSHOT + '-shm']) {
      fs.rmSync(f, { force: true })
    }
  })

  it('0. the production database has real data to work with', () => {
    expect(activeYearId).toBeTruthy()
    expect(facultyRepository.findActive().length).toBeGreaterThan(0)
    expect(sectionRepository.findAll().length).toBeGreaterThan(0)
    expect(timeSlotRepository.getOrdered().length).toBeGreaterThan(0)
    console.log(
      `  [live] year=${activeYearId}, faculty=${facultyRepository.findActive().length}, ` +
        `periods=${timeSlotRepository.getOrdered().length}, ` +
        `entries=${(testDb!.prepare('SELECT COUNT(*) c FROM timetable_entries').get() as any).c}`
    )
  })

  it('A. dynamic periods: add, reject overlap, reorder, delete', () => {
    const before = timeSlotRepository.getOrdered()
    const created = timeSlotRepository.create({
      id: `slot-live-${Date.now()}`,
      name: '16:00-17:00',
      startTime: '16:00',
      endTime: '17:00',
    })
    expect(created.order).toBe(before.length + 1)
    expect(() =>
      timeSlotRepository.create({ id: 'slot-dup', name: 'x', startTime: '16:30', endTime: '17:30' })
    ).toThrow(/overlaps/i)
    expect(timeSlotRepository.move(created.id, -1)).toBe(true)
    expect(timeSlotRepository.getOrdered().map(s => s.order)).toEqual(
      Array.from({ length: before.length + 1 }, (_, i) => i + 1)
    )
    timeSlotRepository.delete(created.id)
    expect(timeSlotRepository.getOrdered().map(s => s.id)).toEqual(before.map(s => s.id))
  })

  it('B. working-hours rebuild: idempotent on the real config, extend and revert', () => {
    const base = settingsRepository.getWorkingHours()
    const originalIds = timeSlotRepository.getOrdered().map(s => s.id)

    // Same hours → identical periods (same ids): safe to press the button twice.
    expect(timeSlotRepository.rebuildFromWorkingHours(base).map(s => s.id)).toEqual(originalIds)

    // Extend the day by one hour → exactly one new period, nothing lost.
    const [eh, em] = base.endTime.split(':').map(Number)
    const extended = `${String(eh + 1).padStart(2, '0')}:${String(em).padStart(2, '0')}`
    const grown = timeSlotRepository.rebuildFromWorkingHours({ ...base, endTime: extended })
    expect(grown.length).toBeGreaterThan(originalIds.length)
    for (const id of originalIds) expect(timeSlotRepository.findById(id)).toBeTruthy()
    expect(grown.find(s => s.endTime === extended)).toBeTruthy()

    // Revert: the extra period goes away again.
    expect(timeSlotRepository.rebuildFromWorkingHours(base).map(s => s.id)).toEqual(originalIds)

    // Deleting a period the timetable uses is refused, with a friendly message.
    const used = timeSlotRepository
      .getOrdered()
      .find(s => timeSlotRepository.getUsageCount(s.id) > 0)
    if (used) {
      expect(() => timeSlotRepository.delete(used.id)).toThrow(/used by .* timetable entr/)
    } else {
      console.log('  [live] no timetable entries in production — delete guard not exercised')
    }
  })

  it('C. master timetable CRUD through the service, on real fixtures', () => {
    const section = sectionRepository.findAll()[0]
    const room = roomRepository.findAll()[0]
    // The service enforces faculty↔subject mappings, so use a genuinely linked
    // pair from this database (fall back to linking the first pair on this copy).
    const pair = testDb!.prepare(`
      SELECT fs.faculty_id, fs.subject_id
      FROM faculty_subjects fs
      JOIN faculty f ON f.id = fs.faculty_id
      WHERE f.is_active = 1
      LIMIT 1
    `).get() as { faculty_id: string; subject_id: string } | undefined
    const faculty = pair
      ? facultyRepository.findById(pair.faculty_id)!
      : facultyRepository.findActive()[0]
    const subject = pair
      ? subjectRepository.findById(pair.subject_id)!
      : subjectRepository.findAll()[0]
    if (!pair) {
      facultyRepository.setSubjects(faculty.id, [
        { facultyId: faculty.id, subjectId: subject.id, proficiency: 5 },
      ])
    }
    const slots = timeSlotRepository.getTeachingSlots()
    const days = settingsRepository.getWorkingDays()

    // Find the first genuinely free day/period for this section+faculty+room.
    const free = days
      .flatMap(day => slots.map(slot => ({ day, slot })))
      .find(({ day, slot }) =>
        timetableEntryRepository.checkConflicts({
          academicYearId: activeYearId,
          dayOfWeek: day,
          timeSlotId: slot.id,
          sectionId: section.id,
          subjectId: subject.id,
          facultyId: faculty.id,
          roomId: room.id,
          classType: 'LECTURE',
        }).length === 0
      )
    expect(free).toBeTruthy()

    const payload = {
      dayOfWeek: free!.day,
      timeSlotId: free!.slot.id,
      sectionId: section.id,
      subjectId: subject.id,
      facultyId: faculty.id,
      roomId: room.id,
      classType: 'LECTURE' as const,
    }

    // 1. Create (the historical bug: academic_year_id was never set by the UI).
    const created = createTimetableEntry(payload, activeYearId)
    const row = testDb!
      .prepare('SELECT academic_year_id FROM timetable_entries WHERE id = ?')
      .get(created.id) as any
    expect(row.academic_year_id).toBe(activeYearId)

    // 2. Double-booking is refused with readable text.
    expect(() =>
      createTimetableEntry({ ...payload, sectionId: sectionRepository.findAll().at(-1)!.id }, activeYearId)
    ).toThrow(/already has a class at this time|already booked/i)

    // 3. Break periods can never receive entries.
    const breakSlot = timeSlotRepository.getBreakSlots()[0]
    if (breakSlot) {
      expect(() => createTimetableEntry({ ...payload, timeSlotId: breakSlot.id }, activeYearId)).toThrow(
        /break/i
      )
    }

    // 4. Update persists.
    const updated = updateTimetableEntry(created.id, { ...payload, classType: 'LAB' })
    expect(updated.classType).toBe('LAB')

    // 5. Delete persists, and double-delete is a readable error.
    deleteTimetableEntry(created.id)
    expect(timetableEntryRepository.findById(created.id)).toBeNull()
    expect(() => deleteTimetableEntry(created.id)).toThrow(/no longer exists/i)
  })

  it('D. attendance + substitution generation on real Wednesday data', () => {
    const wedEntries = timetableEntryRepository
      .getWithRelations(activeYearId)
      .filter(e => e.dayOfWeek === 'WEDNESDAY')
    if (wedEntries.length === 0) {
      console.log('  [live] no Wednesday entries in production — engine workflow skipped')
      return
    }

    const beforeEntries = JSON.stringify(testDb!.prepare(entrySnapshotSql).all())
    const absentFacultyId = wedEntries[0].facultyId
    attendanceRepository.upsert(WEDNESDAY, absentFacultyId, 'ABSENT', 'Live audit check')

    const result = generateSubstitutions(WEDNESDAY)
    expect(result.runId).toBeTruthy()
    expect(result.statistics.totalAffected).toBeGreaterThanOrEqual(1)
    expect(getSubstitutionRun(WEDNESDAY)).toBeTruthy()

    // Hard constraints, verified against real data:
    const substituted = result.assignments.filter(a => a.substituteFacultyId)
    expect(substituted.every(a => a.substituteFacultyId !== absentFacultyId)).toBe(true)

    const allEntries = timetableEntryRepository.getWithRelations(activeYearId)
    const substitutesPerPeriod = new Map<string, Set<string>>()
    for (const a of substituted) {
      const covered = timetableEntryRepository.findById(a.originalEntryId)!
      const periodKey = `${covered.dayOfWeek}|${covered.timeSlotId}`

      // No substitute is booked into the same period twice…
      const inPeriod = substitutesPerPeriod.get(periodKey) ?? new Set<string>()
      expect(inPeriod.has(a.substituteFacultyId!)).toBe(false)
      inPeriod.add(a.substituteFacultyId!)
      substitutesPerPeriod.set(periodKey, inPeriod)

      // …and no substitute is simultaneously teaching their own class.
      const ownClassSamePeriod = allEntries.some(
        e =>
          e.facultyId === a.substituteFacultyId &&
          e.dayOfWeek === covered.dayOfWeek &&
          e.timeSlotId === covered.timeSlotId
      )
      expect(ownClassSamePeriod).toBe(false)

      // Break periods never receive substitutions.
      expect(timeSlotRepository.findById(covered.timeSlotId)?.isBreak).toBe(false)
    }

    // The master timetable is never mutated by generation.
    expect(JSON.stringify(testDb!.prepare(entrySnapshotSql).all())).toBe(beforeEntries)

    // Manual override: a valid hand-picked substitute is accepted…
    const first = substituted[0]
    if (first) {
      const options = availableSubstitutesForAssignment(first.id)
      if (options.length > 0) {
        const pick = options.find(f => f.id !== first.substituteFacultyId) ?? options[0]
        expect(updateSubstitutionAssignment(first.id, { substituteFacultyId: pick.id })).toBeTruthy()
        // …while the absent teacher is refused.
        expect(
          updateSubstitutionAssignment(first.id, { substituteFacultyId: absentFacultyId })
        ).toBeNull()
      }

      // Lock survives a regeneration.
      const lockedId = first.id
      const lockedSubstitute = (substitutionAssignmentRepository.findById(lockedId) as any)
        ?.substituteFacultyId
      expect(lockAssignment(lockedId)).toBeTruthy()
      generateSubstitutions(WEDNESDAY)
      const afterRegen = substitutionAssignmentRepository.findById(lockedId) as any
      expect(afterRegen.isLocked).toBe(true)
      expect(afterRegen.substituteFacultyId).toBe(lockedSubstitute)
      expect(unlockAssignment(lockedId)).toBeTruthy()
    }

    // Approval round-trip (must come after the last regeneration, which
    // resets the run status to GENERATED).
    expect(approveSubstitutionRun(WEDNESDAY, 'Live Audit')).toBeTruthy()
    const runRow = testDb!
      .prepare('SELECT status, approved_by FROM substitution_runs WHERE date = ?')
      .get(WEDNESDAY) as any
    expect(runRow.status).toBe('APPROVED')
    expect(runRow.approved_by).toBe('Live Audit')
  })

  it('E. restart: close and reopen the snapshot, everything is still there', () => {
    const periodCount = timeSlotRepository.getOrdered().length
    const workingDays = settingsRepository.getWorkingDays()
    const entryCount = (testDb!.prepare('SELECT COUNT(*) c FROM timetable_entries').get() as any).c
    const runExists = substitutionRunRepository.findByDate(WEDNESDAY) !== null

    testDb!.close()
    testDb = new Database(SNAPSHOT)
    testDb.pragma('foreign_keys = ON')

    expect(timeSlotRepository.getOrdered()).toHaveLength(periodCount)
    expect(settingsRepository.getWorkingDays()).toEqual(workingDays)
    expect(
      (testDb!.prepare('SELECT COUNT(*) c FROM timetable_entries').get() as any).c
    ).toBe(entryCount)
    expect(substitutionRunRepository.findByDate(WEDNESDAY)).toBeTruthy()
    expect(runExists).toBe(true)
    expect(settingsRepository.getInstitutionName().length).toBeGreaterThan(0)
  })
})
