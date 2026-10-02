/**
 * Timetable entry service.
 *
 * The Master Timetable UI goes through this module for every write so that:
 *  - `academicYearId` can never be forgotten (it once was — the INSERT failed
 *    with `NOT NULL constraint failed: timetable_entries.academic_year_id`
 *    and the error was invisible to the user),
 *  - hard constraints (break periods, required fields, span/duration, slot
 *    existence) are enforced in one place,
 *  - conflicts are detected SPAN-AWARE across the whole teaching team and the
 *    entry's rooms, and reported as messages a coordinator can act on
 *    ("Mrs. Kohila is already teaching III BCA-A from 09:00–11:00.") — never
 *    raw SQL errors,
 *  - validation rules are chosen per ACTIVITY TYPE: teaching activities
 *    (lecture/lab) require at least one faculty; library/mentoring/tutorial/
 *    skill-build/COE may legitimately have none. Room is always optional —
 *    "Not specified" is a valid state (we never invent rooms).
 *
 * Errors thrown here are user-facing; technical detail is logged for the
 * developer console.
 */
import { timetableEntryRepository } from '@/db/repositories/timetableEntry'
import { timeSlotRepository } from '@/db/repositories/timeSlot'
import { facultyRepository } from '@/db/repositories/faculty'
import { sectionRepository } from '@/db/repositories/section'
import { subjectRepository } from '@/db/repositories/subject'
import { auditLogRepository, AUDIT_ACTIONS } from '@/db/repositories/auditLog'
import {
  CLASS_TYPES,
  FACULTY_REQUIRED_CLASS_TYPES,
} from '@/types'
import type {
  DayOfWeek,
  ClassType,
  TimetableEntry,
  TimetableEntryWithRelations,
  TimeSlot,
  Section,
  Subject,
  Faculty,
  Room,
} from '@/types'

export interface TimetableEntryInput {
  dayOfWeek: DayOfWeek
  timeSlotId: string
  sectionId: string
  subjectId: string
  /** Teaching team — empty only for faculty-less activity types. */
  facultyIds: string[]
  /** Rooms — empty means "Not specified". */
  roomIds: string[]
  classType: ClassType
  /** Number of consecutive periods (1 = single period, 2 = 09:00–11:00 …). */
  span: number
}

/** One conflict found by `detectConflicts` — renderable in a dialog. */
export interface TimetableConflict {
  kind: 'section' | 'faculty' | 'room'
  /** Coordinator-readable description of the clash. */
  message: string
  /** The conflicting entry (so the UI can offer keep/replace decisions). */
  entryId: string
  conflictingEntry?: TimetableEntryWithRelations
}

/**
 * Thrown when a save would double-book something. The UI catches this type
 * and opens the conflict-resolution dialog (keep existing / replace existing)
 * instead of showing a generic error — nothing is ever overwritten silently.
 */
export class TimetableConflictError extends Error {
  readonly conflicts: TimetableConflict[]
  constructor(conflicts: TimetableConflict[]) {
    super(conflicts.map(c => c.message).join('\n'))
    this.name = 'TimetableConflictError'
    this.conflicts = conflicts
  }
}

/** Translate a driver/SQLite error into a user-facing message. */
function toFriendlyError(error: unknown, fallback: string): Error {
  const raw = error instanceof Error ? error.message : String(error)
  console.error('[timetable service]', raw)
  if (error instanceof Error && !/constraint|SQLITE|database/i.test(raw)) {
    return error // already a friendly domain error
  }
  if (/UNIQUE constraint failed/i.test(raw)) {
    return new Error(
      'That period is already assigned to another section for this activity.'
    )
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

// ---------------------------------------------------------------------------
// Span (duration) helpers
// ---------------------------------------------------------------------------

type CoveredSlotsResult = { slots: TimeSlot[] } | { error: string }

/**
 * Resolve the consecutive periods an activity occupies, starting at
 * `startSlotId` and running for `span` periods. Fails when the range would
 * run past the end of the day or across the break — a lab is ONE continuous
 * activity, never two unrelated classes split by the break.
 */
export function resolveCoveredSlots(startSlotId: string, span: number): CoveredSlotsResult {
  const ordered = timeSlotRepository.getOrdered()
  const startIdx = ordered.findIndex(s => s.id === startSlotId)
  if (startIdx === -1) return { error: 'The selected time period no longer exists.' }

  const start = ordered[startIdx]
  if (span <= 1) return { slots: [start] }

  const covered: TimeSlot[] = [start]
  for (let i = 1; i < span; i++) {
    const next = ordered[startIdx + i]
    if (!next) {
      return {
        error: `A ${span}-period activity starting at ${start.startTime} would run past the last period of the day.`,
      }
    }
    if (next.isBreak) {
      return {
        error: `A ${span}-period activity starting at ${start.startTime} would run across the break (${next.startTime}–${next.endTime}). Choose a shorter duration or a different period.`,
      }
    }
    covered.push(next)
  }
  return { slots: covered }
}

/**
 * Periods covered by an existing entry (start period + `span - 1` following
 * periods). Used by the substitution engine so a substitute is reserved for
 * the WHOLE activity — never just its first hour.
 *
 * Falls back to the start period when the entry's period is unknown so the
 * engine can never crash on legacy data.
 */
export function coveredSlotsOf(
  entry: { timeSlotId: string; span?: number },
  orderedSlots: TimeSlot[]
): TimeSlot[] {
  const startIdx = orderedSlots.findIndex(s => s.id === entry.timeSlotId)
  if (startIdx === -1) return []
  const span = Math.max(1, entry.span ?? 1)
  const out: TimeSlot[] = []
  for (let i = 0; i < span; i++) {
    const slot = orderedSlots[startIdx + i]
    if (!slot || slot.isBreak) break
    out.push(slot)
  }
  return out.length > 0 ? out : [orderedSlots[startIdx]]
}

/** `09:00–11:00` for a span, `09:00–10:00` for a single period. */
export function timeRangeLabel(startSlotId: string, span: number, orderedSlots?: TimeSlot[]): string {
  const ordered = orderedSlots ?? timeSlotRepository.getOrdered()
  const result = resolveCoveredSlots(startSlotId, Math.max(1, span))
  if ('error' in result) {
    const start = ordered.find(s => s.id === startSlotId)
    return start ? `${start.startTime}–${start.endTime}` : startSlotId
  }
  const first = result.slots[0]
  const last = result.slots[result.slots.length - 1]
  return `${first.startTime}–${last.endTime}`
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export interface ValidationOptions {
  /**
   * Skip the faculty↔subject pairing check. Set by `updateTimetableEntry`
   * when an existing entry's teaching team and subject are both unchanged, so
   * legacy entries whose mapping was later removed remain editable (a NEW
   * or re-picked combination is always checked).
   */
  skipPairingCheck?: boolean
}

function sameIdSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false
  const sortedA = [...a].sort()
  const sortedB = [...b].sort()
  return sortedA.every((v, i) => v === sortedB[i])
}

/** Returns a list of problems; empty means the input is valid. */
export function validateTimetableEntryInput(
  input: TimetableEntryInput,
  options: ValidationOptions = {}
): string[] {
  const errors: string[] = []
  const facultyIds = input.facultyIds ?? []
  const roomIds = input.roomIds ?? []
  const span = input.span ?? 1

  if (!input.dayOfWeek) errors.push('Day is required.')

  if (!input.timeSlotId) {
    errors.push('Time period is required.')
  } else {
    const slot = timeSlotRepository.findById(input.timeSlotId)
    if (!slot) {
      errors.push('The selected time period no longer exists.')
    } else if (slot.isBreak) {
      errors.push('No class or substitution can be scheduled during the break.')
    } else {
      const covered = resolveCoveredSlots(input.timeSlotId, span)
      if ('error' in covered) errors.push(covered.error)
    }
  }

  if (!Number.isInteger(span) || span < 1) {
    errors.push('Duration must be a whole number of periods (at least 1).')
  }

  if (!input.sectionId) errors.push('Section is required.')
  if (!input.subjectId) errors.push('Subject is required.')

  if (!input.classType) {
    errors.push('Class type is required.')
  } else if (!CLASS_TYPES.some(t => t.value === input.classType)) {
    errors.push('Unknown activity type.')
  }

  // Faculty rules are per activity type: teaching activities need at least
  // one faculty member; faculty-less activities (library, mentoring, …) are
  // valid with none. Validation is never weakened for teaching activities.
  if (FACULTY_REQUIRED_CLASS_TYPES.includes(input.classType) && facultyIds.length === 0) {
    errors.push(
      input.classType === 'LAB'
        ? 'At least one faculty member is required for a lab.'
        : 'Faculty is required.'
    )
  }
  if (new Set(facultyIds).size !== facultyIds.length) {
    errors.push('Each faculty member can only be added once.')
  }
  if (new Set(roomIds).size !== roomIds.length) {
    errors.push('Each room can only be added once.')
  }

  // Faculty↔subject pairing: EVERY member of the teaching team must be
  // linked to the subject (the same rule the dropdowns enforce).
  if (!options.skipPairingCheck) {
    for (const facultyId of facultyIds) {
      if (!input.subjectId) break
      if (!facultyRepository.isQualifiedForSubject(facultyId, input.subjectId)) {
        const facultyName = facultyRepository.findById(facultyId)?.name || 'This faculty member'
        const hasAny = facultyRepository.getSubjects(facultyId).length > 0
        errors.push(
          hasAny
            ? `${facultyName} is not assigned to the selected subject. Choose one of their linked subjects (or link this subject on the Faculty page).`
            : `${facultyName} has no subjects assigned. Link subjects on the Faculty page before adding timetable entries.`
        )
      }
    }
  }

  return errors
}

function assertValid(input: TimetableEntryInput, options: ValidationOptions = {}): void {
  const errors = validateTimetableEntryInput(input, options)
  if (errors.length > 0) throw new Error(errors.join('\n'))
}

// ---------------------------------------------------------------------------
// Span-aware conflict detection
// ---------------------------------------------------------------------------

function describeRange(
  ordered: TimeSlot[],
  startIdx: number,
  span: number
): string {
  const clamp = (i: number) => Math.min(Math.max(0, i), ordered.length - 1)
  const start = ordered[clamp(startIdx)]
  const end = ordered[clamp(startIdx + Math.max(1, span) - 1)]
  if (!start || !end) return 'an overlapping period'
  return `${start.startTime}–${end.endTime}`
}

function joinNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? ''
  if (names.length === 2) return `${names[0]} and ${names[1]}`
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
}

/**
 * Find every clash the input would cause, span-aware in BOTH directions
 * (an existing 09:00 span-3 activity also conflicts with a new 10:00 entry).
 * Returns structured conflicts so the UI can drive the keep/replace dialog.
 */
export function detectConflicts(
  input: TimetableEntryInput,
  academicYearId: string,
  excludeId?: string
): TimetableConflict[] {
  const ordered = timeSlotRepository.getOrdered()
  const orderById = new Map(ordered.map(s => [s.id, s.order]))
  // `order` is 1-based (Settings can renumber) while `ordered` is a sorted
  // array — describeRange must index by ARRAY POSITION, never by order, or
  // every message reads one period late (and a last-period clash reads past
  // the end of the array).
  const positionById = new Map(ordered.map((s, i) => [s.id, i]))
  const startOrder = orderById.get(input.timeSlotId)
  if (startOrder === undefined) return []
  const endOrder = startOrder + Math.max(1, input.span) - 1

  const conflicts: TimetableConflict[] = []
  const dayEntries = timetableEntryRepository.getWithRelationsForDay(
    academicYearId,
    input.dayOfWeek
  )

  for (const other of dayEntries) {
    if (other.id === excludeId) continue
    const otherStartIdx = orderById.get(other.timeSlotId)
    if (otherStartIdx === undefined) continue
    const otherEndIdx = otherStartIdx + other.span - 1
    const overlaps = otherStartIdx <= endOrder && startOrder <= otherEndIdx
    if (!overlaps) continue

    const otherPos = positionById.get(other.timeSlotId)
    if (otherPos === undefined) continue
    const range = describeRange(ordered, otherPos, other.span)
    const className = other.section?.name ?? 'another class'
    const activity = other.subject?.name ?? 'an activity'

    // Same class already has something in this period → that alone is the
    // conflict; faculty/room details would only add noise.
    if (other.sectionId === input.sectionId) {
      conflicts.push({
        kind: 'section',
        entryId: other.id,
        conflictingEntry: other,
        message: `${className} already has “${activity}” from ${range}.`,
      })
      continue
    }

    const sharedFaculty = input.facultyIds.filter(f => other.facultyIds.includes(f))
    if (sharedFaculty.length > 0) {
      const names = sharedFaculty.map(
        id => other.facultyList?.find(f => f.id === id)?.name ?? facultyRepository.findById(id)?.name ?? 'A faculty member'
      )
      conflicts.push({
        kind: 'faculty',
        entryId: other.id,
        conflictingEntry: other,
        message: `${joinNames(names)} ${names.length > 1 ? 'are' : 'is'} already teaching ${className} from ${range}.`,
      })
    }

    const sharedRooms = input.roomIds.filter(r => other.roomIds.includes(r))
    if (sharedRooms.length > 0) {
      const names = sharedRooms.map(
        id => other.roomList?.find(r => r.id === id)?.name ?? 'A room'
      )
      conflicts.push({
        kind: 'room',
        entryId: other.id,
        conflictingEntry: other,
        message: `${joinNames(names)} ${names.length > 1 ? 'are' : 'is'} already booked by ${className} (“${activity}”) from ${range}.`,
      })
    }
  }

  return conflicts
}

function assertNoConflicts(
  input: TimetableEntryInput,
  academicYearId: string,
  excludeId?: string
): void {
  const conflicts = detectConflicts(input, academicYearId, excludeId)
  if (conflicts.length > 0) throw new TimetableConflictError(conflicts)
}

// ---------------------------------------------------------------------------
// CRUD (with audit trail)
// ---------------------------------------------------------------------------

function auditDetail(input: TimetableEntryInput): string {
  try {
    const section = sectionRepository.findById(input.sectionId)?.name ?? 'Unknown class'
    const subject = subjectRepository.findById(input.subjectId)?.name ?? 'Unknown activity'
    const range = timeRangeLabel(input.timeSlotId, input.span)
    const team =
      input.facultyIds.length > 0
        ? input.facultyIds
            .map(id => facultyRepository.findById(id)?.name ?? 'Faculty')
            .join(', ')
        : 'No faculty'
    const suffix = input.span > 1 ? ` · ${input.span} periods` : ''
    return `${input.dayOfWeek} ${range} · ${section} · ${subject} · ${team}${suffix}`
  } catch {
    return input.dayOfWeek
  }
}

export function createTimetableEntry(
  input: TimetableEntryInput,
  academicYearId: string
): TimetableEntry {
  assertValid(input)
  assertNoConflicts(input, academicYearId)
  try {
    const created = timetableEntryRepository.create({
      id: crypto.randomUUID(),
      academicYearId,
      ...input,
    })
    auditLogRepository.record(
      AUDIT_ACTIONS.TIMETABLE_CREATED,
      'timetable_entry',
      created.id,
      auditDetail(input)
    )
    return created
  } catch (error) {
    throw toFriendlyError(error, 'Could not save the timetable entry. Please try again.')
  }
}

export function updateTimetableEntry(id: string, input: TimetableEntryInput): TimetableEntry {
  const existing = timetableEntryRepository.findById(id)
  if (!existing) throw new Error('This timetable entry no longer exists. Reload the page.')
  // If the teaching team and subject are both unchanged, this entry predates
  // (or already passed) the pairing rule — never trap the coordinator; only a
  // re-picked combination must satisfy the mapping.
  const pairingUnchanged =
    sameIdSet(existing.facultyIds, input.facultyIds) && existing.subjectId === input.subjectId
  assertValid(input, { skipPairingCheck: pairingUnchanged })
  assertNoConflicts(input, existing.academicYearId, id)
  try {
    const updated = timetableEntryRepository.update(id, input)
    if (!updated) throw new Error('This timetable entry no longer exists. Reload the page.')
    auditLogRepository.record(
      AUDIT_ACTIONS.TIMETABLE_UPDATED,
      'timetable_entry',
      id,
      auditDetail(input)
    )
    return updated
  } catch (error) {
    throw toFriendlyError(error, 'Could not update the timetable entry. Please try again.')
  }
}

export function deleteTimetableEntry(id: string): void {
  try {
    const existing = timetableEntryRepository.findById(id)
    const removed = timetableEntryRepository.delete(id)
    if (!removed) throw new Error('This timetable entry no longer exists. Reload the page.')
    if (existing) {
      auditLogRepository.record(
        AUDIT_ACTIONS.TIMETABLE_DELETED,
        'timetable_entry',
        id,
        auditDetail({
          dayOfWeek: existing.dayOfWeek,
          timeSlotId: existing.timeSlotId,
          sectionId: existing.sectionId,
          subjectId: existing.subjectId,
          facultyIds: existing.facultyIds,
          roomIds: existing.roomIds,
          classType: existing.classType,
          span: existing.span,
        })
      )
    }
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
  facultyIds: string[]
  subjectId: string
  roomIds: string[]
  classType?: ClassType
  span?: number
}): TimetableEntryInput {
  return {
    dayOfWeek: params.context.dayOfWeek,
    timeSlotId: params.context.timeSlotId,
    sectionId: params.sectionId,
    subjectId: params.subjectId,
    facultyIds: params.facultyIds,
    roomIds: params.roomIds,
    classType: params.classType ?? 'LECTURE',
    span: params.span ?? 1,
  }
}

/**
 * First room (in list order) that is not already booked at the given
 * day/period — the sensible default for quick entry, so saving works without
 * the coordinator thinking about rooms. Span-aware when `allSlots` is given.
 */
export function findFreeRoomId(params: {
  day: DayOfWeek
  timeSlotId: string
  entries: TimetableEntryWithRelations[]
  rooms: Room[]
  excludeEntryId?: string
  allSlots?: TimeSlot[]
}): string {
  const orderById = new Map((params.allSlots ?? []).map(s => [s.id, s.order]))
  const ourOrder = orderById.get(params.timeSlotId)

  const booked = new Set<string>()
  for (const e of params.entries) {
    if (e.dayOfWeek !== params.day || e.id === params.excludeEntryId) continue
    let overlaps = e.timeSlotId === params.timeSlotId
    if (!overlaps && ourOrder !== undefined && e.timeSlot) {
      const from = e.timeSlot.order
      const to = from + Math.max(1, e.span) - 1
      overlaps = from <= ourOrder && ourOrder <= to
    }
    if (overlaps) for (const roomId of e.roomIds) booked.add(roomId)
  }
  const free = params.rooms.find(r => !booked.has(r.id))
  return (free ?? params.rooms[0])?.id ?? ''
}

/**
 * Initial Time Slot / Section / Room for the full "Add Entry" dialog
 * (QA-012).
 *
 * Those three selects render without a placeholder option, so the browser
 * displays their FIRST option. The form state must be initialized to exactly
 * those values — otherwise the dialog shows a concrete period/class/room while
 * the state is `''`, and saving fails with "Time period / Section is required"
 * for values the coordinator can see on screen.
 *
 * `selectedSectionId` (the grid's class filter) wins over the first section,
 * matching what the dialog displays when a class context is active.
 * DISPLAYED VALUE === FORM STATE === SUBMITTED VALUE by construction: the
 * same arrays are passed to the dialog's option lists.
 */
export function buildAddEntryDefaults(params: {
  selectedSectionId?: string
  teachingSlots: TimeSlot[]
  sections: Section[]
  rooms: Room[]
}): { timeSlotId: string; sectionId: string; roomId: string } {
  return {
    timeSlotId: params.teachingSlots[0]?.id ?? '',
    sectionId: params.selectedSectionId || params.sections[0]?.id || '',
    roomId: params.rooms[0]?.id ?? '',
  }
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

/**
 * Subjects EVERY member of the teaching team is qualified for — the team's
 * subject dropdown. Empty team → all subjects (subject-first workflows).
 */
export function subjectsForTeam(facultyIds: string[], allSubjects: Subject[]): Subject[] {
  if (facultyIds.length === 0) return allSubjects
  const perMember = facultyIds.map(
    fid => new Set(facultyRepository.getSubjects(fid).map(fs => fs.subjectId))
  )
  return allSubjects.filter(s => perMember.every(set => set.has(s.id)))
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

/**
 * Team variant: when the teaching team changes, the subject is cleared unless
 * EVERY current member is qualified for it.
 */
export function reconcileTeamChange(
  facultyIds: string[],
  subjectId: string
): { subjectId: string; cleared: boolean } {
  if (facultyIds.length > 0 && subjectId) {
    const allQualified = facultyIds.every(fid =>
      facultyRepository.isQualifiedForSubject(fid, subjectId)
    )
    if (!allQualified) return { subjectId: '', cleared: true }
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
