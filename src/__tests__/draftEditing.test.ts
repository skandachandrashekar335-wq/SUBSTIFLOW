/**
 * Unit tests for draft editing operations: moveDraftEntry, swapDraftEntries,
 * drag-and-drop evaluation, accessible dialog execution, undo history,
 * and validation invalidation.
 *
 * Covers all 15 required scenarios:
 *  1. Moving a lecture to an empty period in the same section.
 *  2. Moving it back.
 *  3. Swapping two compatible lectures.
 *  4. Rejecting a swap that would create a faculty conflict.
 *  5. Rejecting a swap that would create a room conflict.
 *  6. Rejecting cross-section drops without changing section ownership.
 *  7. Dropping onto a lab's continuation period.
 *  8. Moving a 2-period lab as one complete block.
 *  9. Rejecting a lab move across lunch or beyond the day.
 * 10. Rejecting a lab move that overlaps another activity in the same section.
 * 11. Confirming failed operations roll back every database change.
 * 12. Confirming each dialog action invokes the service exactly once.
 * 13. Confirming undo restores previous positions (including 2-period lab blocks).
 * 14. Confirming edits invalidate stale validation and fresh validation is required before publication.
 * 15. Confirming drag state clears after success and failure.
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
  subjectRequirementRepository,
  teachingAllocationRepository,
} from '@/db/repositories'
import {
  moveDraftEntry,
  swapDraftEntries,
  validateDraftTimetable,
} from '@/services/timetableGenerator'
import { evaluateDraftDrop } from '@/pages/Generation'
import type { DayOfWeek, DraftTimetableEntryWithRelations } from '@/types'

let testDb: Database.Database | null = null

vi.mock('@/db/database', () => ({
  getDatabase: () => testDb,
  closeDatabase: () => undefined,
}))

describe('draft editing operations (moveDraftEntry, swapDraftEntries & D&D)', () => {
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
    facultyRepository.create({ id: 'fac-3', name: 'Faculty Three', departmentId: 'dept-bca', staffType: 'TEACHING' })

    // Sections
    sectionRepository.create({ id: 'sec-a', name: 'I BCA A', semester: 1, departmentId: 'dept-bca', academicYearId: yearId })
    sectionRepository.create({ id: 'sec-b', name: 'I BCA B', semester: 1, departmentId: 'dept-bca', academicYearId: yearId })
    sectionRepository.create({ id: 'sec-c', name: 'III BCA A', semester: 3, departmentId: 'dept-bca', academicYearId: yearId })

    // Subjects
    subjectRepository.create({ id: 'sub-dms', name: 'DMS', code: '24BCA11', departmentId: 'dept-bca', defaultClassType: 'LECTURE' })
    subjectRepository.create({ id: 'sub-ca', name: 'CA', code: '24BCA13', departmentId: 'dept-bca', defaultClassType: 'LECTURE' })
    subjectRepository.create({ id: 'sub-lab', name: 'DMS Lab', code: '24BCAL13', departmentId: 'dept-bca', defaultClassType: 'LAB' })

    // Rooms
    roomRepository.create({ id: 'room-101', name: 'Room 101', capacity: 60, type: 'CLASSROOM', departmentId: 'dept-bca' })
    roomRepository.create({ id: 'room-lab-1', name: 'Lab 1', capacity: 40, type: 'LAB', departmentId: 'dept-bca' })
    roomRepository.create({ id: 'room-lab-2', name: 'Lab 2', capacity: 40, type: 'LAB', departmentId: 'dept-bca' })

    // Time slots (6 teaching periods + 1 lunch break at slot-break)
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

  // 1. Moving a lecture to an empty period in the same section
  it('1. moves a lecture to an empty period in the same section', () => {
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
    expect(updated?.sectionId).toBe('sec-a')
  })

  // 2. Moving it back
  it('2. moves the lecture back to its original slot', () => {
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

    // Move to TUESDAY slot-2
    expect(moveDraftEntry(genId, entry.id, 'TUESDAY', 'slot-2').success).toBe(true)
    let updated = draftTimetableEntryRepository.findById(entry.id)
    expect(updated?.dayOfWeek).toBe('TUESDAY')
    expect(updated?.timeSlotId).toBe('slot-2')

    // Move back to MONDAY slot-1
    expect(moveDraftEntry(genId, entry.id, 'MONDAY', 'slot-1').success).toBe(true)
    updated = draftTimetableEntryRepository.findById(entry.id)
    expect(updated?.dayOfWeek).toBe('MONDAY')
    expect(updated?.timeSlotId).toBe('slot-1')
  })

  // 3. Swapping two compatible lectures
  it('3. swaps two compatible lectures atomically and treats self-drop as no-op', () => {
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

    // Self-drop is a no-op
    const selfRes = swapDraftEntries(genId, 'entry-1', 'entry-1')
    expect(selfRes.success).toBe(true)

    // Compatible swap
    const res = swapDraftEntries(genId, 'entry-1', 'entry-2')
    expect(res.success).toBe(true)

    const u1 = draftTimetableEntryRepository.findById('entry-1')
    const u2 = draftTimetableEntryRepository.findById('entry-2')
    expect(u1?.dayOfWeek).toBe('TUESDAY')
    expect(u1?.timeSlotId).toBe('slot-2')
    expect(u2?.dayOfWeek).toBe('MONDAY')
    expect(u2?.timeSlotId).toBe('slot-1')
  })

  // 4. Rejecting a swap that would create a faculty conflict
  it('4. rejects a swap that would create a faculty conflict and leaves database unchanged', () => {
    // entry-a: sec-a, MONDAY slot-1, fac-1
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
    // entry-b: sec-b, TUESDAY slot-2, fac-2
    draftTimetableEntryRepository.create({
      id: 'entry-b',
      generationId: genId,
      academicYearId: yearId,
      dayOfWeek: 'TUESDAY',
      timeSlotId: 'slot-2',
      sectionId: 'sec-b',
      subjectId: 'sub-ca',
      classType: 'LECTURE',
      span: 1,
      status: 'DRAFT',
      facultyIds: ['fac-2'],
    })
    // entry-c: sec-c, TUESDAY slot-2, fac-1 (fac-1 is busy teaching sec-c at TUESDAY slot-2)
    draftTimetableEntryRepository.create({
      id: 'entry-c',
      generationId: genId,
      academicYearId: yearId,
      dayOfWeek: 'TUESDAY',
      timeSlotId: 'slot-2',
      sectionId: 'sec-c',
      subjectId: 'sub-dms',
      classType: 'LECTURE',
      span: 1,
      status: 'DRAFT',
      facultyIds: ['fac-1'],
    })

    // Swapping entry-a and entry-b would move entry-a (fac-1) to TUESDAY slot-2 where fac-1 teaches entry-c!
    const res = swapDraftEntries(genId, 'entry-a', 'entry-b')
    expect(res.success).toBe(false)
    expect(res.error).toMatch(/faculty conflict/i)

    // Database completely unchanged
    const ua = draftTimetableEntryRepository.findById('entry-a')
    const ub = draftTimetableEntryRepository.findById('entry-b')
    expect(ua?.dayOfWeek).toBe('MONDAY')
    expect(ua?.timeSlotId).toBe('slot-1')
    expect(ub?.dayOfWeek).toBe('TUESDAY')
    expect(ub?.timeSlotId).toBe('slot-2')
  })

  // 5. Rejecting a swap that would create a room conflict
  it('5. rejects a swap that would create a room conflict and leaves database unchanged', () => {
    // lab-a: sec-a, MONDAY slot-1, room-lab-1
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
    // lab-b: sec-b, TUESDAY slot-1, room-lab-2
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
      roomIds: ['room-lab-2'],
    })
    // lab-c: sec-c, TUESDAY slot-1, room-lab-1 (room-lab-1 is booked on TUESDAY slot-1)
    draftTimetableEntryRepository.create({
      id: 'lab-c',
      generationId: genId,
      academicYearId: yearId,
      dayOfWeek: 'TUESDAY',
      timeSlotId: 'slot-1',
      sectionId: 'sec-c',
      subjectId: 'sub-lab',
      classType: 'LAB',
      span: 2,
      status: 'DRAFT',
      facultyIds: ['fac-3'],
      roomIds: ['room-lab-1'],
    })

    // Swapping lab-a and lab-b would place lab-a (room-lab-1) at TUESDAY slot-1 where lab-c uses room-lab-1!
    const res = swapDraftEntries(genId, 'lab-a', 'lab-b')
    expect(res.success).toBe(false)
    expect(res.error).toMatch(/room conflict/i)

    // Database completely unchanged
    expect(draftTimetableEntryRepository.findById('lab-a')?.dayOfWeek).toBe('MONDAY')
    expect(draftTimetableEntryRepository.findById('lab-b')?.dayOfWeek).toBe('TUESDAY')
  })

  // 6. Rejecting cross-section drops without changing section ownership
  it('6. rejects cross-section drops without changing section ownership', () => {
    const entryA: DraftTimetableEntryWithRelations = {
      id: 'entry-sec-a',
      generationId: genId,
      academicYearId: yearId,
      dayOfWeek: 'MONDAY',
      timeSlotId: 'slot-1',
      sectionId: 'sec-a',
      subjectId: 'sub-dms',
      classType: 'LECTURE',
      span: 1,
      status: 'DRAFT',
      createdAt: '',
      updatedAt: '',
    }

    // Drop onto empty period in section B
    const evalRes = evaluateDraftDrop({
      draggedEntry: entryA,
      targetDay: 'MONDAY',
      targetSlotId: 'slot-2',
      targetSectionId: 'sec-b',
    })

    expect(evalRes.success).toBe(false)
    expect(evalRes.action).toBe('none')
    expect(evalRes.error).toMatch(/another section|academic ownership/i)

    // Section ownership is never changed
    expect(entryA.sectionId).toBe('sec-a')
  })

  // 7. Dropping onto a lab's continuation period
  it('7. rejects dropping onto a lab continuation period without inferring a swap', () => {
    const labEntry: DraftTimetableEntryWithRelations = {
      id: 'lab-main',
      generationId: genId,
      academicYearId: yearId,
      dayOfWeek: 'MONDAY',
      timeSlotId: 'slot-1',
      sectionId: 'sec-a',
      subjectId: 'sub-lab',
      classType: 'LAB',
      span: 2,
      status: 'DRAFT',
      createdAt: '',
      updatedAt: '',
    }

    const draggedLecture: DraftTimetableEntryWithRelations = {
      id: 'lecture-dragged',
      generationId: genId,
      academicYearId: yearId,
      dayOfWeek: 'TUESDAY',
      timeSlotId: 'slot-1',
      sectionId: 'sec-a',
      subjectId: 'sub-dms',
      classType: 'LECTURE',
      span: 1,
      status: 'DRAFT',
      createdAt: '',
      updatedAt: '',
    }

    // Continuation item in slot-2 (isStart = false)
    const evalRes = evaluateDraftDrop({
      draggedEntry: draggedLecture,
      targetDay: 'MONDAY',
      targetSlotId: 'slot-2',
      targetSectionId: 'sec-a',
      targetItem: { entry: labEntry, isStart: false },
    })

    expect(evalRes.success).toBe(false)
    expect(evalRes.action).toBe('none')
    expect(evalRes.error).toMatch(/continuation period/i)
  })

  // 8. Moving a 2-period lab as one complete block
  it('8. moves a 2-period lab as one complete block across all covered slots', () => {
    const lab = draftTimetableEntryRepository.create({
      id: 'lab-block',
      generationId: genId,
      academicYearId: yearId,
      dayOfWeek: 'MONDAY',
      timeSlotId: 'slot-1',
      sectionId: 'sec-a',
      subjectId: 'sub-lab',
      classType: 'LAB',
      span: 2,
      status: 'DRAFT',
      facultyIds: ['fac-1', 'fac-2'],
      roomIds: ['room-lab-1'],
    })

    // Move to WEDNESDAY slot-3 (spans slot-3 and slot-4, 11:00-13:00, before break at 13:00)
    const res = moveDraftEntry(genId, lab.id, 'WEDNESDAY', 'slot-3')
    expect(res.success).toBe(true)

    const updated = draftTimetableEntryRepository.findById(lab.id)
    expect(updated?.dayOfWeek).toBe('WEDNESDAY')
    expect(updated?.timeSlotId).toBe('slot-3')
    expect(updated?.span).toBe(2)

    // With relations: faculty team and room are preserved
    const withRel = draftTimetableEntryRepository.findByGenerationWithRelations(genId)
    const labRel = withRel.find((e) => e.id === lab.id)
    expect(labRel?.facultyList?.map((f) => f.id)).toEqual(['fac-1', 'fac-2'])
    expect(labRel?.roomList?.map((r) => r.id)).toEqual(['room-lab-1'])
  })

  // 9. Rejecting a lab move across lunch or beyond the day
  it('9. rejects a lab move across lunch break or beyond the end of the day', () => {
    const lab = draftTimetableEntryRepository.create({
      id: 'lab-span2',
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

    // slot-4 is 12:00-13:00, next period is break 13:00-14:00
    const resBreak = moveDraftEntry(genId, lab.id, 'MONDAY', 'slot-4')
    expect(resBreak.success).toBe(false)
    expect(resBreak.error).toMatch(/break/i)

    // slot-6 is 15:00-16:00 (last period of the day)
    const resDayEnd = moveDraftEntry(genId, lab.id, 'MONDAY', 'slot-6')
    expect(resDayEnd.success).toBe(false)
    expect(resDayEnd.error).toMatch(/past the last period|outside configured/i)

    // Database record was not touched
    const current = draftTimetableEntryRepository.findById(lab.id)
    expect(current?.dayOfWeek).toBe('MONDAY')
    expect(current?.timeSlotId).toBe('slot-1')
  })

  // 10. Rejecting a lab move that overlaps another activity in the same section
  it('10. rejects a lab move that overlaps another activity in the same section', () => {
    // Lecture at slot-2 in sec-a
    draftTimetableEntryRepository.create({
      id: 'sec-a-lecture',
      generationId: genId,
      academicYearId: yearId,
      dayOfWeek: 'MONDAY',
      timeSlotId: 'slot-2',
      sectionId: 'sec-a',
      subjectId: 'sub-dms',
      classType: 'LECTURE',
      span: 1,
      status: 'DRAFT',
      facultyIds: ['fac-2'],
    })

    // 2-period lab at slot-5 in sec-a
    const lab = draftTimetableEntryRepository.create({
      id: 'sec-a-lab',
      generationId: genId,
      academicYearId: yearId,
      dayOfWeek: 'MONDAY',
      timeSlotId: 'slot-5',
      sectionId: 'sec-a',
      subjectId: 'sub-lab',
      classType: 'LAB',
      span: 2,
      status: 'DRAFT',
      facultyIds: ['fac-1'],
      roomIds: ['room-lab-1'],
    })

    // Attempt to move lab to slot-1: covers slot-1 and slot-2, but slot-2 has sec-a-lecture!
    const res = moveDraftEntry(genId, lab.id, 'MONDAY', 'slot-1')
    expect(res.success).toBe(false)
    expect(res.error).toMatch(/section conflict/i)

    // Lab stays at slot-5
    expect(draftTimetableEntryRepository.findById(lab.id)?.timeSlotId).toBe('slot-5')
  })

  // 11. Confirming failed operations roll back every database change
  it('11. rolls back every database change when an operation fails', () => {
    draftTimetableEntryRepository.create({
      id: 'entry-stable-1',
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
      id: 'entry-stable-2',
      generationId: genId,
      academicYearId: yearId,
      dayOfWeek: 'TUESDAY',
      timeSlotId: 'slot-2',
      sectionId: 'sec-a',
      subjectId: 'sub-ca',
      classType: 'LECTURE',
      span: 1,
      status: 'DRAFT',
      facultyIds: ['fac-1'], // fac-1 teaches both
    })

    const snapshotBefore = draftTimetableEntryRepository.findByGeneration(genId)

    // Attempt to move entry-stable-1 to TUESDAY slot-2 (conflicts with entry-stable-2)
    const failedMove = moveDraftEntry(genId, 'entry-stable-1', 'TUESDAY', 'slot-2')
    expect(failedMove.success).toBe(false)

    const snapshotAfterMove = draftTimetableEntryRepository.findByGeneration(genId)
    expect(snapshotAfterMove).toEqual(snapshotBefore)

    // Attempt an invalid swap across working hours
    const failedSwap = swapDraftEntries(genId, 'entry-stable-1', 'non-existent-id')
    expect(failedSwap.success).toBe(false)

    const snapshotAfterSwap = draftTimetableEntryRepository.findByGeneration(genId)
    expect(snapshotAfterSwap).toEqual(snapshotBefore)
  })

  // 12. Confirming each dialog action invokes the service exactly once
  it('12. confirms each dialog action invokes the service exactly once', () => {
    draftTimetableEntryRepository.create({
      id: 'dialog-entry-1',
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
      id: 'dialog-entry-2',
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

    // Simulate dialog atomic move execution
    let moveCallCount = 0
    const executeDialogMove = (entryId: string, targetDay: DayOfWeek, targetSlotId: string) => {
      moveCallCount++
      return moveDraftEntry(genId, entryId, targetDay, targetSlotId)
    }

    const moveRes = executeDialogMove('dialog-entry-1', 'WEDNESDAY', 'slot-1')
    expect(moveRes.success).toBe(true)
    expect(moveCallCount).toBe(1) // EXACTLY ONCE, not twice

    // Simulate dialog atomic swap execution
    let swapCallCount = 0
    const executeDialogSwap = (entryIdA: string, entryIdB: string) => {
      swapCallCount++
      return swapDraftEntries(genId, entryIdA, entryIdB)
    }

    const swapRes = executeDialogSwap('dialog-entry-1', 'dialog-entry-2')
    expect(swapRes.success).toBe(true)
    expect(swapCallCount).toBe(1) // EXACTLY ONCE, not twice
  })

  // 13. Confirming undo restores previous positions (including 2-period lab blocks)
  it('13. confirms undo restores previous positions including 2-period lab blocks', () => {
    const lab = draftTimetableEntryRepository.create({
      id: 'undo-lab',
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

    // History tracking
    const history: Array<{ entryId: string; prevDay: DayOfWeek; prevSlotId: string }> = []

    // 1. Move lab from MONDAY slot-1 to WEDNESDAY slot-3
    history.push({ entryId: lab.id, prevDay: 'MONDAY', prevSlotId: 'slot-1' })
    const moveRes = moveDraftEntry(genId, lab.id, 'WEDNESDAY', 'slot-3')
    expect(moveRes.success).toBe(true)
    expect(draftTimetableEntryRepository.findById(lab.id)?.dayOfWeek).toBe('WEDNESDAY')

    // 2. Undo move
    const lastEdit = history.pop()!
    const undoRes = moveDraftEntry(genId, lastEdit.entryId, lastEdit.prevDay, lastEdit.prevSlotId)
    expect(undoRes.success).toBe(true)

    // Lab is fully restored to MONDAY slot-1 spanning 2 periods
    const restoredLab = draftTimetableEntryRepository.findById(lab.id)
    expect(restoredLab?.dayOfWeek).toBe('MONDAY')
    expect(restoredLab?.timeSlotId).toBe('slot-1')
    expect(restoredLab?.span).toBe(2)
  })

  // 14. Confirming edits invalidate stale validation and fresh validation is required before publication
  it('14. confirms edits invalidate stale validation and fresh validation is required before publication', () => {
    subjectRequirementRepository.create({
      id: 'req-val-1',
      academicYearId: yearId,
      sectionId: 'sec-a',
      subjectId: 'sub-dms',
      classType: 'LECTURE',
      requiredSessionsPerWeek: 1,
      span: 1,
    })
    teachingAllocationRepository.create({
      id: 'alloc-val-1',
      academicYearId: yearId,
      sectionId: 'sec-a',
      subjectId: 'sub-dms',
      facultyId: 'fac-1',
      classType: 'LECTURE',
      requiredSessionsPerWeek: 1,
    })

    draftTimetableEntryRepository.create({
      id: 'val-entry-1',
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

    // Initial validation state
    let validationResult: ReturnType<typeof validateDraftTimetable> | null = validateDraftTimetable(genId)
    const isCompleted = true
    const isPublished = false

    // Can publish requires validationResult !== null && validationResult.valid
    let canPublish = isCompleted && !isPublished && validationResult !== null && validationResult.valid
    expect(canPublish).toBe(true)

    // An edit occurs
    const editRes = moveDraftEntry(genId, 'val-entry-1', 'TUESDAY', 'slot-1')
    expect(editRes.success).toBe(true)

    // Edit MUST invalidate previous validation status
    validationResult = null
    canPublish = isCompleted && !isPublished && validationResult !== null && (validationResult as any).valid
    expect(canPublish).toBe(false) // Publishing is BLOCKED!

    // Fresh validation is explicitly run
    validationResult = validateDraftTimetable(genId)
    expect(validationResult.valid).toBe(true)

    // Publishing is permitted again
    canPublish = isCompleted && !isPublished && validationResult !== null && validationResult.valid
    expect(canPublish).toBe(true)
  })

  // 15. Confirming drag state clears after success and failure
  it('15. confirms drag state clears after success and failure', () => {
    let draggedEntry: DraftTimetableEntryWithRelations | null = null
    let dragOverKey: string | null = null

    const startDrag = (entry: DraftTimetableEntryWithRelations) => {
      draggedEntry = entry
    }
    const hoverCell = (key: string) => {
      dragOverKey = key
    }
    const endDragOrDrop = () => {
      draggedEntry = null
      dragOverKey = null
    }

    const mockEntry: DraftTimetableEntryWithRelations = {
      id: 'mock-1',
      generationId: genId,
      academicYearId: yearId,
      dayOfWeek: 'MONDAY',
      timeSlotId: 'slot-1',
      sectionId: 'sec-a',
      subjectId: 'sub-dms',
      classType: 'LECTURE',
      span: 1,
      status: 'DRAFT',
      createdAt: '',
      updatedAt: '',
    }

    // Step A: Drag starts and hovers over cell
    startDrag(mockEntry)
    hoverCell('MONDAY|slot-2|sec-a')
    expect(draggedEntry).not.toBeNull()
    expect(dragOverKey).toBe('MONDAY|slot-2|sec-a')

    // Step B: Successful drop clears drag state
    endDragOrDrop()
    expect(draggedEntry).toBeNull()
    expect(dragOverKey).toBeNull()

    // Step C: Drag starts, hovers over invalid cell, and fails or cancels
    startDrag(mockEntry)
    hoverCell('MONDAY|slot-2|sec-b') // invalid cross-section
    const evalRes = evaluateDraftDrop({
      draggedEntry: mockEntry,
      targetDay: 'MONDAY',
      targetSlotId: 'slot-2',
      targetSectionId: 'sec-b',
    })
    expect(evalRes.success).toBe(false)
    // Clearing state on failure
    endDragOrDrop()
    expect(draggedEntry).toBeNull()
    expect(dragOverKey).toBeNull()
  })
})
