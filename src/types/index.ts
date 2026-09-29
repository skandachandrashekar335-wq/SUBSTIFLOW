// Core domain types for SubstiFlow

export type DayOfWeek = 'MONDAY' | 'TUESDAY' | 'WEDNESDAY' | 'THURSDAY' | 'FRIDAY' | 'SATURDAY'

export type ClassType = 'LECTURE' | 'LAB' | 'TUTORIAL' | 'OTHER'

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
  facultyId: string
  roomId: string
  classType: ClassType
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
  faculty?: Faculty
  room?: Room
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
  { value: 'OTHER', label: 'Other' },
]