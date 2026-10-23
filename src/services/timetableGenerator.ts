/**
 * Automatic Timetable Generation Engine
 * =====================================
 *
 * Deterministic constraint solver that turns Teaching Allocations ("who
 * teaches what") + Subject Requirements ("how often per week") into a
 * conflict-free DRAFT master timetable. It never writes to `timetable_entries`
 * (the published timetable) — that only happens in `publishDraftTimetable`,
 * inside a single transaction, after a full independent re-validation.
 *
 * Algorithm
 * --------
 * 1. Load configuration from the local SQLite database (periods, breaks,
 *    working days/hours, sections, faculty, rooms, allocations, requirements).
 * 2. Validate inputs structurally BEFORE searching (missing allocations,
 *    impossible spans, section/faculty capacity overloads). Fail fast with
 *    actionable diagnostics instead of burning the search budget.
 * 3. Expand every Subject Requirement into `requiredSessionsPerWeek`
 *    scheduling units ("tasks"), each occupying `span` CONTIGUOUS periods.
 * 4. Search: recursive backtracking with
 *      - MRV / most-constrained-first selection (fewest legal placements),
 *        ties broken by a static difficulty score (multi-faculty team,
 *      span ≥ 2, labs, fewer eligible faculty/rooms first),
 *      - forward checking (every unassigned task's domain is recomputed on
 *        each node; an empty domain prunes the branch immediately),
 *      - bounded effort: `max_generation_attempts` placements and
 *        `generation_timeout_ms` wall-clock (both app settings).
 * 5. Candidates are ranked by a documented SOFT scoring function. Scores only
 *    order candidates — they can never make an illegal placement legal.
 * 6. On success the solution is persisted as draft entries (entry + ordered
 *    faculty team + rooms) and the generation is COMPLETED. On failure the
 *    generation is FAILED with per-activity diagnostics (section/subject/
 *    requirement, attempted scope, reason, suggested action) plus search
 *    statistics. A failure writes nothing to the published timetable.
 *
 * Hard constraints (never violated)
 * ---------------------------------
 * - Only configured working days and teaching periods (breaks excluded).
 * - A section occupies exactly one activity per period (span aware).
 * - Every faculty member of the teaching team is free for the WHOLE span.
 * - A room, when assigned, is free for the whole span.
 * - A session's span never crosses the lunch break or the end of the day.
 * - Every session is backed by a real Teaching Allocation and an active
 *   faculty member; labs use lab rooms when the college has any.
 * - The exact weekly counts of every Subject Requirement are scheduled —
 *   a partial timetable is reported as FAILURE, never as success.
 *
 * Soft scoring (documented, weights in SOFT_WEIGHTS)
 * --------------------------------------------------
 * - spreading: prefer days where the subject has not been used yet, and
 *   lighter days for the section (disabled when `prefer_spread` is false).
 * - time-of-day balance: prefer the teaching period (09:00–10:00 … 15:00–16:00,
 *   break excluded) in which the section has the least load so far, so a
 *   section's week spreads across the whole configured day instead of piling
 *   into the earliest free periods and leaving every afternoon empty.
 * - faculty day balance: prefer days on which the assigned faculty member has
 *   the lightest load so one teacher is not stacked on a single day when an
 *   equally legal alternative exists.
 * - workload balance: prefer faculty below their allocated weekly target and
 *   faculty with a lower assigned load so far.
 * - gaps: prefer placements adjacent to the section's existing classes,
 *   bridge isolated single-period holes, and penalize isolated gaps so the
 *   section's day is contiguous.
 * - morning start: prefer starting at period 1 (09:00) when scheduling for a
 *   section day.
 * - lab placement: multi-period sessions prefer earlier positions in the day.
 * - room usage: prefer assigning an eligible room (type-appropriate) over
 *   leaving the room unspecified.
 *
 * Quality components never override a hard constraint: a candidate only
 * reaches the score function after it has passed every occupancy, span,
 * working-hours and allocation check, and the validator re-checks the final
 * timetable independently before it can be published.
 *
 * Determinism: no randomness anywhere. Candidates are totally ordered
 * (score, day, period, faculty rank, room rank) and ties in task selection
 * fall back to static difficulty then the task key, so the same database
 * always produces the same timetable.
 *
 * Optimality: the search proves feasibility or exhausts its configured
 * bounds. It does NOT prove a globally optimal (best-scoring) timetable —
 * the score is a documented heuristic used for ordering only.
 */

import { getDatabase } from '@/db/database'
import { withTransaction } from '@/db/transaction'
import {
  academicYearRepository,
  auditLogRepository,
  AUDIT_ACTIONS,
  draftTimetableEntryRepository,
  facultyRepository,
  generationDiagnosticRepository,
  roomRepository,
  sectionRepository,
  settingsRepository,
  subjectRepository,
  subjectRequirementRepository,
  teachingAllocationRepository,
  timeSlotRepository,
  timetableEntryRepository,
  timetableGenerationRepository,
} from '@/db/repositories'
import { resolveCoveredSlots } from '@/services/timetable'
import type {
  ClassType,
  DayOfWeek,
  DraftTimetableEntryWithRelations,
  Faculty,
  GenerationConstraintsSnapshot,
  GenerationDiagnostic,
  GenerationResult,
  GenerationStatus,
  Room,
  Section,
  Subject,
  SubjectRequirement,
  TeachingAllocation,
  TimeSlot,
  TimetableGeneration,
} from '@/types'
import { FACULTY_REQUIRED_CLASS_TYPES, GenerationDiagnosticCode } from '@/types'

// ---------------------------------------------------------------------------
// Soft-constraint weights (documented — see module header)
// ---------------------------------------------------------------------------

const SOFT_WEIGHTS = {
  /** First use of this subject for this section on this day. */
  spreadNewDay: 20,
  /** Penalty per additional same-day repeat of the same subject. */
  sameDayRepeat: -50,
  /** Per period of head-room this day has vs. the section's busiest day. */
  dayBalance: 8,
  /**
   * Per period of head-room the window's teaching period has vs. the
   * section's busiest teaching period (break excluded). This is what keeps
   * a section's week spread over the WHOLE configured day — without it every
   * tie resolves to the earliest free period and the afternoons stay empty.
   */
  periodBalance: 20,
  /** Bonus for placing a class at the first period of the day (09:00). */
  morningStart: 25,
  /**
   * Per period of head-room this day has vs. that faculty member's busiest
   * day — avoids stacking one teacher's weekly load onto a single day.
   */
  facultyDayBalance: 5,
  /** Per session a faculty member is below their allocated weekly target. */
  facultyTargetDeficit: 10,
  /** Per period already taught by that faculty member (workload leveling). */
  facultyLoad: -2,
  /** Bonus when a placement sits directly before/after the section's class. */
  gapFilling: 15,
  /** Bonus when a placement fills a slot between two occupied classes. */
  gapBridging: 30,
  /** Penalty when a placement creates an isolated 1-period hole on that section-day. */
  isolatedGapPenalty: -40,
  /** Per free period later in the day (pulls multi-period sessions earlier). */
  labEarlyInDay: 4,
  /** A room was assigned at all. */
  roomAssigned: 5,
  /** The assigned room matches the activity type (lab in a lab, etc.). */
  roomWellMatched: 3,
} as const

/** Cap on how many blocked-period explanations we persist per failed run. */
const MAX_FAILURE_DIAGNOSTICS = 20

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** One unit of work: a single weekly session of one requirement. */
interface SchedulingTask {
  /** Deterministic identity: section|subject|classType#sessionIndex. */
  key: string
  /** `sectionId|subjectId|classType` — shared by all sessions of a group. */
  baseKey: string
  /** 0-based session number within its requirement. */
  sessionIndex: number
  requirementId: string
  allocationIds: string[]
  sectionId: string
  sectionName: string
  subjectId: string
  subjectName: string
  subjectCode: string
  classType: ClassType
  span: number
  /** Eligible, active faculty in deterministic order (priority, name, id). */
  facultyPool: string[]
  /** Weekly target from each faculty's allocation row (soft scoring). */
  facultyTargets: Map<string, number>
  /** Rank of each pool member (stable candidate ordering). */
  facultyRank: Map<string, number>
  /** LAB with several faculty = one team teaching every session together. */
  mode: 'TEAM' | 'ALTERNATE'
  /** Eligible rooms (lab type for labs, non-lab type otherwise). */
  rooms: string[]
  roomRank: Map<string, number>
  /** A lab must get a room whenever the college has any lab room. */
  roomRequired: boolean
  /** Static MRV tie-break: higher = harder to place. */
  difficulty: number
}

/** A legal placement of one task (already checked against hard constraints). */
interface Placement {
  task: SchedulingTask
  day: DayOfWeek
  window: SolverWindow
  facultyIds: string[]
  roomId: string | null
  score: number
}

/** `span` contiguous teaching periods starting at `startIdx`. */
interface SolverWindow {
  startIdx: number
  endIdx: number
  slotIds: string[]
  /** Teaching ordinal of each covered slot (see SolverContext). */
  teachingOrdinals: number[]
  label: string
}

interface SolverContext {
  days: DayOfWeek[]
  orderedSlots: TimeSlot[]
  /** span -> every legal window in a single day (break-aware). */
  windows: Map<number, SolverWindow[]>
  /** Working-period index by slot id (for adjacency checks). */
  indexBySlotId: Map<string, number>
  /**
   * Ordinal (0-based) of each USABLE teaching period across the whole slot
   * list — e.g. 09:00→0, 10:00→1, … 14:00→4, 15:00→5 with a 13:00–14:00
   * break in between. Used by the time-of-day balance score.
   */
  teachingOrdinalBySlotId: Map<string, number>
  /** Number of usable teaching periods per working day. */
  teachingPeriodCount: number
  preferSpread: boolean
}

interface SolverState {
  sectionBusy: Map<string, Set<string>> // sectionId -> "day:slotId"
  facultyBusy: Map<string, Set<string>>
  roomBusy: Map<string, Set<string>>
  sectionDay: Map<string, number> // "sectionId|day" -> periods
  sectionSubjectDay: Map<string, number> // "sectionId|subjectId|day" -> sessions
  sectionPeriod: Map<string, number> // "sectionId|teachingOrdinal" -> periods
  facultyDay: Map<string, number> // "facultyId|day" -> periods
  facultyPeriods: Map<string, number>
  facultyGroupSessions: Map<string, number> // "facultyId|baseKey" -> sessions
  assigned: Placement[]
  assignedKeys: Set<string>
  attempts: number
}

interface BlockerTally {
  windows: number
  bySection: number
  byFaculty: number
  byRoom: number
}

interface DeadEnd {
  task: SchedulingTask
  structural: boolean
  branches: number
  tally: BlockerTally
}

interface SearchOutcome {
  success: boolean
  attempts: number
  stopReason: 'attempts' | 'timeout' | 'exhausted' | null
  deadEnds: Map<string, DeadEnd>
  best: Placement[]
}

export interface DraftValidationResult {
  generationId: string
  valid: boolean
  errors: string[]
  warnings: string[]
  entries: number
  requiredSessions: number
  scheduledSessions: number
  labsScheduled: number
  missing: {
    sectionName: string
    subjectName: string
    classType: string
    required: number
    scheduled: number
    span: number
  }[]
}

export interface PublishResult {
  generationId: string
  publishedEntries: number
  replacedEntries: number
  untouchedSections: number
  substitutionRecordsRemapped: number
  substitutionRecordsSuperseded: number
}

export interface GenerationStatusInfo {
  generation: TimetableGeneration
  draftEntries: number
  diagnostics: { errors: number; warnings: number; infos: number }
  published: boolean
}

type NewDiagnostic = Omit<GenerationDiagnostic, 'id' | 'createdAt'>

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function timeToMinutes(time: string): number {
  const [h, m] = time.split(':').map(Number)
  return (h || 0) * 60 + (m || 0)
}

function displayName(list: { id: string; name: string }[], ids: string[]): string {
  const names = ids.map((id) => list.find((x) => x.id === id)?.name ?? 'Unknown')
  if (names.length <= 1) return names[0] ?? ''
  if (names.length === 2) return `${names[0]} and ${names[1]}`
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
}

function newId(): string {
  return crypto.randomUUID()
}

/**
 * Generation runs that are genuinely executing in THIS process right now.
 * The solver is synchronous, so no other renderer code can run concurrently —
 * this set exists purely so recovery can never mistake an active run for a
 * stale one even if called re-entrantly (e.g. from a mid-run hook).
 */
const inFlightGenerations = new Set<string>()

/** Diagnostic factory — keeps `details` a JSON string with structured context. */
function diagnostic(
  severity: GenerationDiagnostic['severity'],
  code: GenerationDiagnosticCode,
  message: string,
  details: Record<string, unknown>,
  teachingAllocationId: string | null = null
): NewDiagnostic {
  return {
    generationId: '',
    teachingAllocationId,
    severity,
    code,
    message,
    details: JSON.stringify(details),
  }
}

// ---------------------------------------------------------------------------
// Data loading
// ---------------------------------------------------------------------------

interface LoadedData {
  academicYearId: string
  orderedSlots: TimeSlot[]
  /** Slots usable for teaching: not a break, inside configured working hours. */
  teachingSlots: TimeSlot[]
  days: DayOfWeek[]
  workingHours: { startTime: string; endTime: string; breakStart: string; breakEnd: string }
  sections: Section[]
  subjects: Subject[]
  faculty: Faculty[]
  rooms: Room[]
  allocations: TeachingAllocation[]
  requirements: SubjectRequirement[]
  maxAttempts: number
  timeoutMs: number
  preferSpread: boolean
}

function loadAllData(academicYearId: string): LoadedData {
  const hours = settingsRepository.getWorkingHours()
  const orderedSlots = timeSlotRepository.getOrdered()
  const startLimit = timeToMinutes(hours.startTime)
  const endLimit = timeToMinutes(hours.endTime)
  const breakStart = timeToMinutes(hours.breakStart)
  const breakEnd = timeToMinutes(hours.breakEnd)

  const isBreak = (slot: TimeSlot): boolean =>
    slot.isBreak ||
    (timeToMinutes(slot.startTime) < breakEnd && timeToMinutes(slot.endTime) > breakStart)

  const teachingSlots = orderedSlots.filter(
    (slot) =>
      !isBreak(slot) &&
      timeToMinutes(slot.startTime) >= startLimit &&
      timeToMinutes(slot.endTime) <= endLimit
  )

  return {
    academicYearId,
    orderedSlots,
    teachingSlots,
    days: settingsRepository.getWorkingDays(),
    workingHours: hours,
    sections: sectionRepository.findByAcademicYear(academicYearId).slice().sort(byId),
    subjects: subjectRepository.findAll().slice().sort(byId),
    faculty: facultyRepository.findActive().slice().sort(byPriorityThenName),
    rooms: roomRepository.findAll().slice().sort(byId),
    allocations: teachingAllocationRepository
      .findByAcademicYear(academicYearId)
      .slice()
      .sort(byId),
    requirements: subjectRequirementRepository
      .findByAcademicYear(academicYearId)
      .slice()
      .sort(byId),
    maxAttempts: settingsRepository.getMaxGenerationAttempts(),
    timeoutMs: settingsRepository.getGenerationTimeoutMs(),
    preferSpread: settingsRepository.getPreferSpread(),
  }
}

function byId(a: { id: string }, b: { id: string }): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

function byPriorityThenName(a: Faculty, b: Faculty): number {
  if (a.priority !== b.priority) return a.priority - b.priority
  if (a.name !== b.name) return a.name < b.name ? -1 : 1
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

function buildConstraintsSnapshot(data: LoadedData): GenerationConstraintsSnapshot {
  const maxDailySubstitutions: Record<string, number> = {}
  for (const f of data.faculty) maxDailySubstitutions[f.id] = f.maxDailySubstitutions
  return {
    timeSlots: data.orderedSlots,
    sections: data.sections,
    faculty: data.faculty,
    rooms: data.rooms,
    teachingAllocations: data.allocations,
    workingHours: { ...data.workingHours, slots: data.orderedSlots },
    multiFacultyAbsencePolicy: settingsRepository.getMultiFacultyAbsencePolicy(),
    maxDailySubstitutions,
  }
}

// ---------------------------------------------------------------------------
// Context: legal windows (span, break and working-hours aware)
// ---------------------------------------------------------------------------

function buildContext(data: LoadedData): SolverContext {
  const hours = data.workingHours
  const startLimit = timeToMinutes(hours.startTime)
  const endLimit = timeToMinutes(hours.endTime)
  const breakStart = timeToMinutes(hours.breakStart)
  const breakEnd = timeToMinutes(hours.breakEnd)
  const slots = data.orderedSlots

  const isUsable = (slot: TimeSlot): boolean => {
    const overlapsBreak =
      timeToMinutes(slot.startTime) < breakEnd && timeToMinutes(slot.endTime) > breakStart
    return (
      !slot.isBreak &&
      !overlapsBreak &&
      timeToMinutes(slot.startTime) >= startLimit &&
      timeToMinutes(slot.endTime) <= endLimit
    )
  }

  const maxSpan = Math.max(1, ...data.requirements.map((r) => Math.max(1, r.span)))
  const windows = new Map<number, SolverWindow[]>()

  const teachingOrdinalBySlotId = new Map<string, number>()
  let teachingOrdinal = 0
  for (const slot of slots) {
    if (isUsable(slot)) teachingOrdinalBySlotId.set(slot.id, teachingOrdinal++)
  }

  for (let span = 1; span <= maxSpan; span++) {
    const list: SolverWindow[] = []
    for (let start = 0; start < slots.length; start++) {
      if (!isUsable(slots[start])) continue
      const covered: TimeSlot[] = []
      let ok = true
      for (let i = 0; i < span; i++) {
        const slot = slots[start + i]
        if (!slot || !isUsable(slot)) {
          ok = false
          break
        }
        covered.push(slot)
      }
      if (!ok) continue
      const first = covered[0]
      const last = covered[covered.length - 1]
      list.push({
        startIdx: start,
        endIdx: start + span - 1,
        slotIds: covered.map((s) => s.id),
        teachingOrdinals: covered.map((s) => teachingOrdinalBySlotId.get(s.id) ?? 0),
        label: `${first.startTime}–${last.endTime}`,
      })
    }
    windows.set(span, list)
  }

  const indexBySlotId = new Map<string, number>()
  slots.forEach((slot, i) => indexBySlotId.set(slot.id, i))

  return {
    days: data.days,
    orderedSlots: slots,
    windows,
    indexBySlotId,
    teachingOrdinalBySlotId,
    teachingPeriodCount: teachingOrdinal,
    preferSpread: data.preferSpread,
  }
}

// ---------------------------------------------------------------------------
// Input validation (structural, before searching)
// ---------------------------------------------------------------------------

function validateInputs(data: LoadedData, ctx: SolverContext): NewDiagnostic[] {
  const out: NewDiagnostic[] = []
  const scope = {
    academicYearId: data.academicYearId,
    workingDays: data.days,
    teachingPeriodsPerDay: data.teachingSlots.length,
    periodRange:
      data.teachingSlots.length > 0
        ? `${data.workingHours.startTime}–${data.workingHours.endTime}`
        : 'none',
    break: `${data.workingHours.breakStart}–${data.workingHours.breakEnd}`,
  }

  if (data.days.length === 0) {
    out.push(
      diagnostic(
        'ERROR',
        GenerationDiagnosticCode.INPUT_INVALID,
        'No working days are configured, so no timetable can be generated.',
        {
          ...scope,
          reason: 'The working-days setting is empty.',
          suggestedAction: 'Open Settings and select at least one working day.',
        }
      )
    )
  }

  if (data.teachingSlots.length === 0) {
    out.push(
      diagnostic(
        'ERROR',
        GenerationDiagnosticCode.INPUT_INVALID,
        'No teaching periods are configured inside the working hours, so no timetable can be generated.',
        {
          ...scope,
          reason: 'Every configured period is a break or lies outside the working hours.',
          suggestedAction:
            'Open Settings and check the working hours and period list (break periods cannot hold classes).',
        }
      )
    )
  }

  if (data.sections.length === 0) {
    out.push(
      diagnostic(
        'ERROR',
        GenerationDiagnosticCode.INPUT_INVALID,
        'No sections exist for this academic year.',
        {
          ...scope,
          reason: 'A timetable needs at least one class section.',
          suggestedAction: 'Create a section on the Classes page, then try again.',
        }
      )
    )
  }

  if (data.requirements.length === 0) {
    out.push(
      diagnostic(
        'ERROR',
        GenerationDiagnosticCode.INPUT_INVALID,
        'No subject requirements are defined, so there is nothing to schedule.',
        {
          ...scope,
          reason: 'Subject Requirements ("how many sessions per week") are missing.',
          suggestedAction:
            'Open Subject Requirements and add the weekly sessions for each section and subject.',
        }
      )
    )
  }

  if (data.allocations.length === 0) {
    out.push(
      diagnostic(
        'ERROR',
        GenerationDiagnosticCode.NO_QUALIFIED_FACULTY,
        'No teaching allocations are defined, so no faculty are assigned to any subject.',
        {
          ...scope,
          reason: 'Teaching Allocations ("who teaches what") are missing.',
          suggestedAction:
            'Open Teaching Allocations and allocate faculty to subjects for each section.',
        }
      )
    )
  }

  if (out.some((d) => d.severity === 'ERROR')) return out

  const sectionIds = new Set(data.sections.map((s) => s.id))
  const activeFacultyIds = new Set(data.faculty.map((f) => f.id))
  // Staff who are configured as non-teaching: they may hold rows elsewhere in
  // the app, but a teaching allocation for them is a configuration error the
  // administrator must see, not something to silently skip.
  const nonTeachingFacultyIds = new Set(
    data.faculty.filter((f) => f.staffType === 'NON_TEACHING').map((f) => f.id)
  )

  // Requirements must have at least one allocation with an active faculty member.
  for (const req of data.requirements) {
    const section = data.sections.find((s) => s.id === req.sectionId)
    const subject = data.subjects.find((s) => s.id === req.subjectId)
    const context = {
      ...scope,
      requirementId: req.id,
      sectionId: req.sectionId,
      sectionName: section?.name ?? 'Unknown section',
      subjectId: req.subjectId,
      subjectName: subject?.name ?? 'Unknown subject',
      subjectCode: subject?.code ?? '',
      classType: req.classType,
      span: req.span,
      requiredSessionsPerWeek: req.requiredSessionsPerWeek,
    }

    if (!section || section.academicYearId !== data.academicYearId || !sectionIds.has(req.sectionId)) {
      out.push(
        diagnostic(
          'ERROR',
          GenerationDiagnosticCode.INPUT_INVALID,
          `Subject Requirement for ${context.sectionName} · ${context.subjectName} refers to a section that does not belong to this academic year.`,
          {
            ...context,
            reason: 'The section is missing or belongs to a different academic year.',
            suggestedAction: 'Delete this requirement and recreate it for a section of this year.',
          }
        )
      )
      continue
    }

    if (!subject) {
      out.push(
        diagnostic(
          'ERROR',
          GenerationDiagnosticCode.INPUT_INVALID,
          `Subject Requirement for ${context.sectionName} refers to a subject that no longer exists.`,
          {
            ...context,
            reason: 'The subject row was deleted.',
            suggestedAction: 'Remove this requirement on the Subject Requirements page.',
          }
        )
      )
      continue
    }

    if (
      !Number.isInteger(req.requiredSessionsPerWeek) ||
      req.requiredSessionsPerWeek < 1 ||
      !Number.isInteger(req.span) ||
      req.span < 1
    ) {
      out.push(
        diagnostic(
          'ERROR',
          GenerationDiagnosticCode.INPUT_INVALID,
          `Subject Requirement for ${context.sectionName} · ${context.subjectName} has an invalid session count or duration.`,
          {
            ...context,
            reason: 'Sessions per week and duration must be whole numbers of at least 1.',
            suggestedAction: 'Edit the requirement and set a positive whole number.',
          }
        )
      )
      continue
    }

    const allocations = data.allocations.filter(
      (a) =>
        a.sectionId === req.sectionId &&
        a.subjectId === req.subjectId &&
        a.classType === req.classType
    )
    const nonTeachingAllocations = allocations.filter((a) =>
      nonTeachingFacultyIds.has(a.facultyId)
    )
    const pool = allocations.filter(
      (a) => activeFacultyIds.has(a.facultyId) && !nonTeachingFacultyIds.has(a.facultyId)
    )

    if (allocations.length === 0) {
      out.push(
        diagnostic(
          'ERROR',
          GenerationDiagnosticCode.NO_QUALIFIED_FACULTY,
          `${context.sectionName} · ${context.subjectName} (${context.classType}) has no teaching allocation.`,
          {
            ...context,
            attemptedScope: `${req.requiredSessionsPerWeek} session(s)/week of ${req.span} period(s) could not be expanded: no faculty is allocated.`,
            reason: 'No Teaching Allocation exists for this section + subject + activity type.',
            suggestedAction: `Open Teaching Allocations and add faculty for ${context.sectionName} · ${context.subjectName} (${context.classType}).`,
          },
          allocations[0]?.id ?? null
        )
      )
      continue
    }

    if (nonTeachingAllocations.length > 0) {
      const names = [
        ...new Set(
          nonTeachingAllocations.map(
            (a) => data.faculty.find((f) => f.id === a.facultyId)?.name ?? a.facultyId
          )
        ),
      ].join(', ')
      out.push(
        diagnostic(
          'ERROR',
          GenerationDiagnosticCode.INPUT_INVALID,
          `${names} is non-teaching staff and cannot be allocated to ${context.sectionName} · ${context.subjectName} (${context.classType}).`,
          {
            ...context,
            reason:
              'The faculty member is marked as non-teaching staff on the Faculty page; non-teaching staff are never assigned teaching sessions.',
            suggestedAction: `Remove the allocation for ${names} (or mark them as teaching staff on the Faculty page if that is wrong), then generate again.`,
          },
          nonTeachingAllocations[0].id
        )
      )
    }

    if (pool.length === 0) {
      // The non-teaching case above already reported the precise reason.
      if (nonTeachingAllocations.length > 0) continue
      out.push(
        diagnostic(
          'ERROR',
          GenerationDiagnosticCode.NO_QUALIFIED_FACULTY,
          `Every faculty allocated to ${context.sectionName} · ${context.subjectName} is inactive.`,
          {
            ...context,
            attemptedScope: `${allocations.length} allocation(s) found, none with an active faculty member.`,
            reason: 'The allocated faculty member(s) are marked inactive.',
            suggestedAction: 'Reactivate the faculty member or reallocate this subject.',
          },
          allocations[0].id
        )
      )
      continue
    }

    if (req.teachingArrangement === 'TEAM' && pool.length < 2) {
      out.push(
        diagnostic(
          'ERROR',
          GenerationDiagnosticCode.INPUT_INVALID,
          `${context.sectionName} · ${context.subjectName} (${context.classType}) is configured as a teaching Team but only ${pool.length} teacher is allocated.`,
          {
            ...context,
            reason:
              'A Team arrangement needs at least two teaching staff so the sessions are taught together.',
            suggestedAction:
              'Allocate a second teacher for this activity in Teaching Allocations, or switch its Teaching Arrangement to Alternate or Automatic on the Subject Requirements page.',
          },
          allocations[0].id
        )
      )
    }

    // Span must fit somewhere without crossing the break or the day end.
    if ((ctx.windows.get(req.span) ?? []).length === 0) {
      out.push(
        diagnostic(
          'ERROR',
          GenerationDiagnosticCode.NO_VALID_WINDOW,
          `${context.sectionName} · ${context.subjectName}: a ${req.span}-period session cannot fit into the teaching day.`,
          {
            ...context,
            attemptedScope: `${data.teachingSlots.length} teaching period(s)/day, break ${data.workingHours.breakStart}–${data.workingHours.breakEnd}.`,
            reason:
              'Every possible start would cross the break or run past the last period of the day.',
            suggestedAction:
              'Reduce the session length in Subject Requirements, or adjust periods/break/working hours in Settings.',
          }
        )
      )
    }

    // LAB rooms.
    if (req.classType === 'LAB') {
      const labRooms = data.rooms.filter((r) => r.type === 'LAB')
      if (labRooms.length === 0) {
        out.push(
          diagnostic(
            'WARNING',
            GenerationDiagnosticCode.INSUFFICIENT_ROOMS,
            `No laboratory room is defined — ${context.sectionName} · ${context.subjectName} labs will be scheduled without a room.`,
            {
              ...context,
              reason: 'The rooms list contains no room of type "Lab".',
              suggestedAction: 'Add a lab room on the Rooms page, then regenerate.',
            }
          )
        )
      }
    }
  }

  // Section capacity: exact periods needed vs. periods available.
  const capacityPerSection = data.days.length * data.teachingSlots.length
  const neededBySection = new Map<string, number>()
  for (const req of data.requirements) {
    const need = req.requiredSessionsPerWeek * Math.max(1, req.span)
    neededBySection.set(req.sectionId, (neededBySection.get(req.sectionId) ?? 0) + need)
  }
  for (const [sectionId, needed] of neededBySection) {
    if (needed > capacityPerSection) {
      const section = data.sections.find((s) => s.id === sectionId)
      out.push(
        diagnostic(
          'ERROR',
          GenerationDiagnosticCode.SECTION_OVERLOADED,
          `${section?.name ?? 'Section'} needs ${needed} periods per week but only ${capacityPerSection} are available.`,
          {
            ...scope,
            sectionId,
            sectionName: section?.name ?? 'Unknown',
            periodsNeeded: needed,
            periodsAvailable: capacityPerSection,
            reason: 'The sum of all weekly sessions (× duration) exceeds the weekly timetable grid.',
            suggestedAction:
              'Reduce weekly sessions or durations in Subject Requirements, or add working days/periods in Settings.',
          }
        )
      )
    }
  }

  // Faculty lower bound: a faculty member who is the ONLY eligible teacher for
  // groups (or a lab team member) must personally cover those periods.
  const facultyMinLoad = new Map<string, number>()
  const groupByRequirementKey = new Map<string, TeachingAllocation[]>()
  for (const a of data.allocations) {
    const key = `${a.sectionId}|${a.subjectId}|${a.classType}`
    const list = groupByRequirementKey.get(key) ?? []
    list.push(a)
    groupByRequirementKey.set(key, list)
  }
  for (const req of data.requirements) {
    const key = `${req.sectionId}|${req.subjectId}|${req.classType}`
    const group = (groupByRequirementKey.get(key) ?? []).filter(
      (a) => activeFacultyIds.has(a.facultyId) && !nonTeachingFacultyIds.has(a.facultyId)
    )
    const periods = req.requiredSessionsPerWeek * Math.max(1, req.span)
    const isTeam = effectiveTeachingArrangement(req, group.length) === 'TEAM'
    if (group.length === 1 || isTeam) {
      for (const a of group) {
        facultyMinLoad.set(a.facultyId, (facultyMinLoad.get(a.facultyId) ?? 0) + periods)
      }
    }
  }
  for (const [facultyId, load] of facultyMinLoad) {
    if (load > capacityPerSection) {
      const member = data.faculty.find((f) => f.id === facultyId)
      out.push(
        diagnostic(
          'ERROR',
          GenerationDiagnosticCode.FACULTY_OVERLOADED,
          `${member?.name ?? 'A faculty member'} must teach at least ${load} periods per week but only ${capacityPerSection} exist.`,
          {
            ...scope,
            facultyId,
            facultyName: member?.name ?? 'Unknown',
            periodsNeeded: load,
            periodsAvailable: capacityPerSection,
            reason: 'The faculty member is the only eligible (or a required team) teacher for more periods than exist.',
            suggestedAction: 'Add another eligible faculty member to some of these subjects, or reduce weekly sessions.',
          },
          null
        )
      )
    }
  }

  // Lab rooms when they do exist.
  const labRooms = data.rooms.filter((r) => r.type === 'LAB')
  const hasLabRequirement = data.requirements.some((r) => r.classType === 'LAB')
  if (hasLabRequirement && labRooms.length === 0 && !out.some((d) => d.code === GenerationDiagnosticCode.INSUFFICIENT_ROOMS)) {
    out.push(
      diagnostic(
        'WARNING',
        GenerationDiagnosticCode.INSUFFICIENT_ROOMS,
        'No laboratory room is defined; labs will be scheduled without a room.',
        {
          ...scope,
          reason: 'The rooms list contains no room of type "Lab".',
          suggestedAction: 'Add a lab room on the Rooms page, then regenerate.',
        }
      )
    )
  }

  return out
}

// ---------------------------------------------------------------------------
// Task expansion
// ---------------------------------------------------------------------------

/**
 * The teaching arrangement a requirement is scheduled under.
 *
 * `AUTO` keeps the historical rule (a lab with more than one allocated teacher
 * is a TEAM, everything else is ALTERNATE); an explicit TEAM/ALTERNATE on the
 * Subject Requirement always wins. The same helper is used by the input
 * validation, the scheduler and the draft validation so they can never
 * disagree about what "team" means for a requirement. The subject's *name*
 * never influences the result — the arrangement is always configured.
 */
export function effectiveTeachingArrangement(
  req: Pick<SubjectRequirement, 'classType' | 'teachingArrangement'>,
  poolSize: number
): 'TEAM' | 'ALTERNATE' {
  if (req.teachingArrangement === 'TEAM') return 'TEAM'
  if (req.teachingArrangement === 'ALTERNATE') return 'ALTERNATE'
  return req.classType === 'LAB' && poolSize > 1 ? 'TEAM' : 'ALTERNATE'
}

function buildTasks(data: LoadedData): SchedulingTask[] {
  // data.faculty is `findActive()`, so this set is exactly the schedulable
  // staff: active AND teaching (non-teaching rows are never placed).
  const teachingFacultyIds = new Set(
    data.faculty.filter((f) => f.staffType === 'TEACHING').map((f) => f.id)
  )
  const sectionsById = new Map(data.sections.map((s) => [s.id, s]))
  const subjectsById = new Map(data.subjects.map((s) => [s.id, s]))

  const labRooms = data.rooms.filter((r) => r.type === 'LAB')
  const otherRooms = data.rooms.filter((r) => r.type !== 'LAB')

  const tasks: SchedulingTask[] = []

  const orderedRequirements = data.requirements
    .slice()
    .sort((a, b) =>
      a.sectionId !== b.sectionId
        ? a.sectionId < b.sectionId
          ? -1
          : 1
        : a.subjectId !== b.subjectId
          ? a.subjectId < b.subjectId
            ? -1
            : 1
          : a.classType < b.classType
            ? -1
            : a.classType > b.classType
              ? 1
              : 0
    )

  for (const req of orderedRequirements) {
    const group = data.allocations
      .filter(
        (a) =>
          a.sectionId === req.sectionId &&
          a.subjectId === req.subjectId &&
          a.classType === req.classType &&
          teachingFacultyIds.has(a.facultyId)
      )
      .sort((a, b) => (a.facultyId < b.facultyId ? -1 : a.facultyId > b.facultyId ? 1 : 0))
    if (group.length === 0) continue // already reported by validateInputs

    const poolIds: string[] = []
    for (const a of group) {
      if (!poolIds.includes(a.facultyId)) poolIds.push(a.facultyId)
    }
    // Deterministic pool: priority, then name, then id.
    const facultyPool = data.faculty
      .filter((f) => poolIds.includes(f.id))
      .sort(byPriorityThenName)
      .map((f) => f.id)

    const facultyTargets = new Map<string, number>()
    for (const a of group) {
      facultyTargets.set(a.facultyId, Math.max(1, a.requiredSessionsPerWeek))
    }

    const facultyRank = new Map<string, number>()
    facultyPool.forEach((id, i) => facultyRank.set(id, i))

    const isLab = req.classType === 'LAB'
    const rooms = (isLab ? labRooms : otherRooms).map((r) => r.id)
    const roomRank = new Map<string, number>()
    rooms.forEach((id, i) => roomRank.set(id, i))

    const section = sectionsById.get(req.sectionId)
    const subject = subjectsById.get(req.subjectId)
    const baseKey = `${req.sectionId}|${req.subjectId}|${req.classType}`

    const difficulty =
      (Math.max(1, req.span) > 1 ? 1000 : 0) +
      (facultyPool.length > 1 && isLab ? 500 : 0) +
      (isLab ? 200 : 0) +
      (4 - Math.min(4, facultyPool.length)) * 20 +
      (4 - Math.min(4, rooms.length)) * 5

    const sessions = Math.max(1, req.requiredSessionsPerWeek)
    for (let i = 0; i < sessions; i++) {
      tasks.push({
        key: `${baseKey}#${i}`,
        baseKey,
        sessionIndex: i,
        requirementId: req.id,
        allocationIds: group.map((a) => a.id),
        sectionId: req.sectionId,
        sectionName: section?.name ?? 'Unknown section',
        subjectId: req.subjectId,
        subjectName: subject?.name ?? 'Unknown subject',
        subjectCode: subject?.code ?? '',
        classType: req.classType,
        span: Math.max(1, req.span),
        facultyPool,
        facultyTargets,
        facultyRank,
        mode: effectiveTeachingArrangement(req, facultyPool.length),
        rooms,
        roomRank,
        roomRequired: isLab && rooms.length > 0,
        difficulty,
      })
    }
  }

  return tasks
}

// ---------------------------------------------------------------------------
// Solver state
// ---------------------------------------------------------------------------

function createState(): SolverState {
  return {
    sectionBusy: new Map(),
    facultyBusy: new Map(),
    roomBusy: new Map(),
    sectionDay: new Map(),
    sectionSubjectDay: new Map(),
    sectionPeriod: new Map(),
    facultyDay: new Map(),
    facultyPeriods: new Map(),
    facultyGroupSessions: new Map(),
    assigned: [],
    assignedKeys: new Set(),
    attempts: 0,
  }
}

function slotKeysFor(day: DayOfWeek, slotIds: string[]): string[] {
  return slotIds.map((id) => `${day}:${id}`)
}

function busySet(map: Map<string, Set<string>>, key: string): Set<string> {
  let set = map.get(key)
  if (!set) {
    set = new Set()
    map.set(key, set)
  }
  return set
}

function isFree(map: Map<string, Set<string>>, key: string, keys: string[]): boolean {
  const set = map.get(key)
  if (!set) return true
  return keys.every((k) => !set.has(k))
}

function bump(map: Map<string, number>, key: string, delta: number): void {
  map.set(key, (map.get(key) ?? 0) + delta)
}

function place(state: SolverState, p: Placement): void {
  const keys = slotKeysFor(p.day, p.window.slotIds)
  for (const k of keys) {
    busySet(state.sectionBusy, p.task.sectionId).add(k)
    for (const f of p.facultyIds) busySet(state.facultyBusy, f).add(k)
    if (p.roomId) busySet(state.roomBusy, p.roomId).add(k)
  }
  bump(state.sectionDay, `${p.task.sectionId}|${p.day}`, keys.length)
  bump(state.sectionSubjectDay, `${p.task.sectionId}|${p.task.subjectId}|${p.day}`, 1)
  for (const ordinal of p.window.teachingOrdinals) {
    bump(state.sectionPeriod, `${p.task.sectionId}|${ordinal}`, 1)
  }
  for (const f of p.facultyIds) {
    bump(state.facultyDay, `${f}|${p.day}`, keys.length)
    bump(state.facultyPeriods, f, keys.length)
    bump(state.facultyGroupSessions, `${f}|${p.task.baseKey}`, 1)
  }
  state.assigned.push(p)
  state.assignedKeys.add(p.task.key)
}

function unplace(state: SolverState, p: Placement): void {
  const keys = slotKeysFor(p.day, p.window.slotIds)
  for (const k of keys) {
    state.sectionBusy.get(p.task.sectionId)?.delete(k)
    for (const f of p.facultyIds) state.facultyBusy.get(f)?.delete(k)
    if (p.roomId) state.roomBusy.get(p.roomId)?.delete(k)
  }
  bump(state.sectionDay, `${p.task.sectionId}|${p.day}`, -keys.length)
  bump(state.sectionSubjectDay, `${p.task.sectionId}|${p.task.subjectId}|${p.day}`, -1)
  for (const ordinal of p.window.teachingOrdinals) {
    bump(state.sectionPeriod, `${p.task.sectionId}|${ordinal}`, -1)
  }
  for (const f of p.facultyIds) {
    bump(state.facultyDay, `${f}|${p.day}`, -keys.length)
    bump(state.facultyPeriods, f, -keys.length)
    bump(state.facultyGroupSessions, `${f}|${p.task.baseKey}`, -1)
  }
  state.assigned.pop()
  state.assignedKeys.delete(p.task.key)
}

// ---------------------------------------------------------------------------
// Candidate generation & soft scoring
// ---------------------------------------------------------------------------

function scoreCandidate(
  task: SchedulingTask,
  day: DayOfWeek,
  window: SolverWindow,
  facultyIds: string[],
  roomId: string | null,
  state: SolverState,
  ctx: SolverContext
): number {
  let score = 0

  if (ctx.preferSpread) {
    const sameDaySubject = state.sectionSubjectDay.get(
      `${task.sectionId}|${task.subjectId}|${day}`
    )
    score +=
      sameDaySubject === 0
        ? SOFT_WEIGHTS.spreadNewDay
        : SOFT_WEIGHTS.sameDayRepeat * (sameDaySubject ?? 0)

    let busiest = 0
    for (const d of ctx.days) {
      busiest = Math.max(busiest, state.sectionDay.get(`${task.sectionId}|${d}`) ?? 0)
    }
    const thisDay = state.sectionDay.get(`${task.sectionId}|${day}`) ?? 0
    score += (busiest - thisDay) * SOFT_WEIGHTS.dayBalance

    // Time-of-day balance: prefer the teaching periods where this section has
    // the least load so far. Without this term every score tie falls through
    // to the earliest-period tie-break and a section whose week fits inside
    // its mornings never touches the afternoon.
    let busiestPeriod = 0
    for (let ordinal = 0; ordinal < ctx.teachingPeriodCount; ordinal++) {
      busiestPeriod = Math.max(
        busiestPeriod,
        state.sectionPeriod.get(`${task.sectionId}|${ordinal}`) ?? 0
      )
    }
    for (const ordinal of window.teachingOrdinals) {
      const load = state.sectionPeriod.get(`${task.sectionId}|${ordinal}`) ?? 0
      score += (busiestPeriod - load) * SOFT_WEIGHTS.periodBalance
    }

    // Faculty day balance: keep one teacher's day from stacking up when an
    // equally legal day exists.
    for (const f of facultyIds) {
      let busiestFacultyDay = 0
      for (const d of ctx.days) {
        busiestFacultyDay = Math.max(
          busiestFacultyDay,
          state.facultyDay.get(`${f}|${d}`) ?? 0
        )
      }
      const facultyDayLoad = state.facultyDay.get(`${f}|${day}`) ?? 0
      score += (busiestFacultyDay - facultyDayLoad) * SOFT_WEIGHTS.facultyDayBalance
    }
  }

  for (const f of facultyIds) {
    const target = task.facultyTargets.get(f) ?? 0
    const assigned = state.facultyGroupSessions.get(`${f}|${task.baseKey}`) ?? 0
    if (target > assigned) {
      score += (target - assigned) * SOFT_WEIGHTS.facultyTargetDeficit
    }
    score += (state.facultyPeriods.get(f) ?? 0) * SOFT_WEIGHTS.facultyLoad
  }

  // Fill gaps: bonus when the window sits directly next to an existing class
  // of the same section that day, bonus when bridging a hole, and penalty
  // when leaving an isolated single-period gap.
  const sectionSlots = state.sectionBusy.get(task.sectionId)
  if (sectionSlots && sectionSlots.size > 0) {
    const prevIdx = window.startIdx - 1
    const nextIdx = window.endIdx + 1
    const prevSlot = prevIdx >= 0 ? ctx.orderedSlots[prevIdx] : undefined
    const nextSlot = nextIdx < ctx.orderedSlots.length ? ctx.orderedSlots[nextIdx] : undefined
    const hasPrev = prevSlot != null && !prevSlot.isBreak && sectionSlots.has(`${day}:${prevSlot.id}`)
    const hasNext = nextSlot != null && !nextSlot.isBreak && sectionSlots.has(`${day}:${nextSlot.id}`)

    if (hasPrev && hasNext) {
      score += SOFT_WEIGHTS.gapBridging
    } else if (hasPrev || hasNext) {
      score += SOFT_WEIGHTS.gapFilling
    }

    // Isolated gap check: if slot at startIdx - 2 is occupied, but startIdx - 1 is empty non-break
    const twoBeforeIdx = window.startIdx - 2
    if (twoBeforeIdx >= 0) {
      const twoBeforeSlot = ctx.orderedSlots[twoBeforeIdx]
      if (
        twoBeforeSlot != null &&
        !twoBeforeSlot.isBreak &&
        sectionSlots.has(`${day}:${twoBeforeSlot.id}`) &&
        prevSlot != null &&
        !prevSlot.isBreak &&
        !sectionSlots.has(`${day}:${prevSlot.id}`)
      ) {
        score += SOFT_WEIGHTS.isolatedGapPenalty
      }
    }

    // If slot at endIdx + 2 is occupied, but endIdx + 1 is empty non-break
    const twoAfterIdx = window.endIdx + 2
    if (twoAfterIdx < ctx.orderedSlots.length) {
      const twoAfterSlot = ctx.orderedSlots[twoAfterIdx]
      if (
        twoAfterSlot != null &&
        !twoAfterSlot.isBreak &&
        sectionSlots.has(`${day}:${twoAfterSlot.id}`) &&
        nextSlot != null &&
        !nextSlot.isBreak &&
        !sectionSlots.has(`${day}:${nextSlot.id}`)
      ) {
        score += SOFT_WEIGHTS.isolatedGapPenalty
      }
    }
  }

  // Morning start: prefer starting at period 1 (09:00) when scheduling for a day
  if (window.teachingOrdinals.includes(0)) {
    score += SOFT_WEIGHTS.morningStart
  }

  if (task.span >= 2) {
    score += (ctx.orderedSlots.length - window.endIdx) * SOFT_WEIGHTS.labEarlyInDay
  }

  if (roomId) {
    score += SOFT_WEIGHTS.roomAssigned
    const roomIsLab = task.rooms.includes(roomId) && task.classType === 'LAB'
    if (roomIsLab) score += SOFT_WEIGHTS.roomWellMatched
  }

  return score
}

function facultyChoicesFor(task: SchedulingTask): string[][] {
  return task.mode === 'TEAM' ? [task.facultyPool] : task.facultyPool.map((f) => [f])
}

/**
 * All legal placements of `task` under the current partial assignment,
 * ordered best-first with a fully deterministic tie-break.
 */
function candidatesFor(
  task: SchedulingTask,
  state: SolverState,
  ctx: SolverContext
): Placement[] {
  const out: Placement[] = []
  const windows = ctx.windows.get(task.span) ?? []
  if (windows.length === 0 || ctx.days.length === 0) return out

  const choices = facultyChoicesFor(task)

  for (let d = 0; d < ctx.days.length; d++) {
    const day = ctx.days[d]
    for (const window of windows) {
      const keys = slotKeysFor(day, window.slotIds)
      if (!isFree(state.sectionBusy, task.sectionId, keys)) continue

      const freeChoices: string[][] = []
      for (const choice of choices) {
        if (choice.length === 0) continue
        if (choice.every((f) => isFree(state.facultyBusy, f, keys))) freeChoices.push(choice)
      }
      if (freeChoices.length === 0) continue

      const freeRooms = task.rooms.filter((r) => isFree(state.roomBusy, r, keys))
      if (task.roomRequired && freeRooms.length === 0) continue
      const roomOptions: (string | null)[] = freeRooms.length > 0 ? [freeRooms[0]] : [null]

      for (const facultyIds of freeChoices) {
        for (const roomId of roomOptions) {
          out.push({
            task,
            day,
            window,
            facultyIds,
            roomId,
            score: scoreCandidate(task, day, window, facultyIds, roomId, state, ctx),
          })
        }
      }
    }
  }

  out.sort(compareCandidates)
  return out
}

function compareCandidates(a: Placement, b: Placement): number {
  if (a.score !== b.score) return b.score - a.score
  if (a.day !== b.day) return a.day < b.day ? -1 : 1
  if (a.window.startIdx !== b.window.startIdx) return a.window.startIdx - b.window.startIdx
  const ar = a.facultyIds.map((f) => a.task.facultyRank.get(f) ?? 0)
  const br = b.facultyIds.map((f) => b.task.facultyRank.get(f) ?? 0)
  const len = Math.max(ar.length, br.length)
  for (let i = 0; i < len; i++) {
    const av = ar[i] ?? Number.MAX_SAFE_INTEGER
    const bv = br[i] ?? Number.MAX_SAFE_INTEGER
    if (av !== bv) return av - bv
  }
  const arr = a.roomId ? (a.task.roomRank.get(a.roomId) ?? 0) : Number.MAX_SAFE_INTEGER
  const brr = b.roomId ? (b.task.roomRank.get(b.roomId) ?? 0) : Number.MAX_SAFE_INTEGER
  return arr - brr
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

function tallyBlockers(
  task: SchedulingTask,
  state: SolverState,
  ctx: SolverContext
): BlockerTally {
  const tally: BlockerTally = { windows: 0, bySection: 0, byFaculty: 0, byRoom: 0 }
  const windows = ctx.windows.get(task.span) ?? []
  const choices = facultyChoicesFor(task)
  for (const day of ctx.days) {
    for (const window of windows) {
      tally.windows++
      const keys = slotKeysFor(day, window.slotIds)
      if (!isFree(state.sectionBusy, task.sectionId, keys)) {
        tally.bySection++
        continue
      }
      const anyChoiceFree = choices.some(
        (choice) =>
          choice.length > 0 && choice.every((f) => isFree(state.facultyBusy, f, keys))
      )
      if (!anyChoiceFree) {
        tally.byFaculty++
        continue
      }
      if (task.roomRequired && !task.rooms.some((r) => isFree(state.roomBusy, r, keys))) {
        tally.byRoom++
      }
    }
  }
  return tally
}

function recordDeadEnd(
  deadEnds: Map<string, DeadEnd>,
  task: SchedulingTask,
  state: SolverState,
  ctx: SolverContext
): void {
  const existing = deadEnds.get(task.key)
  if (existing) {
    existing.branches++
    return
  }
  const structural = state.assigned.length === 0
  deadEnds.set(task.key, {
    task,
    structural,
    branches: 1,
    tally: tallyBlockers(task, state, ctx),
  })
}

/**
 * Recursive backtracking with MRV selection and forward checking.
 * Returns true once every task is placed. `onPlaced` lets the caller track
 * the deepest partial solution reached (used for failure analysis).
 */
function searchTracked(
  state: SolverState,
  ctx: SolverContext,
  orderedTasks: SchedulingTask[],
  deadline: number,
  maxAttempts: number,
  deadEnds: Map<string, DeadEnd>,
  stopReason: { value: SearchOutcome['stopReason'] },
  onPlaced: () => void
): boolean {
  if (stopReason.value) return false

  // MRV: pick the unassigned task with the fewest legal placements.
  // Iterating the pre-sorted (hardest first) list keeps ties deterministic.
  let nextTask: SchedulingTask | null = null
  let nextCandidates: Placement[] | null = null

  for (const task of orderedTasks) {
    if (state.assignedKeys.has(task.key)) continue
    const candidates = candidatesFor(task, state, ctx)
    if (candidates.length === 0) {
      // Forward check failed: this branch cannot satisfy the task.
      recordDeadEnd(deadEnds, task, state, ctx)
      return false
    }
    if (!nextCandidates || candidates.length < nextCandidates.length) {
      nextTask = task
      nextCandidates = candidates
    }
  }

  if (!nextTask || !nextCandidates) return true // everything is placed

  for (const candidate of nextCandidates) {
    if (state.attempts >= maxAttempts) {
      stopReason.value = 'attempts'
      return false
    }
    if (Date.now() > deadline) {
      stopReason.value = 'timeout'
      return false
    }
    state.attempts++
    place(state, candidate)
    onPlaced()
    if (
      searchTracked(state, ctx, orderedTasks, deadline, maxAttempts, deadEnds, stopReason, onPlaced)
    ) {
      return true
    }
    unplace(state, candidate)
    if (stopReason.value) return false
  }

  return false
}

function solve(
  tasks: SchedulingTask[],
  ctx: SolverContext,
  maxAttempts: number,
  timeoutMs: number
): SearchOutcome {
  const state = createState()
  const deadline = Date.now() + timeoutMs
  const deadEnds = new Map<string, DeadEnd>()
  const stopReason: { value: SearchOutcome['stopReason'] } = { value: null }

  // Hardest first: multi-period, team labs, fewer eligible faculty/rooms.
  const orderedTasks = tasks.slice().sort((a, b) =>
    b.difficulty !== a.difficulty ? b.difficulty - a.difficulty : a.key < b.key ? -1 : 1
  )

  let best: Placement[] = []
  const success = searchTracked(
    state,
    ctx,
    orderedTasks,
    deadline,
    maxAttempts,
    deadEnds,
    stopReason,
    () => {
      if (state.assigned.length > best.length) best = state.assigned.slice()
    }
  )

  return {
    success,
    attempts: state.attempts,
    stopReason: success ? null : (stopReason.value ?? 'exhausted'),
    deadEnds,
    best,
  }
}

// ---------------------------------------------------------------------------
// Failure diagnostics
// ---------------------------------------------------------------------------

function failureDiagnostics(
  deadEnds: Map<string, DeadEnd>,
  outcome: SearchOutcome,
  tasks: SchedulingTask[],
  data: LoadedData,
  ctx: SolverContext,
  elapsedMs: number
): NewDiagnostic[] {
  const out: NewDiagnostic[] = []
  const scope = {
    workingDays: data.days,
    teachingPeriodsPerDay: data.teachingSlots.length,
    periodRange: `${data.workingHours.startTime}–${data.workingHours.endTime}`,
    breakRange: `${data.workingHours.breakStart}–${data.workingHours.breakEnd}`,
    sessionsRequested: tasks.length,
    search: {
      attempts: outcome.attempts,
      deepestPartialSolution: outcome.best.length,
      stopReason: outcome.stopReason,
      limitAttempts: data.maxAttempts,
      limitTimeoutMs: data.timeoutMs,
      elapsedMs,
    },
  }

  const list = Array.from(deadEnds.values())
  list.sort((a, b) =>
    a.task.key < b.task.key ? -1 : a.task.key > b.task.key ? 1 : 0
  )

  for (const deadEnd of list.slice(0, MAX_FAILURE_DIAGNOSTICS)) {
    const { task, tally } = deadEnd
    const windows = ctx.windows.get(task.span) ?? []
    const attemptedScope = `${data.days.length} working day(s) × ${data.teachingSlots.length} period(s) = ${
      data.days.length * data.teachingSlots.length
    } periods/week; ${windows.length} legal start position(s) per day for a ${task.span}-period session.`

    if (deadEnd.structural && windows.length === 0) {
      out.push(
        diagnostic(
          'ERROR',
          GenerationDiagnosticCode.NO_VALID_WINDOW,
          `${task.sectionName} · ${task.subjectName} (${task.classType}, ${task.span} period${task.span > 1 ? 's' : ''}): no legal period exists.`,
          {
            ...scope,
            sectionId: task.sectionId,
            sectionName: task.sectionName,
            subjectId: task.subjectId,
            subjectName: task.subjectName,
            requirementId: task.requirementId,
            classType: task.classType,
            span: task.span,
            attemptedScope,
            reason: 'Every start position would cross the break or run past the end of the teaching day.',
            suggestedAction:
              'Reduce the session length in Subject Requirements, or adjust periods/break/working hours in Settings.',
          },
          task.allocationIds[0] ?? null
        )
      )
      continue
    }

    if (deadEnd.structural) {
      out.push(
        diagnostic(
          'ERROR',
          GenerationDiagnosticCode.NO_QUALIFIED_FACULTY,
          `${task.sectionName} · ${task.subjectName} (${task.classType}): no faculty member can be placed.`,
          {
            ...scope,
            sectionId: task.sectionId,
            sectionName: task.sectionName,
            subjectId: task.subjectId,
            subjectName: task.subjectName,
            requirementId: task.requirementId,
            classType: task.classType,
            span: task.span,
            eligibleFaculty: task.facultyPool,
            attemptedScope,
            reason: 'No eligible faculty member is free for any legal period of this session.',
            suggestedAction:
              'Check Teaching Allocations and faculty workload, or reduce this subject’s weekly sessions.',
          },
          task.allocationIds[0] ?? null
        )
      )
      continue
    }

    const dominant =
      tally.bySection >= tally.byFaculty && tally.bySection >= tally.byRoom
        ? GenerationDiagnosticCode.SECTION_CONFLICT
        : tally.byFaculty >= tally.byRoom
          ? GenerationDiagnosticCode.FACULTY_CONFLICT
          : GenerationDiagnosticCode.ROOM_CONFLICT

    const reason = `When the search stalled, all ${tally.windows} legal period(s) were taken: ${tally.bySection} by the section’s own required sessions, ${tally.byFaculty} by faculty already teaching elsewhere, ${tally.byRoom} by booked rooms.`

    out.push(
      diagnostic(
        'ERROR',
        dominant,
        `${task.sectionName} · ${task.subjectName} (${task.classType}, session ${task.sessionIndex + 1}): no period remains free for all required sessions.`,
        {
          ...scope,
          sectionId: task.sectionId,
          sectionName: task.sectionName,
          subjectId: task.subjectId,
          subjectName: task.subjectName,
          requirementId: task.requirementId,
          allocationIds: task.allocationIds,
          classType: task.classType,
          span: task.span,
          sessionIndex: task.sessionIndex,
          blockedBranches: deadEnd.branches,
          attemptedScope,
          reason,
          suggestedAction:
            'Spread this subject across more days, shorten the session, reduce a weekly session count, or free up faculty/sections by lowering other subjects’ weekly requirements.',
        },
        task.allocationIds[0] ?? null
      )
    )
  }

  if (list.length > MAX_FAILURE_DIAGNOSTICS) {
    out.push(
      diagnostic(
        'INFO',
        GenerationDiagnosticCode.CONSTRAINT_UNSATISFIABLE,
        `${list.length - MAX_FAILURE_DIAGNOSTICS} further activities could not be placed (list truncated).`,
        { ...scope, truncated: list.length - MAX_FAILURE_DIAGNOSTICS }
      )
    )
  }

  const stopText =
    outcome.stopReason === 'attempts'
      ? `the attempt limit (${data.maxAttempts}) was reached`
      : outcome.stopReason === 'timeout'
        ? `the time limit (${data.timeoutMs} ms) was reached`
        : 'the search space was exhausted'

  out.push(
    diagnostic(
      'INFO',
      outcome.stopReason === 'attempts' || outcome.stopReason === 'timeout'
        ? GenerationDiagnosticCode.SEARCH_LIMIT_REACHED
        : GenerationDiagnosticCode.CONSTRAINT_UNSATISFIABLE,
      `Search stopped after ${elapsedMs} ms because ${stopText}; deepest partial solution had ${outcome.best.length} of ${tasks.length} sessions placed.`,
      {
        ...scope,
        attempts: outcome.attempts,
        deepestPartialSolution: outcome.best.length,
        sessionsRequested: tasks.length,
        elapsedMs,
        stopReason: outcome.stopReason,
        limitAttempts: data.maxAttempts,
        limitTimeoutMs: data.timeoutMs,
        reason: stopText,
        suggestedAction:
          outcome.stopReason === 'attempts' || outcome.stopReason === 'timeout'
            ? 'Raise the generation attempt/timeout limits in Settings, or reduce weekly requirements.'
            : 'Reduce weekly requirements or free up faculty/sections — no arrangement satisfies every requirement.',
      }
    )
  )

  return out
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

function persistDiagnostics(generationId: string, diagnostics: NewDiagnostic[]): GenerationDiagnostic[] {
  const saved: GenerationDiagnostic[] = []
  for (const d of diagnostics) {
    saved.push(
      generationDiagnosticRepository.create({
        id: newId(),
        generationId,
        teachingAllocationId: d.teachingAllocationId ?? null,
        severity: d.severity,
        code: d.code,
        message: d.message,
        details: d.details,
      })
    )
  }
  return saved
}

function summaryFor(
  status: 'COMPLETED' | 'FAILED',
  scheduled: number,
  total: number,
  labs: number,
  errors: number,
  warnings: number,
  elapsedMs: number,
  stopReason: SearchOutcome['stopReason']
): string {
  if (status === 'COMPLETED') {
    return `Scheduled ${scheduled}/${total} weekly session(s) (${labs} lab session(s)) in ${elapsedMs} ms. ${errors} error(s), ${warnings} warning(s).`
  }
  const reason =
    stopReason === 'attempts'
      ? 'attempt limit reached'
      : stopReason === 'timeout'
        ? 'time limit reached'
        : 'requirements are unsatisfiable'
  return `FAILED: scheduled ${scheduled}/${total} session(s) — ${reason} after ${elapsedMs} ms. ${errors} error(s), ${warnings} warning(s).`
}

// ---------------------------------------------------------------------------
// Public API — generation
// ---------------------------------------------------------------------------

export function generateTimetable(academicYearId: string): GenerationResult {
  const startedAt = Date.now()
  const year = academicYearRepository.findById(academicYearId)
  if (!year) {
    throw new Error('The selected academic year no longer exists. Refresh the page and try again.')
  }

  const data = loadAllData(academicYearId)
  const ctx = buildContext(data)
  const snapshot = buildConstraintsSnapshot(data)

  const generationId = newId()
  timetableGenerationRepository.create({
    id: generationId,
    academicYearId,
    status: 'RUNNING',
    constraintsSnapshot: snapshot,
  })
  inFlightGenerations.add(generationId)

  const finishFailure = (
    diagnostics: NewDiagnostic[],
    scheduled: number,
    total: number,
    labs: number,
    stopReason: SearchOutcome['stopReason'] = null,
    attempts = 0
  ): GenerationResult => {
    const elapsedMs = Date.now() - startedAt
    const errors = diagnostics.filter((d) => d.severity === 'ERROR').length
    const warnings = diagnostics.filter((d) => d.severity === 'WARNING').length
    const saved = persistDiagnostics(generationId, diagnostics)
    const summary = summaryFor('FAILED', scheduled, total, labs, errors, warnings, elapsedMs, stopReason)
    timetableGenerationRepository.updateStatus(generationId, 'FAILED', summary)
    return {
      generationId,
      status: 'FAILED',
      assignments: [],
      diagnostics: saved,
      diagnosticsSummary: summary,
      statistics: {
        totalAllocations: total,
        scheduled,
        uncovered: total - scheduled,
        errors,
        warnings,
        labs,
      },
      search: {
        attempts,
        elapsedMs,
        limitAttempts: data.maxAttempts,
        limitTimeoutMs: data.timeoutMs,
        stopReason,
      },
    }
  }

  try {
    // 1. Structural validation before any search effort is spent.
    const inputDiagnostics = validateInputs(data, ctx)
    const blocking = inputDiagnostics.some((d) => d.severity === 'ERROR')
    if (blocking) {
      // Even when structural validation stops the search before task expansion,
      // the result must report the demand that could not be scheduled. A zero
      // total made an overloaded/conflicting fixture look like it had no work
      // at all, which was misleading in both the UI and audit output.
      const requestedSessions = data.requirements.reduce(
        (sum, requirement) =>
          sum +
          (Number.isInteger(requirement.requiredSessionsPerWeek) &&
          requirement.requiredSessionsPerWeek > 0
            ? requirement.requiredSessionsPerWeek
            : 0),
        0
      )
      return finishFailure(inputDiagnostics, 0, requestedSessions, 0, null)
    }

    // 2. Expand requirements into scheduling units.
    const tasks = buildTasks(data)
    if (tasks.length === 0) {
      return finishFailure(
        [
          ...inputDiagnostics,
          diagnostic(
            'ERROR',
            GenerationDiagnosticCode.INPUT_INVALID,
            'Nothing could be expanded into sessions — requirements and allocations do not line up.',
            {
              requirements: data.requirements.length,
              allocations: data.allocations.length,
              reason: 'No Subject Requirement had a matching Teaching Allocation with active faculty.',
              suggestedAction:
                'Recheck Teaching Allocations: every section + subject + activity type needs a faculty allocation.',
            }
          ),
        ],
        0,
        0,
        0,
        null
      )
    }

    // 3. Deterministic backtracking search (MRV + forward checking + bounds).
    const outcome = solve(tasks, ctx, data.maxAttempts, data.timeoutMs)
    const elapsedMs = Date.now() - startedAt

    if (!outcome.success) {
      const diagnostics = [
        ...inputDiagnostics,
        ...failureDiagnostics(outcome.deadEnds, outcome, tasks, data, ctx, elapsedMs),
      ]
      return finishFailure(
        diagnostics,
        outcome.best.length,
        tasks.length,
        countLabs(outcome.best),
        outcome.stopReason,
        outcome.attempts
      )
    }

    // 4. Persist the draft (entry + faculty team + rooms) atomically.
    const placements = outcome.best.slice().sort(comparePlacementsForOutput)
    const draftEntries = placements.map((p) => ({
      id: newId(),
      generationId,
      academicYearId,
      dayOfWeek: p.day,
      timeSlotId: p.window.slotIds[0],
      sectionId: p.task.sectionId,
      subjectId: p.task.subjectId,
      classType: p.task.classType,
      span: p.task.span,
      status: 'DRAFT' as const,
      facultyIds: p.facultyIds,
      roomIds: p.roomId ? [p.roomId] : [],
    }))
    const errors = inputDiagnostics.filter((d) => d.severity === 'ERROR').length
    const warnings = inputDiagnostics.filter((d) => d.severity === 'WARNING').length
    const labs = countLabs(placements)
    const attempts = outcome.attempts
    const summary = summaryFor('COMPLETED', placements.length, tasks.length, labs, errors, warnings, elapsedMs, null)
    // One transaction: draft entries, diagnostics and the COMPLETED status
    // land together — a crash in between must never leave a RUNNING
    // generation with committed drafts (the status gate the UI keys off).
    let savedDiagnostics: any[] = []
    withTransaction(() => {
      draftTimetableEntryRepository.bulkCreate(draftEntries)
      if (inputDiagnostics.length > 0) {
        savedDiagnostics = persistDiagnostics(generationId, inputDiagnostics)
      }
      timetableGenerationRepository.updateStatus(generationId, 'COMPLETED', summary)
    })

    return {
      generationId,
      status: 'COMPLETED',
      assignments: draftEntries as unknown as GenerationResult['assignments'],
      diagnostics: savedDiagnostics,
      diagnosticsSummary: summary,
      statistics: {
        totalAllocations: tasks.length,
        scheduled: placements.length,
        uncovered: tasks.length - placements.length,
        errors,
        warnings,
        labs,
      },
      search: {
        attempts,
        elapsedMs,
        limitAttempts: data.maxAttempts,
        limitTimeoutMs: data.timeoutMs,
        stopReason: null,
      },
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error('[timetableGenerator]', error)
    return finishFailure(
      [
        diagnostic(
          'ERROR',
          GenerationDiagnosticCode.INPUT_INVALID,
          `Generation failed: ${message}`,
          {
            reason: message,
            suggestedAction: 'Check the configuration on the Teaching Allocations, Subject Requirements and Settings pages.',
          }
        ),
      ],
      0,
      0,
      0,
      null
    )
  } finally {
    // The run is no longer active in this process — stale recovery may
    // consider its row from now on.
    inFlightGenerations.delete(generationId)
  }
}

function countLabs(placements: Placement[]): number {
  return placements.filter((p) => p.task.classType === 'LAB').length
}

function comparePlacementsForOutput(a: Placement, b: Placement): number {
  if (a.day !== b.day) return a.day < b.day ? -1 : 1
  if (a.window.startIdx !== b.window.startIdx) return a.window.startIdx - b.window.startIdx
  return a.task.key < b.task.key ? -1 : a.task.key > b.task.key ? 1 : 0
}

// ---------------------------------------------------------------------------
// Public API — independent draft validation
// ---------------------------------------------------------------------------

export function validateDraftTimetable(generationId: string): DraftValidationResult {
  const result: DraftValidationResult = {
    generationId,
    valid: false,
    errors: [],
    warnings: [],
    entries: 0,
    requiredSessions: 0,
    scheduledSessions: 0,
    labsScheduled: 0,
    missing: [],
  }

  const generation = timetableGenerationRepository.findById(generationId)
  if (!generation) {
    result.errors.push('This generation no longer exists.')
    return result
  }

  const entries = draftTimetableEntryRepository.findByGenerationWithRelations(generationId)
  result.entries = entries.length
  result.labsScheduled = entries.filter((e) => e.classType === 'LAB').length
  if (entries.length === 0) {
    result.errors.push('The draft contains no entries, so it cannot be published.')
    return result
  }

  const data = loadAllData(generation.academicYearId)
  const orderedSlots = data.orderedSlots
  const slotById = new Map(orderedSlots.map((s) => [s.id, s]))
  const workingDays = new Set<string>(data.days)
  const hours = data.workingHours
  const breakStart = timeToMinutes(hours.breakStart)
  const breakEnd = timeToMinutes(hours.breakEnd)
  const startLimit = timeToMinutes(hours.startTime)
  const endLimit = timeToMinutes(hours.endTime)

  type Occurrence = { entryId: string; label: string; kind: 'section' | 'faculty' | 'room' }
  const occupancy = new Map<string, Occurrence[]>()
  const reportedClashes = new Set<string>()

  const sectionsById = new Map(data.sections.map((s) => [s.id, s]))
  const subjectsById = new Map(data.subjects.map((s) => [s.id, s]))
  const activeFaculty = new Set(data.faculty.map((f) => f.id))
  const nonTeachingFaculty = new Set(
    data.faculty.filter((f) => f.staffType === 'NON_TEACHING').map((f) => f.id)
  )

  const allocationsByKey = new Map<string, { facultyId: string; allocationId: string }[]>()
  for (const a of data.allocations) {
    const key = `${a.sectionId}|${a.subjectId}|${a.classType}`
    const list = allocationsByKey.get(key) ?? []
    list.push({ facultyId: a.facultyId, allocationId: a.id })
    allocationsByKey.set(key, list)
  }

  for (const entry of entries) {
    const sectionName = sectionsById.get(entry.sectionId)?.name ?? 'Unknown section'
    const subjectName = subjectsById.get(entry.subjectId)?.name ?? 'Unknown subject'
    const label = `${entry.dayOfWeek} ${describeEntry(entry, slotById)}`
    const where = `${sectionName} · ${subjectName}`
    const facultyIds = entry.facultyList?.map((f) => f.id) ?? []
    const roomIds = (entry.roomList ?? []).map((r) => r.id)

    if (!workingDays.has(entry.dayOfWeek)) {
      result.errors.push(`${where}: ${entry.dayOfWeek} is not a configured working day.`)
    }

    const slot = slotById.get(entry.timeSlotId)
    if (!slot) {
      result.errors.push(`${where}: the assigned time period no longer exists.`)
      continue
    }

    if (!Number.isInteger(entry.span) || entry.span < 1) {
      result.errors.push(`${where}: duration must be a whole number of periods (at least 1).`)
      continue
    }

    const covered = resolveCoveredSlots(entry.timeSlotId, entry.span)
    if ('error' in covered) {
      result.errors.push(`${where}: ${covered.error}`)
      continue
    }

    for (const s of covered.slots) {
      const overlapsBreak =
        timeToMinutes(s.startTime) < breakEnd && timeToMinutes(s.endTime) > breakStart
      if (s.isBreak || overlapsBreak) {
        result.errors.push(
          `${where}: ${label} crosses the break (${hours.breakStart}–${hours.breakEnd}); sessions must never span the break.`
        )
        break
      }
    }

    const startMin = timeToMinutes(slot.startTime)
    const endSlot = covered.slots[covered.slots.length - 1]
    const endMin = timeToMinutes(endSlot.endTime)
    if (startMin < startLimit || endMin > endLimit) {
      result.errors.push(
        `${where}: ${label} lies outside the configured working hours (${hours.startTime}–${hours.endTime}).`
      )
    }

    if (!sectionsById.has(entry.sectionId)) {
      result.errors.push(`${where}: the section no longer exists.`)
    }
    if (!subjectsById.has(entry.subjectId)) {
      result.errors.push(`${where}: the subject no longer exists.`)
    }

    // Faculty must be active and actually allocated to this activity.
    const key = `${entry.sectionId}|${entry.subjectId}|${entry.classType}`
    const allocated = allocationsByKey.get(key) ?? []
    const allocatedIds = new Set(allocated.map((a) => a.facultyId))
    for (const fid of facultyIds) {
      if (!activeFaculty.has(fid)) {
        result.errors.push(
          `${where}: a scheduled faculty member (${fid}) is inactive or was deleted.`
        )
      } else if (nonTeachingFaculty.has(fid)) {
        result.errors.push(
          `${where}: ${data.faculty.find((f) => f.id === fid)?.name ?? 'A faculty member'} is non-teaching staff and can never be scheduled.`
        )
      } else if (!allocatedIds.has(fid)) {
        result.errors.push(
          `${where}: ${data.faculty.find((f) => f.id === fid)?.name ?? 'A faculty member'} is scheduled but has no teaching allocation for this activity.`
        )
      }
    }

    if (FACULTY_REQUIRED_CLASS_TYPES.includes(entry.classType) && facultyIds.length === 0) {
      result.errors.push(
        `${where}: ${entry.classType === 'LAB' ? 'labs' : 'lectures'} must have at least one faculty member.`
      )
    }

    if (entry.classType === 'LAB') {
      const labRoomCount = data.rooms.filter((r) => r.type === 'LAB').length
      if (labRoomCount > 0 && roomIds.length === 0) {
        // Hard parity with the generator, which refuses to place a lab
        // without a room while lab rooms exist — a draft containing one must
        // not publish on a mere warning.
        result.errors.push(`${where}: lab has no room assigned although lab rooms exist.`)
      }
      for (const room of entry.roomList ?? []) {
        if (room.type !== 'LAB') {
          result.errors.push(
            `${where}: lab is assigned to "${room.name}", which is not a laboratory room.`
          )
        }
      }
    }

    // Span-aware occupancy for section / faculty / room.
    const register = (occKey: string, occ: Occurrence) => {
      const list = occupancy.get(occKey) ?? []
      const clash = list.find((o) => o.entryId !== occ.entryId)
      if (clash) {
        // One message per clashing pair + kind, not one per period of the span.
        const dedupe = `${clash.entryId}|${occ.entryId}|${occ.kind}`
        if (!reportedClashes.has(dedupe)) {
          reportedClashes.add(dedupe)
          result.errors.push(
            `${where}: ${clash.label} overlaps another activity (${occ.kind === 'section' ? 'the section is double-booked' : occ.kind === 'faculty' ? 'faculty double-booked' : 'room double-booked'}).`
          )
        }
      }
      list.push(occ)
      occupancy.set(occKey, list)
    }

    for (const s of covered.slots) {
      register(`${entry.sectionId}|${entry.dayOfWeek}|${s.id}`, {
        entryId: entry.id,
        label,
        kind: 'section',
      })
      for (const fid of facultyIds) {
        register(`${fid}|${entry.dayOfWeek}|${s.id}`, {
          entryId: entry.id,
          label,
          kind: 'faculty',
        })
      }
      for (const rid of roomIds) {
        register(`${rid}|${entry.dayOfWeek}|${s.id}`, {
          entryId: entry.id,
          label,
          kind: 'room',
        })
      }
    }
  }

  // Exact weekly counts vs. Subject Requirements.
  const requirements = data.requirements
  result.requiredSessions = requirements.reduce((sum, r) => sum + r.requiredSessionsPerWeek, 0)
  result.scheduledSessions = entries.length

  const scheduledByKey = new Map<string, DraftTimetableEntryWithRelations[]>()
  for (const entry of entries) {
    const key = `${entry.sectionId}|${entry.subjectId}|${entry.classType}`
    const list = scheduledByKey.get(key) ?? []
    list.push(entry)
    scheduledByKey.set(key, list)
  }

  for (const req of requirements) {
    const key = `${req.sectionId}|${req.subjectId}|${req.classType}`
    const scheduled = scheduledByKey.get(key) ?? []
    const sectionName = sectionsById.get(req.sectionId)?.name ?? 'Unknown section'
    const subjectName = subjectsById.get(req.subjectId)?.name ?? 'Unknown subject'

    if (scheduled.length !== req.requiredSessionsPerWeek) {
      result.missing.push({
        sectionName,
        subjectName,
        classType: req.classType,
        required: req.requiredSessionsPerWeek,
        scheduled: scheduled.length,
        span: req.span,
      })
      result.errors.push(
        `${sectionName} · ${subjectName} (${req.classType}): requires exactly ${req.requiredSessionsPerWeek} session(s)/week but the draft has ${scheduled.length}.`
      )
    }

    for (const entry of scheduled) {
      if (entry.span !== req.span) {
        result.errors.push(
          `${sectionName} · ${subjectName} (${req.classType}): session is ${entry.span} period(s) but the requirement specifies ${req.span}.`
        )
      }
    }

    // The configured teaching arrangement must hold on every session:
    //  - TEAM      → every allocated teacher is attached to every session,
    //  - ALTERNATE → exactly one teacher per session.
    // (AUTO resolves through the same helper the scheduler uses.)
    const poolIds = (allocationsByKey.get(key) ?? [])
      .filter((a) => activeFaculty.has(a.facultyId) && !nonTeachingFaculty.has(a.facultyId))
      .map((a) => a.facultyId)
    const arrangement = effectiveTeachingArrangement(req, poolIds.length)
    if (poolIds.length > 0 && (arrangement === 'TEAM' || arrangement === 'ALTERNATE')) {
      for (const entry of scheduled) {
        const entryFaculty = entry.facultyList?.map((f) => f.id) ?? []
        if (arrangement === 'TEAM') {
          const missing = poolIds.filter((id) => !entryFaculty.includes(id))
          if (missing.length > 0) {
            const names = missing
              .map((id) => data.faculty.find((f) => f.id === id)?.name ?? id)
              .join(', ')
            result.errors.push(
              `${sectionName} · ${subjectName} (${req.classType}): ${entry.dayOfWeek} teaching-team session is missing ${names} — every allocated teacher must be attached to each session.`
            )
          }
        } else if (entryFaculty.length > 1) {
          result.errors.push(
            `${sectionName} · ${subjectName} (${req.classType}): alternate teaching means exactly one teacher per session, but ${entryFaculty.length} teachers are attached.`
          )
        }
      }
    }
  }

  for (const [key, scheduled] of scheduledByKey) {
    if (requirements.some((r) => `${r.sectionId}|${r.subjectId}|${r.classType}` === key)) continue
    const sectionName = sectionsById.get(scheduled[0].sectionId)?.name ?? 'Unknown section'
    const subjectName = subjectsById.get(scheduled[0].subjectId)?.name ?? 'Unknown subject'
    result.errors.push(
      `${sectionName} · ${subjectName} (${scheduled[0].classType}): draft contains ${scheduled.length} session(s) but no Subject Requirement defines them.`
    )
  }

  result.valid = result.errors.length === 0
  return result
}

function describeEntry(
  entry: DraftTimetableEntryWithRelations,
  slotById: Map<string, TimeSlot>
): string {
  const slot = slotById.get(entry.timeSlotId)
  if (!slot) return entry.timeSlotId
  const covered = resolveCoveredSlots(entry.timeSlotId, entry.span)
  if ('error' in covered) return `${slot.startTime}–${slot.endTime}`
  const first = covered.slots[0]
  const last = covered.slots[covered.slots.length - 1]
  return `${first.startTime}–${last.endTime}`
}

// ---------------------------------------------------------------------------
// Public API — transactional publication
// ---------------------------------------------------------------------------

/**
 * Publish a validated draft as the master timetable for its academic year.
 *
 * Inside ONE transaction:
 *  1. re-validate the draft independently (reject anything invalid),
 *  2. replace only the entries of sections the draft covers — entries of
 *     unrelated sections, audit records and substitution runs are preserved,
 *  3. re-home historical substitution assignments onto the replacement entry
 *     of the same section/day/period (or report them as superseded instead of
 *     letting them vanish silently),
 *  4. verify the new entries against the preserved ones (no faculty/section/
 *     room double-booking across covered and uncovered sections),
 *  5. write an audit entry.
 * Any error rolls the transaction back — the previously published timetable
 * stays exactly as it was.
 */
export function publishDraftTimetable(generationId: string): PublishResult {
  const generation = timetableGenerationRepository.findById(generationId)
  if (!generation) {
    throw new Error('This generation no longer exists.')
  }
  if (generation.status !== 'COMPLETED') {
    throw new Error('Only a successfully completed generation can be published.')
  }
  if (draftTimetableEntryRepository.hasPublishedEntries(generationId)) {
    // Re-publish guard: the first publish already replaced the covered
    // sections. Running again would re-delete and re-insert the very entries
    // it created and write a duplicate audit row — refuse instead, touching
    // nothing.
    throw new Error(
      'This draft has already been published to the master timetable. Re-publishing is blocked so the current timetable, substitution history and audit trail stay intact — run a new generation if the requirements changed.'
    )
  }

  const validation = validateDraftTimetable(generationId)
  if (!validation.valid) {
    throw new Error(
      `This draft failed validation and cannot be published:\n${validation.errors
        .slice(0, 8)
        .join('\n')}`
    )
  }

  const draft = draftTimetableEntryRepository.findByGenerationWithRelations(generationId)
  const academicYearId = generation.academicYearId
  const coveredSections = new Set(draft.map((d) => d.sectionId))
  const db = getDatabase()

  db.exec('BEGIN')
  try {
    const oldEntries = timetableEntryRepository.findByAcademicYear(academicYearId)
    const toReplace = oldEntries.filter((e) => coveredSections.has(e.sectionId))
    const toKeep = oldEntries.filter((e) => !coveredSections.has(e.sectionId))

    // Guard: the draft must not clash with entries of sections it does not
    // cover (those rows survive publication).
    const conflicts = findConflictsBetweenDraftAndExisting(draft, toKeep, generationId)
    if (conflicts.length > 0) {
      throw new Error(
        `Publishing would double-book something kept from the current timetable:\n${conflicts
          .slice(0, 5)
          .join('\n')}`
      )
    }

    // Capture historical substitution assignments BEFORE their entries are
    // replaced (deleting an entry cascades its assignments away).
    const oldIds = toReplace.map((e) => e.id)
    const captured: {
      id: string
      run_id: string
      original_entry_id: string
      substitute_faculty_id: string | null
      status: string
      score: number | null
      reasoning: string | null
      is_locked: number
      created_at: string
      updated_at: string
    }[] = []
    if (oldIds.length > 0) {
      const ph = oldIds.map(() => '?').join(', ')
      const rows = db
        .prepare(
          `SELECT id, run_id, original_entry_id, substitute_faculty_id, status, score, reasoning,
                  is_locked, created_at, updated_at
           FROM substitution_assignments WHERE original_entry_id IN (${ph})`
        )
        .all(...oldIds) as typeof captured
      captured.push(...rows)
    }

    // New entry per replaced cell (same section + day + period).
    const newIdByCell = new Map<string, string>()
    for (const entry of draft) {
      newIdByCell.set(cellKey(entry.sectionId, entry.dayOfWeek, entry.timeSlotId), newId())
    }

    // Replace entries (join tables cascade with the entry row).
    for (const entry of toReplace) {
      timetableEntryRepository.delete(entry.id)
    }

    // Insert the draft as the new master timetable.
    for (const entry of draft) {
      timetableEntryRepository.create({
        id: newIdByCell.get(cellKey(entry.sectionId, entry.dayOfWeek, entry.timeSlotId))!,
        academicYearId,
        dayOfWeek: entry.dayOfWeek,
        timeSlotId: entry.timeSlotId,
        sectionId: entry.sectionId,
        subjectId: entry.subjectId,
        classType: entry.classType,
        span: entry.span,
        facultyIds: entry.facultyList?.map((f) => f.id) ?? [],
        roomIds: (entry.roomList ?? []).map((r) => r.id),
      })
    }

    // Re-home or explicitly account for historical substitution assignments.
    let remapped = 0
    let superseded = 0
    const supersededRuns = new Set<string>()
    for (const row of captured) {
      const oldEntry = toReplace.find((e) => e.id === row.original_entry_id)
      const replacement = oldEntry
        ? newIdByCell.get(cellKey(oldEntry.sectionId, oldEntry.dayOfWeek, oldEntry.timeSlotId))
        : undefined
      if (replacement) {
        db.prepare(
          `INSERT INTO substitution_assignments
             (id, run_id, original_entry_id, substitute_faculty_id, status, score, reasoning,
              is_locked, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(
          row.id,
          row.run_id,
          replacement,
          row.substitute_faculty_id,
          row.status,
          row.score,
          row.reasoning,
          row.is_locked,
          row.created_at,
          row.updated_at
        )
        remapped++
      } else {
        superseded++
        supersededRuns.add(row.run_id)
      }
    }

    // Draft rows become PUBLISHED history of this generation.
    db.prepare(
      `UPDATE draft_timetable_entries SET status = 'PUBLISHED', updated_at = datetime('now')
       WHERE generation_id = ?`
    ).run(generationId)

    const detail = [
      `Published generation ${generationId}`,
      `${draft.length} entries across ${coveredSections.size} section(s)`,
      `${toReplace.length} prior entries replaced`,
      `${toKeep.length === 0 ? 0 : new Set(toKeep.map((e) => e.sectionId)).size} unrelated section(s) untouched`,
      remapped > 0 ? `${remapped} substitution record(s) kept against their replacement period` : null,
      superseded > 0
        ? `${superseded} substitution record(s) for periods no longer scheduled were superseded (runs retained)`
        : null,
    ]
      .filter(Boolean)
      .join('; ')

    auditLogRepository.record(
      AUDIT_ACTIONS.TIMETABLE_UPDATED,
      'timetable_generation',
      generationId,
      detail
    )

    db.exec('COMMIT')

    return {
      generationId,
      publishedEntries: draft.length,
      replacedEntries: toReplace.length,
      untouchedSections: new Set(toKeep.map((e) => e.sectionId)).size,
      substitutionRecordsRemapped: remapped,
      substitutionRecordsSuperseded: superseded,
    }
  } catch (error) {
    try {
      db.exec('ROLLBACK')
    } catch {
      // BEGIN may never have landed — nothing to roll back.
    }
    const raw = error instanceof Error ? error.message : String(error)
    if (/FOREIGN KEY constraint failed/i.test(raw)) {
      throw new Error(
        'Publishing failed because one of the referenced items was changed by someone else. The previous timetable was left untouched — reload and try again.'
      )
    }
    if (/UNIQUE constraint failed/i.test(raw)) {
      throw new Error(
        'Publishing failed because the draft collides with an existing entry. The previous timetable was left untouched.'
      )
    }
    console.error('[publishDraftTimetable]', error)
    throw new Error(
      `Publishing failed and was rolled back — the previous timetable is unchanged. ${raw}`
    )
  }
}

function cellKey(sectionId: string, day: string, slotId: string): string {
  return `${sectionId}|${day}|${slotId}`
}

function findConflictsBetweenDraftAndExisting(
  draft: DraftTimetableEntryWithRelations[],
  existing: { id: string; sectionId: string; dayOfWeek: string; timeSlotId: string; span: number; facultyIds: string[]; roomIds: string[] }[],
  _generationId: string
): string[] {
  void _generationId
  const problems: string[] = []

  for (const entry of draft) {
    const covered = resolveCoveredSlots(entry.timeSlotId, entry.span)
    if ('error' in covered) continue
    for (const slot of covered.slots) {
      for (const other of existing) {
        if (other.dayOfWeek !== entry.dayOfWeek) continue
        const otherCovered = resolveCoveredSlots(other.timeSlotId, other.span)
        if ('error' in otherCovered) continue
        const overlaps = otherCovered.slots.some((s) => s.id === slot.id)
        if (!overlaps) continue

        if (other.sectionId === entry.sectionId) {
          problems.push(
            `Section ${entry.sectionId} on ${entry.dayOfWeek} ${slot.startTime} is already occupied by a section this draft does not cover.`
          )
          continue
        }
        const myFaculty = entry.facultyList?.map((f) => f.id) ?? []
        const shared = myFaculty.filter((f) => other.facultyIds.includes(f))
        if (shared.length > 0) {
          problems.push(
            `Faculty ${shared.join(', ')} is already teaching on ${entry.dayOfWeek} ${slot.startTime} in a section kept from the current timetable.`
          )
        }
        const myRooms = (entry.roomList ?? []).map((r) => r.id)
        const sharedRooms = myRooms.filter((r) => other.roomIds.includes(r))
        if (sharedRooms.length > 0) {
          problems.push(
            `Room ${sharedRooms.join(', ')} is already booked on ${entry.dayOfWeek} ${slot.startTime} in a section kept from the current timetable.`
          )
        }
      }
    }
  }
  return Array.from(new Set(problems))
}

// ---------------------------------------------------------------------------
// Public API — status & history management
// ---------------------------------------------------------------------------

export function getGenerationStatus(generationId: string): GenerationStatusInfo | null {
  const generation = timetableGenerationRepository.findById(generationId)
  if (!generation) return null
  const summary = generationDiagnosticRepository.getSummaryByGeneration(generationId)
  const draftEntries = draftTimetableEntryRepository.findByGeneration(generationId).length
  const published = draftTimetableEntryRepository
    .findByGeneration(generationId)
    .some((e) => e.status === 'PUBLISHED')
  return {
    generation,
    draftEntries,
    diagnostics: {
      errors: summary.errors ?? 0,
      warnings: summary.warnings ?? 0,
      infos: summary.infos ?? 0,
    },
    published,
  }
}

/**
 * Recover generations left in RUNNING by an unexpected shutdown.
 *
 * A run only stays RUNNING while its synchronous solver executes inside this
 * process; the moment the process dies, that row can never transition again.
 * Recovery flips such rows to FAILED with an explicit "interrupted" summary —
 * it UPDATEs status/summary/completed_at only, so diagnostics, draft entries
 * and the constraints snapshot of the run are all preserved, and the published
 * timetable is never touched.
 *
 * Safety: rows of a generation currently in flight in this process are
 * skipped, so a genuinely active run can never be marked failed. Terminal
 * rows (COMPLETED/FAILED/CANCELLED) are never selected.
 *
 * Returns the ids actually recovered (for logging and tests).
 */
export function recoverStaleGenerations(): string[] {
  const recovered: string[] = []
  for (const generation of timetableGenerationRepository.findRunning()) {
    if (inFlightGenerations.has(generation.id)) continue
    timetableGenerationRepository.updateStatus(
      generation.id,
      'FAILED',
      'FAILED: interrupted — the application stopped before this run finished. Recovered automatically; its diagnostics and draft history are preserved and the published timetable was not affected.'
    )
    recovered.push(generation.id)
  }
  return recovered
}

/** Remove a generation run and its drafts/diagnostics. Never touches the published timetable. */
export function deleteGeneration(generationId: string): boolean {
  const generation = timetableGenerationRepository.findById(generationId)
  if (!generation) return false
  const db = getDatabase()
  db.exec('BEGIN')
  try {
    draftTimetableEntryRepository.deleteByGeneration(generationId)
    generationDiagnosticRepository.deleteByGeneration(generationId)
    timetableGenerationRepository.delete(generationId)
    auditLogRepository.record(
      AUDIT_ACTIONS.GENERATION_DELETED,
      'timetable_generation',
      generationId,
      'Generation run, its draft entries and diagnostics deleted (published timetable untouched)'
    )
    db.exec('COMMIT')
    return true
  } catch (error) {
    try {
      db.exec('ROLLBACK')
    } catch {
      // BEGIN never landed
    }
    console.error('[deleteGeneration]', error)
    throw new Error(
      'Could not delete this generation run. The published timetable was not affected.'
    )
  }
}

export type { GenerationStatus }

export interface DraftEditResult {
  success: boolean
  error?: string
}

/**
 * Move a draft entry to a new day and starting time slot.
 * Atomically validates:
 *  - Entry and generation exist, draft is not published
 *  - Target day is a configured working day
 *  - Target slot exists and span fits without exceeding day or crossing break
 *  - Moving multi-period lab moves the entire continuous span
 *  - Section is free across all covered slots
 *  - All assigned faculty are free across all covered slots
 *  - Any assigned room is free across all covered slots
 */
export function moveDraftEntry(
  generationId: string,
  entryId: string,
  targetDay: DayOfWeek,
  targetTimeSlotId: string
): DraftEditResult {
  const generation = timetableGenerationRepository.findById(generationId)
  if (!generation) {
    return { success: false, error: 'Generation does not exist.' }
  }
  if (draftTimetableEntryRepository.hasPublishedEntries(generationId)) {
    return { success: false, error: 'Cannot modify a draft that has already been published.' }
  }

  const entries = draftTimetableEntryRepository.findByGenerationWithRelations(generationId)
  const entry = entries.find((e) => e.id === entryId)
  if (!entry) {
    return { success: false, error: 'Draft entry not found.' }
  }

  if (entry.dayOfWeek === targetDay && entry.timeSlotId === targetTimeSlotId) {
    return { success: true }
  }

  const data = loadAllData(generation.academicYearId)
  if (!data.days.includes(targetDay)) {
    return { success: false, error: `${targetDay} is not a configured working day.` }
  }

  const slotById = new Map(data.orderedSlots.map((s) => [s.id, s]))
  const targetSlot = slotById.get(targetTimeSlotId)
  if (!targetSlot) {
    return { success: false, error: 'Target time period not found.' }
  }

  const span = Math.max(1, entry.span || 1)
  const covered = resolveCoveredSlots(targetTimeSlotId, span)
  if ('error' in covered) {
    return { success: false, error: covered.error }
  }

  // Check break overlap
  const hours = data.workingHours
  const breakStart = timeToMinutes(hours.breakStart)
  const breakEnd = timeToMinutes(hours.breakEnd)
  for (const s of covered.slots) {
    const overlapsBreak = timeToMinutes(s.startTime) < breakEnd && timeToMinutes(s.endTime) > breakStart
    if (s.isBreak || overlapsBreak) {
      return {
        success: false,
        error: `Cannot schedule session during or across the break (${hours.breakStart}–${hours.breakEnd}).`,
      }
    }
  }

  // Check working hours
  const startLimit = timeToMinutes(hours.startTime)
  const endLimit = timeToMinutes(hours.endTime)
  const startMin = timeToMinutes(targetSlot.startTime)
  const endSlot = covered.slots[covered.slots.length - 1]
  const endMin = timeToMinutes(endSlot.endTime)
  if (startMin < startLimit || endMin > endLimit) {
    return {
      success: false,
      error: `Session would fall outside configured working hours (${hours.startTime}–${hours.endTime}).`,
    }
  }

  // Check conflicts with other entries in this generation on targetDay
  const targetSlotIds = new Set(covered.slots.map((s) => s.id))
  const otherEntries = entries.filter((e) => e.id !== entryId && e.dayOfWeek === targetDay)
  const entryFacultyIds = new Set((entry.facultyList ?? []).map((f) => f.id))
  const entryRoomIds = new Set((entry.roomList ?? []).map((r) => r.id))

  for (const other of otherEntries) {
    const otherCovered = resolveCoveredSlots(other.timeSlotId, other.span)
    if ('error' in otherCovered) continue
    const overlaps = otherCovered.slots.some((s) => targetSlotIds.has(s.id))
    if (!overlaps) continue

    if (other.sectionId === entry.sectionId) {
      const secName = other.section?.name ?? 'This section'
      const subName = other.subject?.name ?? 'another class'
      return {
        success: false,
        error: `Section conflict: ${secName} already has ${subName} scheduled during this period.`,
      }
    }

    for (const fac of other.facultyList ?? []) {
      if (entryFacultyIds.has(fac.id)) {
        return {
          success: false,
          error: `Faculty conflict: ${fac.name} is already teaching ${other.subject?.name ?? 'a class'} (${other.section?.name ?? ''}) during this period.`,
        }
      }
    }

    for (const room of other.roomList ?? []) {
      if (entryRoomIds.has(room.id)) {
        return {
          success: false,
          error: `Room conflict: ${room.name} is already booked by ${other.section?.name ?? 'another section'} during this period.`,
        }
      }
    }
  }

  // Valid! Execute in transaction
  try {
    withTransaction(() => {
      getDatabase()
        .prepare(
          'UPDATE draft_timetable_entries SET day_of_week = ?, time_slot_id = ?, updated_at = datetime(\'now\') WHERE id = ?'
        )
        .run(targetDay, targetTimeSlotId, entryId)
    })
  } catch (err) {
    return {
      success: false,
      error: `Failed to move draft session: ${err instanceof Error ? err.message : String(err)}`,
    }
  }

  return { success: true }
}

/**
 * Swap two draft entries. Both entries swap their day and start time slot.
 * Atomically validates:
 *  - Both entries exist, belong to this generation, draft not published
 *  - Entry A fits into B's time slot/day across its full span
 *  - Entry B fits into A's time slot/day across its full span
 *  - Neither crosses the break or exceeds day boundaries
 *  - Section, faculty, and room availability for both new positions
 */
export function swapDraftEntries(
  generationId: string,
  entryIdA: string,
  entryIdB: string
): DraftEditResult {
  if (entryIdA === entryIdB) {
    return { success: true }
  }

  const generation = timetableGenerationRepository.findById(generationId)
  if (!generation) {
    return { success: false, error: 'Generation does not exist.' }
  }
  if (draftTimetableEntryRepository.hasPublishedEntries(generationId)) {
    return { success: false, error: 'Cannot modify a draft that has already been published.' }
  }

  const entries = draftTimetableEntryRepository.findByGenerationWithRelations(generationId)
  const entryA = entries.find((e) => e.id === entryIdA)
  const entryB = entries.find((e) => e.id === entryIdB)
  if (!entryA || !entryB) {
    return { success: false, error: 'One or both draft entries were not found.' }
  }

  const data = loadAllData(generation.academicYearId)
  const hours = data.workingHours
  const breakStart = timeToMinutes(hours.breakStart)
  const breakEnd = timeToMinutes(hours.breakEnd)
  const startLimit = timeToMinutes(hours.startTime)
  const endLimit = timeToMinutes(hours.endTime)

  // Target for A is B's slot and day
  const targetDayA = entryB.dayOfWeek
  const targetSlotIdA = entryB.timeSlotId
  const coveredA = resolveCoveredSlots(targetSlotIdA, entryA.span)
  if ('error' in coveredA) {
    return {
      success: false,
      error: `Cannot place ${entryA.subject?.name ?? 'activity A'} at target time: ${coveredA.error}`,
    }
  }

  for (const s of coveredA.slots) {
    const overlapsBreak = timeToMinutes(s.startTime) < breakEnd && timeToMinutes(s.endTime) > breakStart
    if (s.isBreak || overlapsBreak) {
      return { success: false, error: `Swapping would place ${entryA.subject?.name ?? 'activity'} across the break.` }
    }
  }
  const startMinA = timeToMinutes(coveredA.slots[0].startTime)
  const endMinA = timeToMinutes(coveredA.slots[coveredA.slots.length - 1].endTime)
  if (startMinA < startLimit || endMinA > endLimit) {
    return { success: false, error: `Swapping would place ${entryA.subject?.name ?? 'activity'} outside working hours.` }
  }

  // Target for B is A's slot and day
  const targetDayB = entryA.dayOfWeek
  const targetSlotIdB = entryA.timeSlotId
  const coveredB = resolveCoveredSlots(targetSlotIdB, entryB.span)
  if ('error' in coveredB) {
    return {
      success: false,
      error: `Cannot place ${entryB.subject?.name ?? 'activity B'} at target time: ${coveredB.error}`,
    }
  }

  for (const s of coveredB.slots) {
    const overlapsBreak = timeToMinutes(s.startTime) < breakEnd && timeToMinutes(s.endTime) > breakStart
    if (s.isBreak || overlapsBreak) {
      return { success: false, error: `Swapping would place ${entryB.subject?.name ?? 'activity'} across the break.` }
    }
  }
  const startMinB = timeToMinutes(coveredB.slots[0].startTime)
  const endMinB = timeToMinutes(coveredB.slots[coveredB.slots.length - 1].endTime)
  if (startMinB < startLimit || endMinB > endLimit) {
    return { success: false, error: `Swapping would place ${entryB.subject?.name ?? 'activity'} outside working hours.` }
  }

  // Other entries (excluding both A and B)
  const otherEntries = entries.filter((e) => e.id !== entryIdA && e.id !== entryIdB)
  const slotIdsA = new Set(coveredA.slots.map((s) => s.id))
  const slotIdsB = new Set(coveredB.slots.map((s) => s.id))

  const facultyIdsA = new Set((entryA.facultyList ?? []).map((f) => f.id))
  const roomIdsA = new Set((entryA.roomList ?? []).map((r) => r.id))
  const facultyIdsB = new Set((entryB.facultyList ?? []).map((f) => f.id))
  const roomIdsB = new Set((entryB.roomList ?? []).map((r) => r.id))

  // 1. Check A in its new slot against other entries
  for (const other of otherEntries.filter((e) => e.dayOfWeek === targetDayA)) {
    const otherCovered = resolveCoveredSlots(other.timeSlotId, other.span)
    if ('error' in otherCovered) continue
    if (!otherCovered.slots.some((s) => slotIdsA.has(s.id))) continue

    if (other.sectionId === entryA.sectionId) {
      return {
        success: false,
        error: `Section conflict: ${entryA.section?.name ?? ''} already has ${other.subject?.name ?? 'a class'} during ${targetDayA} period.`,
      }
    }
    for (const fac of other.facultyList ?? []) {
      if (facultyIdsA.has(fac.id)) {
        return {
          success: false,
          error: `Faculty conflict: ${fac.name} is already scheduled during ${targetDayA} period.`,
        }
      }
    }
    for (const room of other.roomList ?? []) {
      if (roomIdsA.has(room.id)) {
        return {
          success: false,
          error: `Room conflict: ${room.name} is already booked during ${targetDayA} period.`,
        }
      }
    }
  }

  // 2. Check B in its new slot against other entries
  for (const other of otherEntries.filter((e) => e.dayOfWeek === targetDayB)) {
    const otherCovered = resolveCoveredSlots(other.timeSlotId, other.span)
    if ('error' in otherCovered) continue
    if (!otherCovered.slots.some((s) => slotIdsB.has(s.id))) continue

    if (other.sectionId === entryB.sectionId) {
      return {
        success: false,
        error: `Section conflict: ${entryB.section?.name ?? ''} already has ${other.subject?.name ?? 'a class'} during ${targetDayB} period.`,
      }
    }
    for (const fac of other.facultyList ?? []) {
      if (facultyIdsB.has(fac.id)) {
        return {
          success: false,
          error: `Faculty conflict: ${fac.name} is already scheduled during ${targetDayB} period.`,
        }
      }
    }
    for (const room of other.roomList ?? []) {
      if (roomIdsB.has(room.id)) {
        return {
          success: false,
          error: `Room conflict: ${room.name} is already booked during ${targetDayB} period.`,
        }
      }
    }
  }

  // 3. Mutual conflicts between A and B if new slots overlap
  if (targetDayA === targetDayB) {
    const mutualOverlap = coveredA.slots.some((s) => slotIdsB.has(s.id))
    if (mutualOverlap) {
      if (entryA.sectionId === entryB.sectionId) {
        return { success: false, error: 'Cannot swap: activities would overlap for the same section.' }
      }
      for (const fid of facultyIdsA) {
        if (facultyIdsB.has(fid)) {
          return { success: false, error: 'Cannot swap: shared faculty would have overlapping periods.' }
        }
      }
      for (const rid of roomIdsA) {
        if (roomIdsB.has(rid)) {
          return { success: false, error: 'Cannot swap: shared room would have overlapping periods.' }
        }
      }
    }
  }

  // Valid! Execute in transaction using temporary state to satisfy UNIQUE constraints
  try {
    withTransaction(() => {
      const db = getDatabase()
      // Step 1: Park entry A at a temporary day to avoid immediate UNIQUE conflict if A and B share a section
      db.prepare('UPDATE draft_timetable_entries SET day_of_week = ? WHERE id = ?').run(
        '__TEMP_SWAPPING__',
        entryIdA
      )
      // Step 2: Move entry B into A's position
      db.prepare(
        'UPDATE draft_timetable_entries SET day_of_week = ?, time_slot_id = ?, updated_at = datetime(\'now\') WHERE id = ?'
      ).run(targetDayB, targetSlotIdB, entryIdB)
      // Step 3: Move entry A into B's position
      db.prepare(
        'UPDATE draft_timetable_entries SET day_of_week = ?, time_slot_id = ?, updated_at = datetime(\'now\') WHERE id = ?'
      ).run(targetDayA, targetSlotIdA, entryIdA)
    })
  } catch (err) {
    return {
      success: false,
      error: `Failed to swap draft sessions: ${err instanceof Error ? err.message : String(err)}`,
    }
  }

  return { success: true }
}

