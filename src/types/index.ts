// Core domain types for SubstiFlow

export type DayOfWeek = 'MONDAY' | 'TUESDAY' | 'WEDNESDAY' | 'THURSDAY' | 'FRIDAY' | 'SATURDAY'

export type ClassType =
  | 'LECTURE'
  | 'LAB'
  | 'TUTORIAL'
  | 'LIBRARY'
  | 'MENTORING'
  | 'SKILL_BUILD'
  | 'COE'
  | 'OTHER'

/**
 * Activity types that are teaching activities: at least one faculty member
 * must be attached to the entry. Types NOT in this list (library, mentoring,
 * skill build, COE, tutorial, other) may legitimately have no faculty —
 * validation is tightened per type, never weakened globally.
 */
export const FACULTY_REQUIRED_CLASS_TYPES: readonly ClassType[] = ['LECTURE', 'LAB']

/** Configurable policy for partially-absent multi-faculty activities. */
export type MultiFacultyAbsencePolicy = 'TEAM_SUFFICIENT' | 'REPLACE_ABSENT'

/**
 * Staff distinction: teaching staff can be scheduled and asked to substitute;
 * non-teaching staff (officers, lab attendants, …) can never be assigned to a
 * teaching session nor offered as a substitute. The distinction is per person
 * in the Faculty page — nothing is inferred from names.
 */
export type StaffType = 'TEACHING' | 'NON_TEACHING'

export const STAFF_TYPES: readonly StaffType[] = ['TEACHING', 'NON_TEACHING']

export const STAFF_TYPE_LABELS: Record<StaffType, string> = {
  TEACHING: 'Teaching staff',
  NON_TEACHING: 'Non-teaching staff',
}

/**
 * How the teachers allocated to a Subject Requirement share its sessions:
 *
 *  - AUTO       — the historical rule: a lab with more than one allocated
 *                 teacher is a TEAM, everything else is ALTERNATE.
 *  - TEAM       — every allocated teacher teaches every session together
 *                 (e.g. a lab jointly run by three or five teachers).
 *  - ALTERNATE  — eligible teachers take separate sessions: exactly one
 *                 teacher per session.
 *
 * Explicitly configurable per requirement (language, specialization, Feature
 * Engineering, …) — never inferred from a subject's name.
 */
export type TeachingArrangement = 'AUTO' | 'TEAM' | 'ALTERNATE'

export const TEACHING_ARRANGEMENTS: readonly TeachingArrangement[] = ['AUTO', 'TEAM', 'ALTERNATE']

export const TEACHING_ARRANGEMENT_LABELS: Record<TeachingArrangement, string> = {
  AUTO: 'Automatic',
  TEAM: 'Team — every teacher on every session',
  ALTERNATE: 'Alternate — one teacher per session',
}

export type AttendanceStatus = 'PRESENT' | 'ABSENT'

export type SubstitutionStatus = 'PENDING' | 'APPROVED' | 'REJECTED' | 'LOCKED'

export interface TimeSlot {
  id: string
  name: string
  startTime: string // HH:mm format
  endTime: string   // HH:mm format
  order: number
  isBreak: boolean
}

export interface AcademicYear {
  id: string
  name: string
  startDate: string // YYYY-MM-DD
  endDate: string   // YYYY-MM-DD
  isActive: boolean
  createdAt: string
  updatedAt: string
}

export interface Department {
  id: string
  name: string
  code: string
  description?: string
  createdAt: string
  updatedAt: string
}

export interface Faculty {
  id: string
  name: string
  employeeId?: string
  departmentId: string
  isActive: boolean
  /** TEACHING (default) may be scheduled/substituted; NON_TEACHING never is. */
  staffType: StaffType
  maxDailySubstitutions: number
  priority: number // Lower = higher priority
  notes?: string
  createdAt: string
  updatedAt: string
}

export interface FacultySubject {
  facultyId: string
  subjectId: string
  proficiency: number // 1-5
}

export interface FacultySection {
  facultyId: string
  sectionId: string
}

export interface Subject {
  id: string
  name: string
  code: string
  departmentId: string
  defaultClassType: ClassType
  createdAt: string
  updatedAt: string
}

export interface Section {
  id: string
  name: string
  semester: number
  departmentId: string
  academicYearId: string
  createdAt: string
  updatedAt: string
}

export interface Room {
  id: string
  name: string
  capacity: number
  type: 'CLASSROOM' | 'LAB' | 'AUDITORIUM' | 'OTHER'
  departmentId?: string
  createdAt: string
  updatedAt: string
}

export interface TimetableEntry {
  id: string
  academicYearId: string
  dayOfWeek: DayOfWeek
  timeSlotId: string
  sectionId: string
  subjectId: string
  /** 0 = faculty-less activity; 1..N = teaching team (ordered, no duplicates). */
  facultyIds: string[]
  /** 0 = "Not specified"; 1..N rooms (ordered, position 0 = primary). */
  roomIds: string[]
  classType: ClassType
  /** Number of consecutive periods the activity occupies (1 = one period). */
  span: number
  createdAt: string
  updatedAt: string
}

export interface Attendance {
  id: string
  date: string // YYYY-MM-DD
  facultyId: string
  status: AttendanceStatus
  notes?: string
  createdAt: string
  updatedAt: string
}

export interface SubstitutionRule {
  id: string
  name: string
  description?: string
  weight: number
  isEnabled: boolean
  config: Record<string, unknown>
  createdAt: string
  updatedAt: string
}

export interface SubstitutionRun {
  id: string
  date: string // YYYY-MM-DD
  status: 'DRAFT' | 'GENERATED' | 'APPROVED' | 'PUBLISHED'
  generatedAt: string
  approvedAt?: string
  approvedBy?: string
  notes?: string
  createdAt?: string
  updatedAt?: string
}

export interface SubstitutionAssignment {
  id: string
  runId: string
  originalEntryId: string
  substituteFacultyId?: string
  status: SubstitutionStatus
  score?: number
  reasoning?: string
  isLocked: boolean
  createdAt: string
  updatedAt: string
}

export interface ApplicationSettings {
  id: string
  key: string
  value: string
  description?: string
  updatedAt: string
}

// Extended types with relations
export interface FacultyWithRelations extends Faculty {
  department?: Department
  subjects?: Subject[]
  sections?: Section[]
}

export interface TimetableEntryWithRelations extends TimetableEntry {
  dayOfWeek: DayOfWeek
  timeSlot?: TimeSlot
  section?: Section
  subject?: Subject
  /** Lead faculty (first team member) — null for faculty-less activities. */
  faculty?: Faculty
  /** Primary room (first) — undefined when no room is specified. */
  room?: Room
  /** Full teaching team in order (may be empty for faculty-less activities). */
  facultyList?: Faculty[]
  /** All rooms in order (may be empty). */
  roomList?: Room[]
}

/** A term / timetable validity window inside an academic year. */
export interface Term {
  id: string
  academicYearId: string
  name: string
  startDate: string // YYYY-MM-DD
  endDate: string // YYYY-MM-DD
  isActive: boolean
  createdAt: string
  updatedAt: string
}

/** One audit-trail record (who/what/when) for important actions. */
export interface AuditLogEntry {
  id: string
  action: string
  entityType: string
  entityId?: string
  detail?: string
  createdAt: string
}

export interface SubstitutionAssignmentWithRelations extends SubstitutionAssignment {
  originalEntry?: TimetableEntryWithRelations
  substituteFaculty?: Faculty
  run?: SubstitutionRun
}

export interface RevisedTimetableEntry {
  originalEntry: TimetableEntryWithRelations
  substitution?: SubstitutionAssignmentWithRelations
  isSubstituted: boolean
  substituteFaculty?: Faculty
}

// Scoring weights for substitution algorithm
export interface SubstitutionWeights {
  sameClass: number
  sameSemester: number
  sameDepartment: number
  subjectQualified: number
  teachesSameSubject: number
  freeDuringSlot: number
  lowSubCount: number
  taughtSectionBefore: number
  penaltyHighSubCount: number
  penaltyConsecutive: number
  penaltyCrossDepartment: number
}

// Default weights
export const DEFAULT_SUBSTITUTION_WEIGHTS: SubstitutionWeights = {
  sameClass: 100,
  sameSemester: 60,
  sameDepartment: 40,
  subjectQualified: 30,
  teachesSameSubject: 20,
  freeDuringSlot: 20,
  lowSubCount: 15,
  taughtSectionBefore: 10,
  penaltyHighSubCount: -30,
  penaltyConsecutive: -20,
  penaltyCrossDepartment: -50,
}

// Working hours config
export interface WorkingHoursConfig {
  startTime: string // HH:mm
  endTime: string   // HH:mm
  breakStart: string
  breakEnd: string
  slots: TimeSlot[]
}

export const DEFAULT_WORKING_HOURS: WorkingHoursConfig = {
  startTime: '09:00',
  endTime: '16:00',
  breakStart: '13:00',
  breakEnd: '14:00',
  slots: [
    { id: 'slot-1', name: '09:00-10:00', startTime: '09:00', endTime: '10:00', order: 1, isBreak: false },
    { id: 'slot-2', name: '10:00-11:00', startTime: '10:00', endTime: '11:00', order: 2, isBreak: false },
    { id: 'slot-3', name: '11:00-12:00', startTime: '11:00', endTime: '12:00', order: 3, isBreak: false },
    { id: 'slot-4', name: '12:00-13:00', startTime: '12:00', endTime: '13:00', order: 4, isBreak: false },
    { id: 'break', name: '13:00-14:00', startTime: '13:00', endTime: '14:00', order: 5, isBreak: true },
    { id: 'slot-5', name: '14:00-15:00', startTime: '14:00', endTime: '15:00', order: 6, isBreak: false },
    { id: 'slot-6', name: '15:00-16:00', startTime: '15:00', endTime: '16:00', order: 7, isBreak: false },
  ],
}

export const DAYS_OF_WEEK: { value: DayOfWeek; label: string; shortLabel: string }[] = [
  { value: 'MONDAY', label: 'Monday', shortLabel: 'Mon' },
  { value: 'TUESDAY', label: 'Tuesday', shortLabel: 'Tue' },
  { value: 'WEDNESDAY', label: 'Wednesday', shortLabel: 'Wed' },
  { value: 'THURSDAY', label: 'Thursday', shortLabel: 'Thu' },
  { value: 'FRIDAY', label: 'Friday', shortLabel: 'Fri' },
  { value: 'SATURDAY', label: 'Saturday', shortLabel: 'Sat' },
]

export const CLASS_TYPES: { value: ClassType; label: string }[] = [
  { value: 'LECTURE', label: 'Lecture' },
  { value: 'LAB', label: 'Lab' },
  { value: 'TUTORIAL', label: 'Tutorial' },
  { value: 'LIBRARY', label: 'Library' },
  { value: 'MENTORING', label: 'Mentoring' },
  { value: 'SKILL_BUILD', label: 'Skill Build' },
  { value: 'COE', label: 'COE' },
  { value: 'OTHER', label: 'Other' },
]

/** Human label for an activity type (falls back to the raw value). */
export function classTypeLabel(value: string): string {
  return CLASS_TYPES.find((t) => t.value === value)?.label ?? value
}

// ============================================================================
// PHASE 1: TEACHING ALLOCATIONS & AUTOMATIC TIMETABLE GENERATION
// ============================================================================

/** Teaching Allocation — Faculty × Section × Subject × ClassType + weekly session count. */
export interface TeachingAllocation {
  id: string
  academicYearId: string
  facultyId: string
  sectionId: string
  subjectId: string
  classType: ClassType
  requiredSessionsPerWeek: number
  createdAt: string
  updatedAt: string
}

/** Teaching Allocation with relations for UI display. */
export interface TeachingAllocationWithRelations extends TeachingAllocation {
  faculty?: Faculty
  section?: Section
  subject?: Subject
}

/** Subject Requirement — Section + Subject + ClassType + required weekly sessions + span. */
export interface SubjectRequirement {
  id: string
  academicYearId: string
  sectionId: string
  subjectId: string
  classType: ClassType
  requiredSessionsPerWeek: number
  span: number
  /** How allocated teachers share the sessions (see {@link TeachingArrangement}). */
  teachingArrangement: TeachingArrangement
  createdAt: string
  updatedAt: string
}

/** Subject Requirement with relations for UI display. */
export interface SubjectRequirementWithRelations extends SubjectRequirement {
  section?: Section
  subject?: Subject
}

/** Subject Requirement input for create/update. */
export interface SubjectRequirementInput {
  academicYearId: string
  sectionId: string
  subjectId: string
  classType: ClassType
  requiredSessionsPerWeek: number
  span: number
  /** Omitted = AUTO (the historical behaviour). */
  teachingArrangement?: TeachingArrangement
}

/** Timetable Generation run. */
export interface TimetableGeneration {
  id: string
  academicYearId: string
  status: 'PENDING' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'CANCELLED'
  constraintsSnapshot: Record<string, unknown>
  diagnosticsSummary?: string
  createdAt: string
  updatedAt: string
  completedAt?: string
}

/** Draft Timetable Entry — generator output (DRAFT timetable). */
export interface DraftTimetableEntry {
  id: string
  generationId: string
  academicYearId: string
  dayOfWeek: DayOfWeek
  timeSlotId: string
  sectionId: string
  subjectId: string
  classType: ClassType
  span: number
  status: 'DRAFT' | 'PUBLISHED'
  createdAt: string
  updatedAt: string
}

/** Draft Timetable Entry with relations. */
export interface DraftTimetableEntryWithRelations extends DraftTimetableEntry {
  dayOfWeek: DayOfWeek
  timeSlot?: TimeSlot
  section?: Section
  subject?: Subject
  facultyList?: Faculty[]
  roomList?: Room[]
}

/** Generation Diagnostic — explanation for failed/uncovered activities. */
export interface GenerationDiagnostic {
  id: string
  generationId: string
  /** The allocation the problem is tied to; null when it is a global/requirement-level problem. */
  teachingAllocationId: string | null
  severity: 'ERROR' | 'WARNING' | 'INFO'
  code: string
  message: string
  details?: string
  createdAt: string
}

/** Timetable Generation with relations. */
export interface TimetableGenerationWithRelations extends TimetableGeneration {
  academicYear?: AcademicYear
}

/** Teaching Allocation input for create/update. */
export interface TeachingAllocationInput {
  academicYearId: string
  facultyId: string
  sectionId: string
  subjectId: string
  classType: ClassType
  requiredSessionsPerWeek: number
}

/** Generation constraints snapshot for reproducibility. */
export interface GenerationConstraintsSnapshot {
  timeSlots: TimeSlot[]
  sections: Section[]
  faculty: Faculty[]
  rooms: Room[]
  teachingAllocations: TeachingAllocation[]
  workingHours: WorkingHoursConfig
  multiFacultyAbsencePolicy: MultiFacultyAbsencePolicy
  maxDailySubstitutions: Record<string, number>
}

/** Generation status for UI. */
export type GenerationStatus = 'PENDING' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'CANCELLED'

/** Generation diagnostic severity. */
export type DiagnosticSeverity = 'ERROR' | 'WARNING' | 'INFO'

/** Diagnostic codes for common failure reasons. */
export enum GenerationDiagnosticCode {
  NO_QUALIFIED_FACULTY = 'NO_QUALIFIED_FACULTY',
  FACULTY_CONFLICT = 'FACULTY_CONFLICT',
  SECTION_CONFLICT = 'SECTION_CONFLICT',
  ROOM_CONFLICT = 'ROOM_CONFLICT',
  NO_VALID_WINDOW = 'NO_VALID_WINDOW',
  SPAN_CROSSES_BREAK = 'SPAN_CROSSES_BREAK',
  OUTSIDE_WORKING_HOURS = 'OUTSIDE_WORKING_HOURS',
  LAB_CROSSING_BREAK = 'LAB_CROSSING_BREAK',
  MULTI_FACULTY_CONFLICT = 'MULTI_FACULTY_CONFLICT',
  INSUFFICIENT_ROOMS = 'INSUFFICIENT_ROOMS',
  FACULTY_OVERLOADED = 'FACULTY_OVERLOADED',
  SECTION_OVERLOADED = 'SECTION_OVERLOADED',
  INSUFFICIENT_QUALIFIED_FACULTY_FOR_LAB = 'INSUFFICIENT_QUALIFIED_FACULTY_FOR_LAB',
  CONSTRAINT_UNSATISFIABLE = 'CONSTRAINT_UNSATISFIABLE',
  /** Configuration problem detected before any search was attempted. */
  INPUT_INVALID = 'INPUT_INVALID',
  /** Attempt or time limit reached — the search did not exhaust the space. */
  SEARCH_LIMIT_REACHED = 'SEARCH_LIMIT_REACHED',
}

/** Generation result. */
export interface GenerationResult {
  generationId: string
  status: GenerationStatus
  assignments: DraftTimetableEntry[]
  diagnostics: GenerationDiagnostic[]
  statistics: {
    totalAllocations: number
    scheduled: number
    uncovered: number
    errors: number
    warnings: number
    /** Weekly lab sessions among the scheduled assignments. */
    labs?: number
  }
  diagnosticsSummary?: string
  /** Search effort actually spent (bounds come from app settings). */
  search?: {
    attempts: number
    elapsedMs: number
    limitAttempts: number
    limitTimeoutMs: number
    stopReason: 'attempts' | 'timeout' | 'exhausted' | null
  }
}

/** Draft timetable entry with faculty/room relations. */
export interface DraftTimetableEntryWithRelations extends DraftTimetableEntry {
  dayOfWeek: DayOfWeek
  timeSlot?: TimeSlot
  section?: Section
  subject?: Subject
  facultyList?: Faculty[]
  roomList?: Room[]
}