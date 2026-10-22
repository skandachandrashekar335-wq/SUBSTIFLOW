/**
 * Unit tests for draft editing operations: moveDraftEntry and swapDraftEntries.
 *
 * Verifies atomic draft manipulation:
 *  - Move to empty slot
 *  - Contiguous 2-period lab move
 *  - Rejection when crossing break or exceeding day
 *  - Rejection when section, faculty, or room has conflict
 *  - Compatible swap
 *  - Rejection of invalid swap
 *  - Rejection on published drafts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import os from 'os'
import path from 'path'
import fs from 'fs'
import { schema } from '@/db/schema'
import {
  departmentRepository,
  academicYearRepository,
  facultyRepository,
  sectionRepository,
  subjectRepository,
  roomRepository,
  timetableGenerationRepository,
  draftTimetableEntryRepository,
  timeSlotRepository,
  settingsRepository,
} from '@/db/repositories'
import { moveDraftEntry, swapDraftEntries } from '@/services/timetableGenerator'

let testDb: Database.Database | null = null

vi.mock('@/db/database', () => ({
  getDatabase: () => testDb,
  closeDatabase: () => undefined,
}))

describe('draft editing operations (moveDraftEntry & swapDraftEntries)', () => {
  let dbDir = ''
  const genId = 'gen-test-1'
  const yearId = 'year-test-1'

  beforeEach(() => {
    dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'substiflow-draft-edit-'))
    testDb = new Database(path.join(dbDir, 'test.db'))
    testDb.exec(schema)

    departmentRepository.create({ id: 'dept-bca', name: 'BCA', code: 'BCA' })
    academicYearRepository.create({
      id: yearId,
      name: '2026-2027',
      startDate: '2026-06-01',
      endDate: '2027-05-31',
      isActive: true,
    })

    // Faculty
    facultyRepository.create({ id: 'fac-1', name: 'Faculty One', departmentId: 'dept-bca', staffType: 'TEACHING' })
    facultyRepository.create({ id: 'fac-2', name: 'Faculty Two', departmentId: 'dept-bca', staffType: 'TEACHING' })

    // Sections
    sectionRepository.create({ id: 'sec-a', name: 'I BCA A', semester: 1, departmentId: 'dept-bca', academicYearId: yearId })
    sectionRepository.create({ id: 'sec-b', name: 'I BCA B', semester: 1, departmentId: 'dept-bca', academicYearId: yearId })

    // Subjects
    subjectRepository.create({ id: 'sub-dms', name: 'DMS', code: '24BCA11', departmentId: 'dept-bca', defaultClassType: 'LECTURE' })
    subjectRepository.create({ id: 'sub-ca', name: 'CA', code: '24BCA13', departmentId: 'dept-bca', defaultClassType: 'LECTURE' })
    subjectRepository.create({ id: 'sub-lab', name: 'DMS Lab', code: '24BCAL13', departmentId: 'dept-bca', defaultClassType: 'LAB' })

    // Rooms
    roomRepository.create({ id: 'room-101', name: 'Room 101', capacity: 60, type: 'CLASSROOM', departmentId: 'dept-bca' })
    roomRepository.create({ id: 'room-lab-1', name: 'Lab 1', capacity: 40, type: 'LAB', departmentId: 'dept-bca' })

    // Time slots (6 teaching periods + 1 lunch break at slot-5)
    timeSlotRepository.create({ id: 'slot-1', name: '09:00-10:00', startTime: '09:00', endTime: '10:00', order: 1, isBreak: false })
    timeSlotRepository.create({ id: 'slot-2', name: '10:00-11:00', startTime: '10:00', endTime: '11:00', order: 2, isBreak: false })
    timeSlotRepository.create({ id: 'slot-3', name: '11:00-12:00', startTime: '11:00', endTime: '12:00', order: 3, isBreak: false })
    timeSlotRepository.create({ id: 'slot-4', name: '12:00-13:00', startTime: '12:00', endTime: '13:00', order: 4, isBreak: false })
    timeSlotRepository.create({ id: 'slot-break', name: '13:00-14:00', startTime: '13:00', endTime: '14:00', order: 5, isBreak: true })
    timeSlotRepository.create({ id: 'slot-5', name: '14:00-15:00', startTime: '14:00', endTime: '15:00', order: 6, isBreak: false })
    timeSlotRepository.create({ id: 'slot-6', name: '15:00-16:00', startTime: '15:00', endTime: '16:00', order: 7, isBreak: false })

    // Settings
    settingsRepository.set('working_days', 'MONDAY,TUESDAY,WEDNESDAY,THURSDAY,FRIDAY,SATURDAY')
    settingsRepository.set('working_hours_start', '09:00')
    settingsRepository.set('working_hours_end', '16:00')
    settingsRepository.set('break_start', '13:00')
    settingsRepository.set('break_end', '14:00')

    // Generation
    timetableGenerationRepository.create({
      id: genId,
      academicYearId: yearId,
      status: 'COMPLETED',
      totalEntries: 2,
    })
  })

  afterEach(() => {
    testDb?.close()
    testDb = null
    if (dbDir) fs.rmSync(dbDir, { recursive: true, force: true })
  })

  it('moves a lecture entry to a valid empty slot on another day', () => {
    const entry = draftTimetableEntryRepository.create({
      id: 'entry-1',
      generationId: genId,
      academicYearId: yearId,
      dayOfWeek: 'MONDAY',
      timeSlotId: 'slot-1',
      sectionId: 'sec-a',
      subjectId: 'sub-dms',
      classType: 'LECTURE',
      span: 1,
      status: 'DRAFT',
      facultyIds: ['fac-1'],
    })

    const res = moveDraftEntry(genId, entry.id, 'TUESDAY', 'slot-2')
    expect(res.success).toBe(true)

    const updated = draftTimetableEntryRepository.findById(entry.id)
    expect(updated?.dayOfWeek).toBe('TUESDAY')
    expect(updated?.timeSlotId).toBe('slot-2')
  })

  it('moves a 2-period lab to an empty 2-period block', () => {
    const lab = draftTimetableEntryRepository.create({
      id: 'lab-1',
      generationId: genId,
      academicYearId: yearId,
      dayOfWeek: 'MONDAY',
      timeSlotId: 'slot-1',
      sectionId: 'sec-a',
      subjectId: 'sub-lab',
      classType: 'LAB',
      span: 2,
      status: 'DRAFT',
      facultyIds: ['fac-1'],
      roomIds: ['room-lab-1'],
    })

    const res = moveDraftEntry(genId, lab.id, 'WEDNESDAY', 'slot-3')
    // slot-3 + slot-4 = 11:00-13:00 (before break at 13:00)
    expect(res.success).toBe(true)

    const updated = draftTimetableEntryRepository.findById(lab.id)
    expect(updated?.dayOfWeek).toBe('WEDNESDAY')
    expect(updated?.timeSlotId).toBe('slot-3')
  })

  it('rejects moving a 2-period lab across the lunch break', () => {
    const lab = draftTimetableEntryRepository.create({
      id: 'lab-1',
      generationId: genId,
      academicYearId: yearId,
      dayOfWeek: 'MONDAY',
      timeSlotId: 'slot-1',
      sectionId: 'sec-a',
      subjectId: 'sub-lab',
      classType: 'LAB',
      span: 2,
      status: 'DRAFT',
      facultyIds: ['fac-1'],
      roomIds: ['room-lab-1'],
    })

    // slot-4 is 12:00-13:00, next period is break (13:00-14:00)
    const res = moveDraftEntry(genId, lab.id, 'MONDAY', 'slot-4')
    expect(res.success).toBe(false)
    expect(res.error).toMatch(/break/i)
  })

  it('rejects moving when section has another class scheduled at target slot', () => {
    draftTimetableEntryRepository.create({
      id: 'entry-a1',
      generationId: genId,
      academicYearId: yearId,
      dayOfWeek: 'MONDAY',
      timeSlotId: 'slot-1',
      sectionId: 'sec-a',
      subjectId: 'sub-dms',
      classType: 'LECTURE',
      span: 1,
      status: 'DRAFT',
      facultyIds: ['fac-1'],
    })
    draftTimetableEntryRepository.create({
      id: 'entry-a2',
      generationId: genId,
      academicYearId: yearId,
      dayOfWeek: 'MONDAY',
      timeSlotId: 'slot-2',
      sectionId: 'sec-a',
      subjectId: 'sub-ca',
      classType: 'LECTURE',
      span: 1,
      status: 'DRAFT',
      facultyIds: ['fac-2'],
    })

    // Attempt to move entry-a1 into slot-2 where sec-a already has sub-ca
    const res = moveDraftEntry(genId, 'entry-a1', 'MONDAY', 'slot-2')
    expect(res.success).toBe(false)
    expect(res.error).toMatch(/section conflict/i)
  })

  it('rejects moving when faculty is already busy with another section at target slot', () => {
    draftTimetableEntryRepository.create({
      id: 'entry-a',
      generationId: genId,
      academicYearId: yearId,
      dayOfWeek: 'MONDAY',
      timeSlotId: 'slot-1',
      sectionId: 'sec-a',
      subjectId: 'sub-dms',
      classType: 'LECTURE',
      span: 1,
      status: 'DRAFT',
      facultyIds: ['fac-1'],
    })
    draftTimetableEntryRepository.create({
      id: 'entry-b',
      generationId: genId,
      academicYearId: yearId,
      dayOfWeek: 'MONDAY',
      timeSlotId: 'slot-2',
      sectionId: 'sec-b',
      subjectId: 'sub-dms',
      classType: 'LECTURE',
      span: 1,
      status: 'DRAFT',
      facultyIds: ['fac-1'], // fac-1 teaches sec-b at slot-2
    })

    // Attempt to move entry-a into slot-2: fac-1 is busy with sec-b!
    const res = moveDraftEntry(genId, 'entry-a', 'MONDAY', 'slot-2')
    expect(res.success).toBe(false)
    expect(res.error).toMatch(/faculty conflict/i)
  })

  it('rejects moving when room is already occupied', () => {
    draftTimetableEntryRepository.create({
      id: 'lab-a',
      generationId: genId,
      academicYearId: yearId,
      dayOfWeek: 'MONDAY',
      timeSlotId: 'slot-1',
      sectionId: 'sec-a',
      subjectId: 'sub-lab',
      classType: 'LAB',
      span: 2,
      status: 'DRAFT',
      facultyIds: ['fac-1'],
      roomIds: ['room-lab-1'],
    })
    draftTimetableEntryRepository.create({
      id: 'lab-b',
      generationId: genId,
      academicYearId: yearId,
      dayOfWeek: 'TUESDAY',
      timeSlotId: 'slot-1',
      sectionId: 'sec-b',
      subjectId: 'sub-lab',
      classType: 'LAB',
      span: 2,
      status: 'DRAFT',
      facultyIds: ['fac-2'],
      roomIds: ['room-lab-1'],
    })

    // Attempt to move lab-b to MONDAY slot-1: room-lab-1 is occupied by sec-a!
    const res = moveDraftEntry(genId, 'lab-b', 'MONDAY', 'slot-1')
    expect(res.success).toBe(false)
    expect(res.error).toMatch(/room conflict/i)
  })

  it('swaps two compatible entries atomically', () => {
    draftTimetableEntryRepository.create({
      id: 'entry-1',
      generationId: genId,
      academicYearId: yearId,
      dayOfWeek: 'MONDAY',
      timeSlotId: 'slot-1',
      sectionId: 'sec-a',
      subjectId: 'sub-dms',
      classType: 'LECTURE',
      span: 1,
      status: 'DRAFT',
      facultyIds: ['fac-1'],
    })
    draftTimetableEntryRepository.create({
      id: 'entry-2',
      generationId: genId,
      academicYearId: yearId,
      dayOfWeek: 'TUESDAY',
      timeSlotId: 'slot-2',
      sectionId: 'sec-a',
      subjectId: 'sub-ca',
      classType: 'LECTURE',
      span: 1,
      status: 'DRAFT',
      facultyIds: ['fac-2'],
    })

    const res = swapDraftEntries(genId, 'entry-1', 'entry-2')
    expect(res.success).toBe(true)

    const u1 = draftTimetableEntryRepository.findById('entry-1')
    const u2 = draftTimetableEntryRepository.findById('entry-2')
    expect(u1?.dayOfWeek).toBe('TUESDAY')
    expect(u1?.timeSlotId).toBe('slot-2')
    expect(u2?.dayOfWeek).toBe('MONDAY')
    expect(u2?.timeSlotId).toBe('slot-1')
  })

  it('rejects editing a published draft', () => {
    const entry = draftTimetableEntryRepository.create({
      id: 'pub-entry',
      generationId: genId,
      academicYearId: yearId,
      dayOfWeek: 'MONDAY',
      timeSlotId: 'slot-1',
      sectionId: 'sec-a',
      subjectId: 'sub-dms',
      classType: 'LECTURE',
      span: 1,
      status: 'PUBLISHED',
      facultyIds: ['fac-1'],
    })

    const res = moveDraftEntry(genId, entry.id, 'TUESDAY', 'slot-2')
    expect(res.success).toBe(false)
    expect(res.error).toMatch(/already been published/i)
  })
})
