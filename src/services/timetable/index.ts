/**
 * Timetable entry service.
 *
 * The Master Timetable UI goes through this module for every write so that:
 *  - `academicYearId` can never be forgotten (it once was — the INSERT failed
 *    with `NOT NULL constraint failed: timetable_entries.academic_year_id`
 *    and the error was invisible to the user),
 *  - hard constraints (break periods, required fields, slot existence) are
 *    enforced in one place,
 *  - SQLite errors are translated into messages a coordinator can act on.
 *
 * Errors thrown here are user-facing; technical detail is logged for the
 * developer console.
 */
import { timetableEntryRepository } from '@/db/repositories/timetableEntry'
import { timeSlotRepository } from '@/db/repositories/timeSlot'
import { facultyRepository } from '@/db/repositories/faculty'
import type {
  DayOfWeek,
  ClassType,
  TimetableEntry,
  TimetableEntryWithRelations,
  TimeSlot,
  Subject,
  Faculty,
  Room,
} from '@/types'

export interface TimetableEntryInput {
  dayOfWeek: DayOfWeek
  timeSlotId: string
  sectionId: string
  subjectId: string
  facultyId: string
  roomId: string
  classType: ClassType
}

/** Translate a driver/SQLite error into a user-facing message. */
function toFriendlyError(error: unknown, fallback: string): Error {
  const raw = error instanceof Error ? error.message : String(error)
  console.error('[timetable service]', raw)
  if (error instanceof Error && !/constraint|SQLITE|database/i.test(raw)) {
    return error // already a friendly domain error
  }
  if (/UNIQUE constraint failed/i.test(raw)) {
    return new Error('That period is already assigned to another section, faculty, or room.')
  }
  if (/FOREIGN KEY constraint failed/i.test(raw)) {
    return new Error('One of the selected items no longer exists. Refresh the page and try again.')
  }
  if (/NOT NULL constraint failed/i.test(raw)) {
    return new Error('Please fill in all required fields.')
  }
  return new Error(fallback)
}

/** Shown in the Subject dropdown when the selected faculty has no mappings. */
export const NO_SUBJECTS_FOR_FACULTY = 'No subjects assigned to this faculty.'
/** Shown in the Faculty dropdown when the selected subject has no mappings. */
export const NO_FACULTY_FOR_SUBJECT = 'No faculty are qualified for this subject.'

export interface ValidationOptions {
  /**
   * Skip the faculty↔subject pairing check. Set by `updateTimetableEntry`
   * when an existing entry's faculty and subject are both unchanged, so
   * legacy entries whose mapping was later removed remain editable (a NEW
   * or re-picked combination is always checked).
   */
  skipPairingCheck?: boolean
}

/** Returns a list of problems; empty means the input is valid. */
export function validateTimetableEntryInput(
  input: TimetableEntryInput,
  options: ValidationOptions = {}
): string[] {
  const errors: string[] = []
  if (!input.dayOfWeek) errors.push('Day is required.')
  if (!input.timeSlotId) {
    errors.push('Time period is required.')
  } else {
    const slot = timeSlotRepository.findById(input.timeSlotId)
    if (!slot) {
      errors.push('The selected time period no longer exists.')
    } else if (slot.isBreak) {
      errors.push('No class or substitution can be scheduled during the break.')
    }
  }
  if (!input.sectionId) errors.push('Section is required.')
  if (!input.subjectId) errors.push('Subject is required.')
  if (!input.facultyId) errors.push('Faculty is required.')
  if (!input.roomId) errors.push('Room is required.')
  if (!input.classType) errors.push('Class type is required.')

  // Faculty↔subject pairing: an entry can only ever be saved for a subject
  // the faculty member is linked to (the same rule the dropdowns enforce).
  if (!options.skipPairingCheck && input.facultyId && input.subjectId) {
    if (!facultyRepository.isQualifiedForSubject(input.facultyId, input.subjectId)) {
      const facultyName = facultyRepository.findById(input.facultyId)?.name || 'This faculty member'
      const hasAny = facultyRepository.getSubjects(input.facultyId).length > 0
      errors.push(
        hasAny
          ? `${facultyName} is not assigned to the selected subject. Choose one of their linked subjects (or link this subject on the Faculty page).`
          : `${facultyName} has no subjects assigned. Link subjects on the Faculty page before adding timetable entries.`
      )
    }
  }
  return errors
}

function assertValid(input: TimetableEntryInput, options: ValidationOptions = {}): void {
  const errors = validateTimetableEntryInput(input, options)
  if (errors.length > 0) throw new Error(errors.join('\n'))
}

function assertNoConflicts(input: TimetableEntryInput, academicYearId: string, excludeId?: string): void {
  const conflicts = timetableEntryRepository.checkConflicts({ ...input, academicYearId }, excludeId)
  if (conflicts.length > 0) throw new Error(conflicts.join('\n'))
}

export function createTimetableEntry(
  input: TimetableEntryInput,
  academicYearId: string
): TimetableEntry {
  assertValid(input)
  assertNoConflicts(input, academicYearId)
  try {
    return timetableEntryRepository.create({
      id: crypto.randomUUID(),
      academicYearId,
      ...input,
    })
  } catch (error) {
    throw toFriendlyError(error, 'Could not save the timetable entry. Please try again.')
  }
}

export function updateTimetableEntry(id: string, input: TimetableEntryInput): TimetableEntry {
  const existing = timetableEntryRepository.findById(id)
  if (!existing) throw new Error('This timetable entry no longer exists. Reload the page.')
  // If faculty and subject are both unchanged, this entry predates (or already
  // passed) the pairing rule — never trap the coordinator; only a re-picked
  // combination must satisfy the mapping.
  const pairingUnchanged =
    existing.facultyId === input.facultyId && existing.subjectId === input.subjectId
  assertValid(input, { skipPairingCheck: pairingUnchanged })
  assertNoConflicts(input, existing.academicYearId, id)
  try {
    const updated = timetableEntryRepository.update(id, input)
    if (!updated) throw new Error('This timetable entry no longer exists. Reload the page.')
    return updated
  } catch (error) {
    throw toFriendlyError(error, 'Could not update the timetable entry. Please try again.')
  }
}

export function deleteTimetableEntry(id: string): void {
  try {
    const removed = timetableEntryRepository.delete(id)
    if (!removed) throw new Error('This timetable entry no longer exists. Reload the page.')
  } catch (error) {
    throw toFriendlyError(error, 'Could not delete the timetable entry. Please try again.')
  }
}

// ---------------------------------------------------------------------------
// Context-aware quick entry (clicking an empty timetable cell)
// ---------------------------------------------------------------------------

export interface QuickEntryContext {
  dayOfWeek: DayOfWeek
  timeSlotId: string
  /** Section inherited from the page filter; null when unknown (must be asked). */
  sectionId: string | null
}

export type CellAction =
  | { kind: 'break' }
  | { kind: 'edit'; entry: TimetableEntryWithRelations }
  | { kind: 'quick'; context: QuickEntryContext }

/**
 * Decide what happens when a grid cell is clicked. The cell already knows its
 * day, period and (when a class filter is active) its section — those values
 * are carried into the quick-entry dialog as read-only context so the
 * coordinator never re-selects them.
 */
export function resolveCellAction(params: {
  day: DayOfWeek
  slot: TimeSlot
  existingEntry: TimetableEntryWithRelations | null
  sectionFilterId?: string
}): CellAction {
  if (params.slot.isBreak) return { kind: 'break' }
  if (params.existingEntry) return { kind: 'edit', entry: params.existingEntry }
  return {
    kind: 'quick',
    context: {
      dayOfWeek: params.day,
      timeSlotId: params.slot.id,
      sectionId: params.sectionFilterId || null,
    },
  }
}

/**
 * Build the save payload for a quick entry. Day, time slot and (when known)
 * section come from the cell context — the dialog never re-collects them.
 */
export function buildQuickEntryInput(params: {
  context: QuickEntryContext
  sectionId: string
  facultyId: string
  subjectId: string
  roomId: string
  classType?: ClassType
}): TimetableEntryInput {
  return {
    dayOfWeek: params.context.dayOfWeek,
    timeSlotId: params.context.timeSlotId,
    sectionId: params.sectionId,
    subjectId: params.subjectId,
    facultyId: params.facultyId,
    roomId: params.roomId,
    classType: params.classType ?? 'LECTURE',
  }
}

/**
 * First room (in list order) that is not already booked at the given
 * day/period — the sensible default for quick entry, so saving works without
 * the coordinator thinking about rooms.
 */
export function findFreeRoomId(params: {
  day: DayOfWeek
  timeSlotId: string
  entries: TimetableEntryWithRelations[]
  rooms: Room[]
  excludeEntryId?: string
}): string {
  const booked = new Set(
    params.entries
      .filter(
        e =>
          e.dayOfWeek === params.day &&
          e.timeSlotId === params.timeSlotId &&
          e.id !== params.excludeEntryId
      )
      .map(e => e.roomId)
  )
  const free = params.rooms.find(r => !booked.has(r.id))
  return (free ?? params.rooms[0])?.id ?? ''
}

// ---------------------------------------------------------------------------
// Faculty ↔ subject dropdown filtering
// ---------------------------------------------------------------------------

/** Subjects the given faculty is linked to teach (all subjects when unset). */
export function subjectsForFaculty(facultyId: string, allSubjects: Subject[]): Subject[] {
  if (!facultyId) return allSubjects
  const linked = new Set(facultyRepository.getSubjects(facultyId).map(fs => fs.subjectId))
  return allSubjects.filter(s => linked.has(s.id))
}

/** Faculty linked to the given subject (all active faculty when unset). */
export function facultyForSubject(subjectId: string, allFaculty: Faculty[]): Faculty[] {
  if (!subjectId) return allFaculty
  const qualified = new Set(facultyRepository.getFacultyForSubject(subjectId).map(f => f.id))
  return allFaculty.filter(f => qualified.has(f.id))
}

/**
 * Revalidate after the faculty dropdown changed: a selected subject that the
 * new faculty member is not linked to is cleared (a new valid selection is
 * then required — an invalid combination can never be saved).
 */
export function reconcileFacultyChange(
  facultyId: string,
  subjectId: string
): { subjectId: string; cleared: boolean } {
  if (facultyId && subjectId && !facultyRepository.isQualifiedForSubject(facultyId, subjectId)) {
    return { subjectId: '', cleared: true }
  }
  return { subjectId, cleared: false }
}

/** Mirror of `reconcileFacultyChange` for subject-first selection. */
export function reconcileSubjectChange(
  facultyId: string,
  subjectId: string
): { facultyId: string; cleared: boolean } {
  if (facultyId && subjectId && !facultyRepository.isQualifiedForSubject(facultyId, subjectId)) {
    return { facultyId: '', cleared: true }
  }
  return { facultyId, cleared: false }
}
