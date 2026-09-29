/**
 * Regression suite for the context-aware Master Timetable entry UX.
 *
 *  1. Clicking a cell pre-fills the day
 *  2. Clicking a cell pre-fills the time slot
 *  3. Clicking a cell pre-fills the section (inherited from the class filter)
 *  4. Quick entry saves without re-selecting those fields
 *  5. Faculty selection filters the subject list
 *  6. Subject selection filters the faculty list
 *  7. An invalid faculty–subject combination cannot be saved
 *  8. The full Add Entry form still supports every field
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import { schema } from '@/db/schema'
import { timeSlotRepository } from '@/db/repositories/timeSlot'
import { timetableEntryRepository } from '@/db/repositories/timetableEntry'
import { academicYearRepository } from '@/db/repositories/academicYear'
import { departmentRepository } from '@/db/repositories/department'
import { facultyRepository } from '@/db/repositories/faculty'
import { subjectRepository } from '@/db/repositories/subject'
import { sectionRepository } from '@/db/repositories/section'
import { roomRepository } from '@/db/repositories/room'
import {
  createTimetableEntry,
  validateTimetableEntryInput,
  resolveCellAction,
  buildQuickEntryInput,
  findFreeRoomId,
  subjectsForFaculty,
  facultyForSubject,
  reconcileFacultyChange,
  reconcileSubjectChange,
  NO_SUBJECTS_FOR_FACULTY,
  NO_FACULTY_FOR_SUBJECT,
} from '@/services/timetable'
import type { TimetableEntryWithRelations } from '@/types'

let testDb: Database.Database | null = null

vi.mock('@/db/database', () => ({
  getDatabase: () => testDb,
  closeDatabase: () => undefined,
}))

function seedFixtures(): void {
  departmentRepository.create({ id: 'dept-bca', name: 'BCA', code: 'BCA' })
  departmentRepository.create({ id: 'dept-lang', name: 'Languages', code: 'LANG' })
  academicYearRepository.create({
    id: 'year-1',
    name: '2024-2025',
    startDate: '2024-06-01',
    endDate: '2025-05-31',
    isActive: true,
  })
  timeSlotRepository.initializeDefaults()
  facultyRepository.create({ id: 'fac-usha', name: 'Ms. Usha', departmentId: 'dept-bca' })
  facultyRepository.create({ id: 'fac-keerthi', name: 'Mrs. Keerthi', departmentId: 'dept-bca' })
  facultyRepository.create({ id: 'fac-unmapped', name: 'Mr. Nobody', departmentId: 'dept-bca' })
  subjectRepository.create({ id: 'sub-english', name: 'General English', code: 'ENG', departmentId: 'dept-lang', defaultClassType: 'LECTURE' })
  subjectRepository.create({ id: 'sub-ai', name: 'Artificial Intelligence', code: 'AI', departmentId: 'dept-bca', defaultClassType: 'LECTURE' })
  sectionRepository.create({ id: 'sec-3b', name: 'III BCA-B', departmentId: 'dept-bca', semester: 3, academicYearId: 'year-1' })
  sectionRepository.create({ id: 'sec-3a', name: 'III BCA-A', departmentId: 'dept-bca', semester: 3, academicYearId: 'year-1' })
  roomRepository.create({ id: 'room-208', name: 'Room 208' })
  roomRepository.create({ id: 'room-209', name: 'Room 209' })

  // Mappings: Usha → English; Keerthi → English + AI; Unmapped → none.
  facultyRepository.setSubjects('fac-usha', [{ facultyId: 'fac-usha', subjectId: 'sub-english', proficiency: 5 }])
  facultyRepository.setSubjects('fac-keerthi', [
    { facultyId: 'fac-keerthi', subjectId: 'sub-english', proficiency: 4 },
    { facultyId: 'fac-keerthi', subjectId: 'sub-ai', proficiency: 5 },
  ])
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

const slot1 = () => timeSlotRepository.findById('slot-1')!

// ---------------------------------------------------------------------------
// 1–4. Context-aware quick entry
// ---------------------------------------------------------------------------
describe('quick entry: cell context', () => {
  it('1. clicking a cell pre-fills the day', () => {
    const action = resolveCellAction({
      day: 'WEDNESDAY',
      slot: slot1(),
      existingEntry: null,
      sectionFilterId: 'sec-3b',
    })
    expect(action.kind).toBe('quick')
    if (action.kind === 'quick') expect(action.context.dayOfWeek).toBe('WEDNESDAY')
  })

  it('2. clicking a cell pre-fills the time slot', () => {
    const action = resolveCellAction({
      day: 'MONDAY',
      slot: slot1(),
      existingEntry: null,
      sectionFilterId: 'sec-3b',
    })
    expect(action.kind).toBe('quick')
    if (action.kind === 'quick') expect(action.context.timeSlotId).toBe('slot-1')
  })

  it('3. clicking a cell pre-fills the section from the class filter', () => {
    const action = resolveCellAction({
      day: 'TUESDAY',
      slot: slot1(),
      existingEntry: null,
      sectionFilterId: 'sec-3b',
    })
    expect(action.kind).toBe('quick')
    if (action.kind === 'quick') expect(action.context.sectionId).toBe('sec-3b')
  })

  it('4. quick entry saves without re-selecting day, time or section', () => {
    const action = resolveCellAction({
      day: 'WEDNESDAY',
      slot: slot1(),
      existingEntry: null,
      sectionFilterId: 'sec-3b',
    })
    expect(action.kind).toBe('quick')
    if (action.kind !== 'quick') return

    const rooms = roomRepository.findAll()
    const roomId = findFreeRoomId({
      day: action.context.dayOfWeek,
      timeSlotId: action.context.timeSlotId,
      entries: [],
      rooms,
    })
    expect(roomId).toBe('room-208') // nothing booked yet → first room

    // Only faculty + subject are "chosen"; day/time/section come from the cell.
    const input = buildQuickEntryInput({
      context: action.context,
      sectionId: action.context.sectionId!,
      facultyId: 'fac-usha',
      subjectId: 'sub-english',
      roomId,
    })
    expect(validateTimetableEntryInput(input)).toEqual([])
    const created = createTimetableEntry(input, 'year-1')
    const row = testDb!.prepare('SELECT * FROM timetable_entries WHERE id = ?').get(created.id) as any
    expect(row.day_of_week).toBe('WEDNESDAY')
    expect(row.time_slot_id).toBe('slot-1')
    expect(row.section_id).toBe('sec-3b')
    expect(row.academic_year_id).toBe('year-1')
  })

  it('break cells are not assignable and occupied cells open the entry for editing', () => {
    const breakSlot = timeSlotRepository.getBreakSlots()[0]
    expect(resolveCellAction({ day: 'MONDAY', slot: breakSlot, existingEntry: null, sectionFilterId: '' }).kind).toBe('break')

    const fakeEntry = { id: 'tt-existing' } as TimetableEntryWithRelations
    const action = resolveCellAction({ day: 'MONDAY', slot: slot1(), existingEntry: fakeEntry, sectionFilterId: '' })
    expect(action.kind).toBe('edit')
    if (action.kind === 'edit') expect(action.entry.id).toBe('tt-existing')

    // No class filter → the section is unknown and must be asked for.
    const quick = resolveCellAction({ day: 'MONDAY', slot: slot1(), existingEntry: null, sectionFilterId: '' })
    expect(quick.kind).toBe('quick')
    if (quick.kind === 'quick') expect(quick.context.sectionId).toBeNull()
  })

  it('findFreeRoomId skips rooms already booked at that day/period', () => {
    createTimetableEntry(
      buildQuickEntryInput({
        context: { dayOfWeek: 'WEDNESDAY', timeSlotId: 'slot-1', sectionId: 'sec-3b' },
        sectionId: 'sec-3b',
        facultyId: 'fac-usha',
        subjectId: 'sub-english',
        roomId: 'room-208',
      }),
      'year-1'
    )
    const free = findFreeRoomId({
      day: 'WEDNESDAY',
      timeSlotId: 'slot-1',
      entries: timetableEntryRepository.getWithRelations('year-1'),
      rooms: roomRepository.findAll(),
    })
    expect(free).toBe('room-209')
  })
})

// ---------------------------------------------------------------------------
// 5–7. Faculty ↔ subject filtering
// ---------------------------------------------------------------------------
describe('faculty ↔ subject dropdown filtering', () => {
  it('5. selecting a faculty filters the subjects to their mappings', () => {
    const all = subjectRepository.findAll()
    expect(subjectsForFaculty('fac-usha', all).map(s => s.id)).toEqual(['sub-english'])
    expect(subjectsForFaculty('fac-keerthi', all).map(s => s.id).sort()).toEqual(['sub-ai', 'sub-english'])
    // No faculty selected → the full list stays available.
    expect(subjectsForFaculty('', all)).toHaveLength(all.length)
    // Faculty with no mappings → empty list; the UI shows this message.
    expect(subjectsForFaculty('fac-unmapped', all)).toEqual([])
    expect(NO_SUBJECTS_FOR_FACULTY).toBe('No subjects assigned to this faculty.')
  })

  it('6. selecting a subject filters the faculty to those linked to it', () => {
    const all = facultyRepository.findActive()
    expect(facultyForSubject('sub-english', all).map(f => f.id).sort()).toEqual(['fac-keerthi', 'fac-usha'])
    expect(facultyForSubject('sub-ai', all).map(f => f.id)).toEqual(['fac-keerthi'])
    // No subject selected → the full list stays available.
    expect(facultyForSubject('', all)).toHaveLength(all.length)
    // Nobody linked → empty list; the UI shows this message.
    expect(facultyForSubject('sub-unknown', all)).toEqual([])
    expect(NO_FACULTY_FOR_SUBJECT).toBe('No faculty are qualified for this subject.')
  })

  it('7. an invalid faculty–subject combination cannot be saved', () => {
    const base = {
      dayOfWeek: 'WEDNESDAY' as const,
      timeSlotId: 'slot-1',
      sectionId: 'sec-3b',
      subjectId: 'sub-english',
      facultyId: 'fac-unmapped',
      roomId: 'room-208',
      classType: 'LECTURE' as const,
    }
    // Create path rejects it...
    expect(() => createTimetableEntry(base, 'year-1')).toThrow(/not assigned|no subjects assigned/i)
    expect(timetableEntryRepository.getWithRelations('year-1')).toHaveLength(0)

    // ...validation reports it explicitly...
    const errors = validateTimetableEntryInput(base)
    expect(errors).toHaveLength(1)
    expect(errors[0]).toMatch(/Mr\. Nobody/)

    // ...and changing either side reconciles the stale selection away.
    expect(reconcileFacultyChange('fac-unmapped', 'sub-english')).toEqual({ subjectId: '', cleared: true })
    expect(reconcileSubjectChange('fac-unmapped', 'sub-english')).toEqual({ facultyId: '', cleared: true })
    // A valid pairing reconciles to nothing.
    expect(reconcileFacultyChange('fac-usha', 'sub-english')).toEqual({ subjectId: 'sub-english', cleared: false })
    expect(reconcileSubjectChange('fac-usha', 'sub-english')).toEqual({ facultyId: 'fac-usha', cleared: false })

    // The corrected pairing saves.
    expect(() => createTimetableEntry({ ...base, facultyId: 'fac-keerthi' }, 'year-1')).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// 8. Full Add Entry form
// ---------------------------------------------------------------------------
describe('full Add Entry form', () => {
  it('8. supports every field (day, slot, section, faculty, subject, room, class type)', () => {
    const payload = {
      dayOfWeek: 'THURSDAY' as const,
      timeSlotId: 'slot-2',
      sectionId: 'sec-3a',
      facultyId: 'fac-keerthi',
      subjectId: 'sub-ai',
      roomId: 'room-209',
      classType: 'LAB' as const,
    }
    expect(validateTimetableEntryInput(payload)).toEqual([])
    const created = createTimetableEntry(payload, 'year-1')
    const row = testDb!.prepare('SELECT * FROM timetable_entries WHERE id = ?').get(created.id) as any
    expect(row.day_of_week).toBe('THURSDAY')
    expect(row.time_slot_id).toBe('slot-2')
    expect(row.section_id).toBe('sec-3a')
    expect(row.faculty_id).toBe('fac-keerthi')
    expect(row.subject_id).toBe('sub-ai')
    expect(row.room_id).toBe('room-209')
    expect(row.class_type).toBe('LAB')
    expect(row.academic_year_id).toBe('year-1')
  })
})
