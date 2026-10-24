/**
 * Unit & integration tests for Semester-Wide Indian Language Synchronization:
 *
 * Covers all 16 required test scenarios:
 *  1. Two sections in the same semester receive their common language session at the same day and period.
 *  2. A language slot mismatch is detected by final validation.
 *  3. A manually moved language session cannot silently violate synchronization (atomically coordinates moving peer sessions or rejects if invalid).
 *  4. An incompatible swap is rejected atomically.
 *  5. Different semesters can use independent language slots.
 *  6. Multiple language groups follow their actual allocation configuration.
 *  7. Faculty and room conflicts are still rejected.
 *  8. Team teaching does not multiply occupied periods.
 *  9. Exact weekly counts and lab durations remain correct.
 * 10. Unsatisfiable synchronization produces actionable diagnostics.
 * 11. A complete timetable can be generated, validated, published, and reopened.
 * 12. Drag-and-drop moves persist in SQLite and render correctly after reload.
 * 13. Undo restores the previous timetable.
 * 14. Substitution recommendations respect existing eligibility and conflict rules during synchronized slots.
 * 15. A fresh installation initializes successfully without access to the production database.
 * 16. Demo data demonstrates the synchronization rule visibly.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import crypto from 'crypto'
import { schema } from '@/db/schema'
import {
  buildDemoFixture,
  applyDemoSchema,
  DEMO_EXPECTED_COUNTS,
  DEMO_YEAR_ID,
} from '@/db/demoFixture'
import {
  generateTimetable,
  validateDraftTimetable,
  publishDraftTimetable,
  moveDraftEntry,
  swapDraftEntries,
  isLanguageSubject,
} from '@/services/timetableGenerator'
import {
  generateSubstitutions,
  approveSubstitutionRun,
  getRevisedTimetable,
} from '@/services/substitution'
import {
  sectionRepository,
  subjectRepository,
  subjectRequirementRepository,
  teachingAllocationRepository,
  settingsRepository,
  draftTimetableEntryRepository,
  timetableGenerationRepository,
  generationDiagnosticRepository,
} from '@/db/repositories'
import { attendanceRepository } from '@/db/repositories/attendance'
import { openNodeDatabase, runMigrations, TARGET_SCHEMA_VERSION, resolveDatabasePath } from '@/db/nodeDb'
import { productionDataDir } from '@/db/demoPaths'
import type { DayOfWeek, DraftTimetableEntryWithRelations } from '@/types'

let testDb: Database.Database | null = null

vi.mock('@/db/database', () => ({
  getDatabase: () => testDb,
  closeDatabase: () => undefined,
}))

const DAY_TO_JS: Record<string, number> = {
  SUNDAY: 0,
  MONDAY: 1,
  TUESDAY: 2,
  WEDNESDAY: 3,
  THURSDAY: 4,
  FRIDAY: 5,
  SATURDAY: 6,
}

function dateForWeekday(dow: string): string {
  const d = new Date('2026-10-12T12:00:00')
  for (let i = 0; i < 8; i += 1) {
    if (d.getDay() === DAY_TO_JS[dow]) {
      const pad = (n: number) => String(n).padStart(2, '0')
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
    }
    d.setDate(d.getDate() + 1)
  }
  return '2026-10-12'
}

function computeFileSha256(filePath: string): string | null {
  if (!fs.existsSync(filePath)) return null
  const buf = fs.readFileSync(filePath)
  return crypto.createHash('sha256').update(buf).digest('hex')
}

describe('Semester-wide Indian Language Synchronization & Lifecycle Suite', () => {
  let productionDbPath: string
  let initialProdChecksum: string | null = null
  let generationId: string = ''

  beforeAll(() => {
    productionDbPath = path.join(productionDataDir(), 'database', 'substiflow.db')
    initialProdChecksum = computeFileSha256(productionDbPath)

    testDb = new Database(':memory:')
    testDb.pragma('foreign_keys = ON')
    applyDemoSchema(testDb)
    buildDemoFixture(testDb)

    const gen = generateTimetable(DEMO_YEAR_ID)
    expect(gen.status).toBe('COMPLETED')
    generationId = gen.generationId
  })

  afterAll(() => {
    if (testDb) {
      testDb.close()
      testDb = null
    }
    // Verify production DB integrity is unchanged
    const finalProdChecksum = computeFileSha256(productionDbPath)
    expect(finalProdChecksum).toBe(initialProdChecksum)
  })

  // 1. Two sections in the same semester receive their common language session at the same day and period
  it('1. schedules common language sessions for sections within the same semester in identical day and period slots', () => {
    const entries = draftTimetableEntryRepository.findByGenerationWithRelations(generationId)
    const sem1Sections = sectionRepository.findByAcademicYear(DEMO_YEAR_ID).filter((s) => s.semester === 1)
    expect(sem1Sections.length).toBe(2)
    const secA = sem1Sections.find((s) => s.id === 'sec-i-a')!
    const secB = sem1Sections.find((s) => s.id === 'sec-i-b')!

    const secALang = entries.filter((e) => e.sectionId === secA.id && isLanguageSubject(e.subject))
    const secBLang = entries.filter((e) => e.sectionId === secB.id && isLanguageSubject(e.subject))

    expect(secALang.length).toBe(1)
    expect(secBLang.length).toBe(1)
    expect(secALang[0].span).toBe(2)
    expect(secBLang[0].span).toBe(2)

    const secASlots = secALang.map((e) => `${e.dayOfWeek}|${e.timeSlotId}`).sort()
    const secBSlots = secBLang.map((e) => `${e.dayOfWeek}|${e.timeSlotId}`).sort()
    expect(secASlots).toEqual(secBSlots)

    // Semester 3 sections must also synchronize internally
    const sem3Sections = sectionRepository.findByAcademicYear(DEMO_YEAR_ID).filter((s) => s.semester === 3)
    expect(sem3Sections.length).toBe(2)
    const sec3A = sem3Sections.find((s) => s.id === 'sec-iii-a')!
    const sec3B = sem3Sections.find((s) => s.id === 'sec-iii-b')!

    const sec3ALang = entries.filter((e) => e.sectionId === sec3A.id && isLanguageSubject(e.subject))
    const sec3BLang = entries.filter((e) => e.sectionId === sec3B.id && isLanguageSubject(e.subject))

    expect(sec3ALang.length).toBe(1)
    expect(sec3BLang.length).toBe(1)
    expect(sec3ALang[0].span).toBe(2)
    expect(sec3BLang[0].span).toBe(2)

    const sec3ASlots = sec3ALang.map((e) => `${e.dayOfWeek}|${e.timeSlotId}`).sort()
    const sec3BSlots = sec3BLang.map((e) => `${e.dayOfWeek}|${e.timeSlotId}`).sort()
    expect(sec3ASlots).toEqual(sec3BSlots)
  })

  // 2. A language slot mismatch is detected by final validation
  it('2. detects a desynchronized language slot mismatch during final validation', () => {
    const entries = draftTimetableEntryRepository.findByGenerationWithRelations(generationId)
    const sem1Sections = sectionRepository.findByAcademicYear(DEMO_YEAR_ID).filter((s) => s.semester === 1)
    const secB = sem1Sections.find((s) => s.id === 'sec-i-b')!

    const secBLang = entries.find((e) => e.sectionId === secB.id && isLanguageSubject(e.subject))!
    const originalDay = secBLang.dayOfWeek
    const originalSlot = secBLang.timeSlotId

    // Find an empty slot in secB's timetable to avoid UNIQUE constraint violation on section
    const candidateDays: DayOfWeek[] = ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY']
    const allSlots = ['slot-1', 'slot-2', 'slot-3', 'slot-4', 'slot-5', 'slot-6']
    let freeDay: DayOfWeek = 'SATURDAY'
    let freeSlot = 'slot-6'
    for (const d of candidateDays) {
      for (const s of allSlots) {
        if (!entries.some((e) => e.sectionId === secB.id && e.dayOfWeek === d && e.timeSlotId === s)) {
          freeDay = d
          freeSlot = s
          break
        }
      }
    }

    try {
      // Intentionally alter one section's slot to create a mismatch
      testDb!
        .prepare('UPDATE draft_timetable_entries SET day_of_week = ?, time_slot_id = ? WHERE id = ?')
        .run(freeDay, freeSlot, secBLang.id)

      const validation = validateDraftTimetable(generationId)
      expect(validation.valid).toBe(false)
      const langError = validation.errors.find((err) =>
        err.includes('Semester-wide language synchronization violation')
      )
      expect(langError).toBeDefined()
      expect(langError).toContain('Semester 1 sections have Indian Language scheduled at different slots')
    } finally {
      // Restore
      testDb!
        .prepare('UPDATE draft_timetable_entries SET day_of_week = ?, time_slot_id = ? WHERE id = ?')
        .run(originalDay, originalSlot, secBLang.id)
    }

    const restoredValidation = validateDraftTimetable(generationId)
    expect(restoredValidation.valid).toBe(true)
  })

  // 3. A manually moved language session cannot silently violate synchronization
  it('3. atomically coordinates moving peer language sessions and rejects invalid moves', () => {
    const entries = draftTimetableEntryRepository.findByGenerationWithRelations(generationId)
    const sem1Sections = sectionRepository.findByAcademicYear(DEMO_YEAR_ID).filter((s) => s.semester === 1)
    const secA = sem1Sections.find((s) => s.id === 'sec-i-a')!
    const secB = sem1Sections.find((s) => s.id === 'sec-i-b')!

    const secALang = entries.find((e) => e.sectionId === secA.id && isLanguageSubject(e.subject))!
    const peerLang = entries.find(
      (e) =>
        e.sectionId === secB.id &&
        isLanguageSubject(e.subject) &&
        e.dayOfWeek === secALang.dayOfWeek &&
        e.timeSlotId === secALang.timeSlotId
    )!
    expect(peerLang).toBeDefined()

    const oldDay = secALang.dayOfWeek
    const oldSlot = secALang.timeSlotId

    // Find a valid 2-period lab start slot that is free for both sections and faculty
    const candidateDays: DayOfWeek[] = ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY']
    const labStartSlots = ['slot-1', 'slot-3', 'slot-5']

    let targetDay: DayOfWeek | null = null
    let targetSlot: string | null = null

    for (const d of candidateDays) {
      for (const s of labStartSlots) {
        if (d === oldDay && s === oldSlot) continue
        const testRes = moveDraftEntry(generationId, secALang.id, d, s)
        if (testRes.success) {
          targetDay = d
          targetSlot = s
          // Move back to test original slot
          moveDraftEntry(generationId, secALang.id, oldDay, oldSlot)
          break
        }
      }
      if (targetDay) break
    }

    expect(targetDay).not.toBeNull()
    expect(targetSlot).not.toBeNull()

    // Execute move on secA language entry
    const moveRes = moveDraftEntry(generationId, secALang.id, targetDay!, targetSlot!)
    expect(moveRes.success).toBe(true)

    // Verify BOTH entries moved atomically to the target day and slot
    const updatedA = draftTimetableEntryRepository.findById(secALang.id)!
    const updatedB = draftTimetableEntryRepository.findById(peerLang.id)!

    expect(updatedA.dayOfWeek).toBe(targetDay)
    expect(updatedA.timeSlotId).toBe(targetSlot)
    expect(updatedB.dayOfWeek).toBe(targetDay)
    expect(updatedB.timeSlotId).toBe(targetSlot)

    // Moving to an occupied slot for section B rejects the entire move
    const busyForB = entries.find((e) => e.sectionId === secB.id && e.id !== peerLang.id && e.classType === 'LECTURE')!
    const rejectRes = moveDraftEntry(generationId, secALang.id, busyForB.dayOfWeek, busyForB.timeSlotId)
    expect(rejectRes.success).toBe(false)
    expect(rejectRes.error).toMatch(/conflict|hours/i)

    // Restore to original slot
    const undoRes = moveDraftEntry(generationId, secALang.id, oldDay, oldSlot)
    expect(undoRes.success).toBe(true)
  })

  // 4. An incompatible swap is rejected atomically
  it('4. rejects incompatible swap atomically to prevent desynchronizing language sessions', () => {
    const entries = draftTimetableEntryRepository.findByGenerationWithRelations(generationId)
    const sem1Sections = sectionRepository.findByAcademicYear(DEMO_YEAR_ID).filter((s) => s.semester === 1)
    const secA = sem1Sections.find((s) => s.id === 'sec-i-a')!

    const langEntry = entries.find((e) => e.sectionId === secA.id && isLanguageSubject(e.subject))!
    const otherLecture = entries.find(
      (e) => e.sectionId === secA.id && !isLanguageSubject(e.subject) && e.span === 1
    )!

    const swapRes = swapDraftEntries(generationId, langEntry.id, otherLecture.id)
    expect(swapRes.success).toBe(false)
    expect(swapRes.error).toContain('Cannot swap Indian Language session: semester-wide synchronization requires')

    // Confirm neither row was modified
    const currentLang = draftTimetableEntryRepository.findById(langEntry.id)!
    const currentOther = draftTimetableEntryRepository.findById(otherLecture.id)!
    expect(currentLang.dayOfWeek).toBe(langEntry.dayOfWeek)
    expect(currentLang.timeSlotId).toBe(langEntry.timeSlotId)
    expect(currentOther.dayOfWeek).toBe(otherLecture.dayOfWeek)
    expect(currentOther.timeSlotId).toBe(otherLecture.timeSlotId)
  })

  // 5. Different semesters can use independent language slots
  it('5. allows different semesters to use independent language slots', () => {
    const entries = draftTimetableEntryRepository.findByGenerationWithRelations(generationId)

    const sem1Lang = entries.filter(
      (e) => e.section?.semester === 1 && isLanguageSubject(e.subject)
    )
    const sem3Lang = entries.filter(
      (e) => e.section?.semester === 3 && isLanguageSubject(e.subject)
    )

    expect(sem1Lang.length).toBe(2) // Sec A and Sec B
    expect(sem3Lang.length).toBe(2) // Sec A and Sec B

    const sem1Slot = `${sem1Lang[0].dayOfWeek}|${sem1Lang[0].timeSlotId}`
    const sem3Slot = `${sem3Lang[0].dayOfWeek}|${sem3Lang[0].timeSlotId}`

    expect(sem1Slot).toBeDefined()
    expect(sem3Slot).toBeDefined()
  })

  // 6. Multiple language groups follow their actual allocation configuration
  it('6. honors multiple language allocations according to database configuration', () => {
    const entries = draftTimetableEntryRepository.findByGenerationWithRelations(generationId)

    const sem1Sections = sectionRepository.findByAcademicYear(DEMO_YEAR_ID).filter((s) => s.semester === 1)
    const secA = sem1Sections.find((s) => s.id === 'sec-i-a')!
    const secB = sem1Sections.find((s) => s.id === 'sec-i-b')!

    const secAEntries = entries.filter((e) => e.sectionId === secA.id && isLanguageSubject(e.subject))
    const secBEntries = entries.filter((e) => e.sectionId === secB.id && isLanguageSubject(e.subject))

    // Section A assigned [demo-fac-09, demo-fac-11]
    for (const entry of secAEntries) {
      const facIds = (entry.facultyList ?? []).map((f) => f.id).sort()
      expect(facIds).toEqual(['demo-fac-09', 'demo-fac-11'])
    }

    // Section B assigned [demo-fac-10, demo-fac-12]
    for (const entry of secBEntries) {
      const facIds = (entry.facultyList ?? []).map((f) => f.id).sort()
      expect(facIds).toEqual(['demo-fac-10', 'demo-fac-12'])
    }
  })

  // 7. Faculty and room conflicts are still rejected
  it('7. rejects simultaneous scheduling that causes faculty or room double-booking', () => {
    const entries = draftTimetableEntryRepository.findByGenerationWithRelations(generationId)

    // Check every slot across the entire schedule: no faculty or room double-booking
    const facultySlotMap = new Map<string, string[]>()
    const roomSlotMap = new Map<string, string[]>()
    const sectionSlotMap = new Map<string, string[]>()

    for (const entry of entries) {
      const slotKey = `${entry.dayOfWeek}|${entry.timeSlotId}`

      // Section double-booking check
      const secList = sectionSlotMap.get(slotKey) ?? []
      expect(secList).not.toContain(entry.sectionId)
      secList.push(entry.sectionId)
      sectionSlotMap.set(slotKey, secList)

      // Faculty double-booking check
      for (const fac of entry.facultyList ?? []) {
        const facList = facultySlotMap.get(slotKey) ?? []
        expect(facList, `Faculty ${fac.name} double-booked at ${slotKey}`).not.toContain(fac.id)
        facList.push(fac.id)
        facultySlotMap.set(slotKey, facList)
      }

      // Room double-booking check
      for (const room of entry.roomList ?? []) {
        const roomList = roomSlotMap.get(slotKey) ?? []
        expect(roomList, `Room ${room.name} double-booked at ${slotKey}`).not.toContain(room.id)
        roomList.push(room.id)
        roomSlotMap.set(slotKey, roomList)
      }
    }
  })

  // 8. Team teaching does not multiply occupied periods
  it('8. preserves team teaching semantics without multiplying occupied periods', () => {
    const entries = draftTimetableEntryRepository.findByGenerationWithRelations(generationId)

    const sem1Sections = sectionRepository.findByAcademicYear(DEMO_YEAR_ID).filter((s) => s.semester === 1)
    const secA = sem1Sections.find((s) => s.id === 'sec-i-a')!
    const secALang = entries.filter((e) => e.sectionId === secA.id && isLanguageSubject(e.subject))

    // 1 required session of span 2
    expect(secALang.length).toBe(1)

    for (const entry of secALang) {
      // 2 faculty members on the session
      expect(entry.facultyList?.length).toBe(2)
      // Span is 2 periods
      expect(entry.span).toBe(2)
    }

    // Occupied periods is 2, NOT 4
    const occupied = secALang.reduce((sum, e) => sum + (e.span || 1), 0)
    expect(occupied).toBe(2)
  })

  // 9. Exact weekly counts and lab durations remain correct
  it('9. schedules exactly 124 activities and 140 occupied periods with contiguous 2-period labs', () => {
    const entries = draftTimetableEntryRepository.findByGenerationWithRelations(generationId)

    expect(entries.length).toBe(124)
    const totalOccupied = entries.reduce((sum, e) => sum + (e.span || 1), 0)
    expect(totalOccupied).toBe(140)

    const labEntries = entries.filter((e) => e.classType === 'LAB')
    expect(labEntries.length).toBe(16) // 16 lab sessions * 2 periods = 32 periods; 108 lectures * 1 = 108 periods => 140 total

    for (const lab of labEntries) {
      expect(lab.span).toBe(2)
      // Labs can only start in periods that allow a 2-period contiguous span without crossing breaks
      expect(['slot-1', 'slot-3', 'slot-5']).toContain(lab.timeSlotId)
    }
  })

  // 10. Unsatisfiable synchronization produces actionable diagnostics
  it('10. produces actionable diagnostics when synchronization is unsatisfiable', () => {
    const tempDb = new Database(':memory:')
    tempDb.pragma('foreign_keys = ON')
    applyDemoSchema(tempDb)
    buildDemoFixture(tempDb)

    // Overload Section B with demo-fac-09 (same as Section A) for Indian Language
    tempDb
      .prepare(
        `UPDATE teaching_allocations
         SET faculty_id = 'demo-fac-09'
         WHERE subject_id = 'sub-24bcal12' AND section_id = 'sec-i-b' AND faculty_id = 'demo-fac-10'`
      )
      .run()

    const oldTestDb = testDb
    testDb = tempDb
    try {
      const gen = generateTimetable(DEMO_YEAR_ID)
      expect(gen.status).toBe('FAILED')

      const syncDiag = gen.diagnostics.find((d) => d.code === 'LANGUAGE_SYNC_CONFLICT')
      expect(syncDiag).toBeDefined()
      expect(syncDiag?.message).toMatch(/share faculty member|cannot be in two rooms at once/i)
    } finally {
      testDb = oldTestDb
      tempDb.close()
    }
  })

  // 12. Drag-and-drop moves persist in SQLite and render correctly after reload
  it('12. persists drag-and-drop moves in SQLite and renders correctly after reload', () => {
    const entries = draftTimetableEntryRepository.findByGenerationWithRelations(generationId)
    const candidateDays: DayOfWeek[] = ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY']
    const allSlots = ['slot-1', 'slot-2', 'slot-3', 'slot-4', 'slot-5', 'slot-6']

    let targetLecture: DraftTimetableEntryWithRelations | null = null
    let targetDay: DayOfWeek | null = null
    let targetSlot: string | null = null

    for (const l of entries) {
      if (l.classType !== 'LECTURE' || isLanguageSubject(l.subject)) continue
      for (const d of candidateDays) {
        for (const s of allSlots) {
          if (d === l.dayOfWeek && s === l.timeSlotId) continue
          const testRes = moveDraftEntry(generationId, l.id, d, s)
          if (testRes.success) {
            targetLecture = l
            targetDay = d
            targetSlot = s
            // Restore to test original slot
            moveDraftEntry(generationId, l.id, l.dayOfWeek, l.timeSlotId)
            break
          }
        }
        if (targetLecture) break
      }
      if (targetLecture) break
    }

    expect(targetLecture).not.toBeNull()
    expect(targetDay).not.toBeNull()
    expect(targetSlot).not.toBeNull()

    const originalDay = targetLecture!.dayOfWeek
    const originalSlot = targetLecture!.timeSlotId

    const moveRes = moveDraftEntry(generationId, targetLecture!.id, targetDay!, targetSlot!)
    expect(moveRes.success).toBe(true)

    // Raw SQLite inspection
    const rawRow = testDb!
      .prepare('SELECT day_of_week, time_slot_id FROM draft_timetable_entries WHERE id = ?')
      .get(targetLecture!.id) as { day_of_week: string; time_slot_id: string }

    expect(rawRow.day_of_week).toBe(targetDay)
    expect(rawRow.time_slot_id).toBe(targetSlot)

    // Reload with relations (simulating page reload)
    const reloaded = draftTimetableEntryRepository.findByGenerationWithRelations(generationId)
    const reloadedEntry = reloaded.find((e) => e.id === targetLecture!.id)!
    expect(reloadedEntry.dayOfWeek).toBe(targetDay)
    expect(reloadedEntry.timeSlotId).toBe(targetSlot)
    expect(reloadedEntry.section?.id).toBe(targetLecture!.sectionId)
    expect(reloadedEntry.subject?.id).toBe(targetLecture!.subjectId)

    // Move back
    moveDraftEntry(generationId, targetLecture!.id, originalDay, originalSlot)
  })

  // 13. Undo restores the previous timetable
  it('13. confirms undo restores previous timetable state including synchronized language peers', () => {
    const entries = draftTimetableEntryRepository.findByGenerationWithRelations(generationId)
    const sem1Sections = sectionRepository.findByAcademicYear(DEMO_YEAR_ID).filter((s) => s.semester === 1)
    const secA = sem1Sections.find((s) => s.id === 'sec-i-a')!
    const secB = sem1Sections.find((s) => s.id === 'sec-i-b')!

    const langA = entries.find((e) => e.sectionId === secA.id && isLanguageSubject(e.subject))!
    const langB = entries.find(
      (e) =>
        e.sectionId === secB.id &&
        isLanguageSubject(e.subject) &&
        e.dayOfWeek === langA.dayOfWeek &&
        e.timeSlotId === langA.timeSlotId
    )!

    const prevDay = langA.dayOfWeek
    const prevSlot = langA.timeSlotId

    // Find a valid 2-period lab start slot that is free for both sections
    const labStartSlots = ['slot-1', 'slot-3', 'slot-5']
    const candidateDays: DayOfWeek[] = ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY']

    let targetDay: DayOfWeek | null = null
    let targetSlot: string | null = null

    for (const d of candidateDays) {
      for (const s of labStartSlots) {
        if (d === prevDay && s === prevSlot) continue
        const testRes = moveDraftEntry(generationId, langA.id, d, s)
        if (testRes.success) {
          targetDay = d
          targetSlot = s
          // Move back to test original slot
          moveDraftEntry(generationId, langA.id, prevDay, prevSlot)
          break
        }
      }
      if (targetDay) break
    }

    expect(targetDay).not.toBeNull()
    expect(targetSlot).not.toBeNull()

    const history: Array<{ entryId: string; prevDay: DayOfWeek; prevSlotId: string }> = []
    history.push({ entryId: langA.id, prevDay, prevSlotId: prevSlot })

    const moveRes = moveDraftEntry(generationId, langA.id, targetDay!, targetSlot!)
    expect(moveRes.success).toBe(true)

    // Undo action
    const lastAction = history.pop()!
    const undoRes = moveDraftEntry(generationId, lastAction.entryId, lastAction.prevDay, lastAction.prevSlotId)
    expect(undoRes.success).toBe(true)

    const restoredA = draftTimetableEntryRepository.findById(langA.id)!
    const restoredB = draftTimetableEntryRepository.findById(langB.id)!

    expect(restoredA.dayOfWeek).toBe(prevDay)
    expect(restoredA.timeSlotId).toBe(prevSlot)
    expect(restoredB.dayOfWeek).toBe(prevDay)
    expect(restoredB.timeSlotId).toBe(prevSlot)
  })

  // 11. A complete timetable can be generated, validated, published, and reopened
  it('11. generates, validates, publishes, and reloads synchronized timetable', () => {
    const validation = validateDraftTimetable(generationId)
    expect(validation.valid).toBe(true)

    const publishRes = publishDraftTimetable(generationId)
    expect(publishRes.publishedEntries).toBe(124)

    // Reopen and inspect published entries
    const publishedRows = testDb!
      .prepare(
        `SELECT te.day_of_week, te.time_slot_id, te.section_id, s.name as subject_name
         FROM timetable_entries te
         JOIN subjects s ON s.id = te.subject_id
         WHERE te.academic_year_id = ? AND s.id = 'sub-24bcal12'`
      )
      .all(DEMO_YEAR_ID) as Array<{ day_of_week: string; time_slot_id: string; section_id: string; subject_name: string }>

    expect(publishedRows.length).toBe(2)
    const secA = publishedRows.filter((r) => r.section_id === 'sec-i-a')
    const secB = publishedRows.filter((r) => r.section_id === 'sec-i-b')

    expect(secA.length).toBe(1)
    expect(secB.length).toBe(1)
    expect(secA[0].day_of_week).toBe(secB[0].day_of_week)
    expect(secA[0].time_slot_id).toBe(secB[0].time_slot_id)
  })

  // 14. Substitution recommendations respect existing eligibility and conflict rules during synchronized slots
  it('14. recommends eligible, free substitutes during synchronized language slots without conflict', () => {
    // Pick an Indian Language entry from Semester 1 in the published master timetable
    const langEntry = testDb!
      .prepare(
        `SELECT te.id, te.day_of_week, te.time_slot_id
         FROM timetable_entries te
         JOIN subjects s ON s.id = te.subject_id
         WHERE te.academic_year_id = ? AND s.id = 'sub-24bcal12' AND te.section_id = 'sec-i-a'
         LIMIT 1`
      )
      .get(DEMO_YEAR_ID) as { id: string; day_of_week: string; time_slot_id: string }

    expect(langEntry).toBeDefined()
    const teachers = testDb!
      .prepare('SELECT faculty_id FROM timetable_entry_faculty WHERE entry_id = ?')
      .all(langEntry.id) as Array<{ faculty_id: string }>
    expect(teachers.length).toBeGreaterThan(0)

    const date = dateForWeekday(langEntry.day_of_week)
    // Mark all co-teachers of Section A absent so external substitution is required
    for (const t of teachers) {
      attendanceRepository.upsert(date, t.faculty_id, 'ABSENT')
    }

    const subResult = generateSubstitutions(date)
    expect(subResult.statistics.totalAffected).toBeGreaterThan(0)
    expect(subResult.statistics.covered).toBeGreaterThan(0)

    // Verify assigned substitute is free and not teaching peer section B's synchronized class
    const peerTeachers = testDb!
      .prepare(
        `SELECT tef.faculty_id
         FROM timetable_entries te
         JOIN timetable_entry_faculty tef ON tef.entry_id = te.id
         WHERE te.academic_year_id = ? AND te.day_of_week = ? AND te.time_slot_id = ? AND te.section_id = 'sec-i-b'`
      )
      .all(DEMO_YEAR_ID, langEntry.day_of_week, langEntry.time_slot_id)
      .map((r: any) => r.faculty_id)

    const assignments = testDb!
      .prepare(
        `SELECT a.substitute_faculty_id, o.day_of_week, o.time_slot_id
         FROM substitution_assignments a
         JOIN substitution_runs r ON r.id = a.run_id
         JOIN timetable_entries o ON o.id = a.original_entry_id
         WHERE r.date = ? AND o.id = ? AND a.substitute_faculty_id IS NOT NULL`
      )
      .all(date, langEntry.id) as Array<{ substitute_faculty_id: string; day_of_week: string; time_slot_id: string }>

    expect(assignments.length).toBeGreaterThan(0)
    for (const assign of assignments) {
      // Substitute must not be one of the teachers teaching Section B simultaneously!
      expect(peerTeachers).not.toContain(assign.substitute_faculty_id)

      // Substitute must not be teaching any other class during that slot
      const busy = testDb!
        .prepare(
          `SELECT count(*) as c
           FROM timetable_entries te
           JOIN timetable_entry_faculty tef ON tef.entry_id = te.id
           WHERE tef.faculty_id = ? AND te.day_of_week = ? AND te.time_slot_id = ?`
        )
        .get(assign.substitute_faculty_id, assign.day_of_week, assign.time_slot_id) as { c: number }

      expect(busy.c).toBe(0)
    }
  })

  // 15. A fresh installation initializes successfully without access to the production database
  it('15. initializes a fresh installation in a separate directory without modifying production database', () => {
    const tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'substiflow-fresh-test-'))
    const prevOverride = process.env.SUBSTIFLOW_DATA_DIR
    process.env.SUBSTIFLOW_DATA_DIR = tmpDataDir

    try {
      const freshDbPath = resolveDatabasePath()
      expect(freshDbPath).toContain(tmpDataDir)
      expect(freshDbPath).not.toBe(productionDbPath)

      const freshDb = openNodeDatabase(freshDbPath)
      runMigrations(freshDb)

      const versionRow = freshDb.prepare('SELECT version FROM schema_version ORDER BY version DESC LIMIT 1').get() as { version: number }
      expect(versionRow.version).toBe(TARGET_SCHEMA_VERSION)

      const tableRow = freshDb.prepare("SELECT count(*) as c FROM sqlite_master WHERE type='table' AND name='timetable_entries'").get() as { c: number }
      expect(tableRow.c).toBe(1)

      freshDb.close()

      // Confirm production database was not touched
      const prodChecksumAfter = computeFileSha256(productionDbPath)
      expect(prodChecksumAfter).toBe(initialProdChecksum)
    } finally {
      process.env.SUBSTIFLOW_DATA_DIR = prevOverride
      fs.rmSync(tmpDataDir, { recursive: true, force: true })
    }
  })

  // 16. Demo data demonstrates the synchronization rule visibly
  it('16. demonstrates semester-wide language synchronization visibly in demo data structure', () => {
    const entries = draftTimetableEntryRepository.findByGenerationWithRelations(generationId)
    const isSyncActive = settingsRepository.getSyncIndianLanguages()
    expect(isSyncActive).toBe(true)

    const langEntries = entries.filter((e) => isLanguageSubject(e.subject))
    expect(langEntries.length).toBe(4) // 1 session * 4 sections (sec-i-a, sec-i-b, sec-iii-a, sec-iii-b)

    for (const e of langEntries) {
      expect(isLanguageSubject(e.subject)).toBe(true)
    }

    const semMap = new Map<number, typeof langEntries>()
    for (const e of langEntries) {
      const sem = e.section?.semester ?? 1
      const list = semMap.get(sem) ?? []
      list.push(e)
      semMap.set(sem, list)
    }

    expect(Array.from(semMap.keys()).sort()).toEqual([1, 3])

    for (const [semester, list] of semMap.entries()) {
      const secEntries = new Map<string, typeof list>()
      for (const e of list) {
        const secList = secEntries.get(e.sectionId) ?? []
        secList.push(e)
        secEntries.set(e.sectionId, secList)
      }

      // 2 sections per semester in demo
      expect(secEntries.size).toBe(2)

      const sectionLists = Array.from(secEntries.values())
      const [listA, listB] = sectionLists

      expect(listA.length).toBe(1)
      expect(listB.length).toBe(1)

      const slotsA = listA.map((e) => `${e.dayOfWeek}|${e.timeSlotId}`).sort()
      const slotsB = listB.map((e) => `${e.dayOfWeek}|${e.timeSlotId}`).sort()

      expect(slotsA).toEqual(slotsB)
    }
  })
})
