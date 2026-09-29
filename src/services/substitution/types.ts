// Types for substitution engine (internal to the service)
import { TimetableEntryWithRelations, Faculty, TimeSlot, SubstitutionWeights } from '@/types'

/**
 * Candidate priority tier (applied AFTER the hard constraints, before score):
 *
 *  P1 — normally teaches the affected section/class
 *  P2 — normally teaches the same semester/year
 *  P3 — same department and normally teaches another section
 *  P4 — otherwise related (subject qualification, class history, department)
 *  P5 — unrelated faculty (only considered when configuration permits it)
 */
export type PriorityTier = 1 | 2 | 3 | 4 | 5

export const PRIORITY_TIER_LABELS: Record<PriorityTier, string> = {
  1: 'P1 — normally teaches this class',
  2: 'P2 — normally teaches this semester',
  3: 'P3 — same department, teaches other classes',
  4: 'P4 — related faculty (subject / class history / department)',
  5: 'P5 — no relationship to this class',
}

export interface SubstitutionCandidate {
  faculty: Faculty
  score: number
  reasons: string[]
  warnings: string[]
  priorityTier: PriorityTier
}

export interface FacultyAvailability {
  facultyId: string
  busySlots: Set<string>
  substitutionCount: number
  consecutiveSlots: number
}

export interface SubstitutionProblem {
  date: string
  absentFacultyIds: string[]
  affectedEntries: TimetableEntryWithRelations[]
  allFaculty: Faculty[]
  timeSlots: TimeSlot[]
  weights: SubstitutionWeights
  maxDailySubstitutions: number
}

export interface SubstitutionAssignmentResult {
  originalEntryId: string
  substituteFacultyId: string | null
  score: number
  reasoning: string
  status: 'PENDING' | 'NO_CANDIDATE'
}

export interface UncoveredEntry {
  originalEntryId: string
  reason: string
  attemptedCandidates: SubstitutionCandidate[]
}

export interface SubstitutionSolution {
  assignments: SubstitutionAssignmentResult[]
  uncovered: UncoveredEntry[]
}