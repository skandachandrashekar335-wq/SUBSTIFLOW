import { 
  SubstitutionAssignment, 
  SubstitutionRun,
  SubstitutionAssignmentWithRelations,
  RevisedTimetableEntry,
  Faculty,
  TimeSlot,
  DayOfWeek,
} from '@/types'
import { 
  substitutionRunRepository, 
  substitutionAssignmentRepository, 
  facultyRepository, 
  attendanceRepository,
  timetableEntryRepository,
} from '@/db/repositories'
import { generateSubstitutionPlan, saveSubstitutionRun } from './engine'
import { getDatabase } from '@/db/database'
import { UncoveredEntry } from './types'

export interface SubstitutionResult {
  runId: string
  date: string
  assignments: SubstitutionAssignmentWithRelations[]
  uncovered: UncoveredEntry[]
  affectedEntries: any[]
  statistics: {
    totalAffected: number
    covered: number
    uncovered: number
    manuallyAssigned: number
  }
}

/**
 * Generate substitution plan for a specific date
 */
export function generateSubstitutions(date: string): SubstitutionResult {
  const db = getDatabase()
  const academicYear = db.prepare('SELECT * FROM academic_years WHERE is_active = 1 LIMIT 1').get() as { id: string } | undefined
  
  if (!academicYear) {
    throw new Error('No active academic year found')
  }

  const plan = generateSubstitutionPlan(date, academicYear.id)
  const runId = saveSubstitutionRun(date, plan.assignments, plan.uncovered)
  const assignments = substitutionAssignmentRepository.findByRunWithRelations(runId)
  
  return {
    runId,
    date,
    assignments,
    uncovered: plan.uncovered,
    affectedEntries: plan.affectedEntries,
    statistics: {
      totalAffected: plan.affectedEntries.length,
      covered: plan.assignments.filter(a => a.substituteFacultyId).length,
      uncovered: plan.uncovered.length,
      manuallyAssigned: 0,
    },
  }
}

/**
 * Get substitution run for a date
 */
export function getSubstitutionRun(date: string): SubstitutionResult | null {
  const run = substitutionRunRepository.findByDate(date)
  if (!run) return null

  const assignments = substitutionAssignmentRepository.findByRunWithRelations(run.id)
  
  const db = getDatabase()
  const academicYear = db.prepare('SELECT * FROM academic_years WHERE is_active = 1 LIMIT 1').get() as { id: string } | undefined
  
  let affectedEntries: any[] = []
  if (academicYear) {
    const dateObj = new Date(date + 'T00:00:00')
    const dayIndex = dateObj.getDay()
    const dayNames = ['SUNDAY', 'MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY']
    const dayOfWeek = dayNames[dayIndex]
    
    const absentFacultyIds = db.prepare('SELECT faculty_id FROM attendance WHERE date = ? AND status = ?').all(date, 'ABSENT') as { faculty_id: string }[]
    
    for (const { faculty_id } of absentFacultyIds) {
      const entries = db.prepare(`
        SELECT 
          te.*,
          ts.name as time_slot_name, ts.start_time, ts.end_time, ts."order" as slot_order, ts.is_break,
          sec.name as section_name, sec.semester, sec.department_id as section_department_id,
          s.name as subject_name, s.code as subject_code,
          f.name as faculty_name,
          r.name as room_name
        FROM timetable_entries te
        JOIN time_slots ts ON te.time_slot_id = ts.id
        JOIN sections sec ON te.section_id = sec.id
        JOIN subjects s ON te.subject_id = s.id
        JOIN faculty f ON te.faculty_id = f.id
        JOIN rooms r ON te.room_id = r.id
        WHERE te.faculty_id = ? AND te.day_of_week = ? AND te.academic_year_id = ?
      `).all(faculty_id, dayOfWeek, academicYear.id) as any[]
      
      for (const row of entries) {
        if (!row.is_break) {
          affectedEntries.push({
            id: row.id,
            academicYearId: row.academic_year_id,
            dayOfWeek: row.day_of_week,
            timeSlotId: row.time_slot_id,
            sectionId: row.section_id,
            subjectId: row.subject_id,
            facultyId: row.faculty_id,
            roomId: row.room_id,
            classType: row.class_type,
            createdAt: row.created_at,
            updatedAt: row.updated_at,
            timeSlot: {
              id: row.time_slot_id,
              name: row.time_slot_name,
              startTime: row.start_time,
              endTime: row.end_time,
              order: row.slot_order,
              isBreak: Boolean(row.is_break),
            },
            section: {
              id: row.section_id,
              name: row.section_name,
              semester: row.semester,
              departmentId: row.section_department_id,
              academicYearId: row.academic_year_id,
              createdAt: '',
              updatedAt: '',
            },
            subject: {
              id: row.subject_id,
              name: row.subject_name,
              code: row.subject_code,
              departmentId: '',
              defaultClassType: row.class_type as any,
              createdAt: '',
              updatedAt: '',
            },
            faculty: {
              id: row.faculty_id,
              name: row.faculty_name,
              departmentId: '',
              isActive: true,
              maxDailySubstitutions: 2,
              priority: 0,
              createdAt: '',
              updatedAt: '',
            },
            room: {
              id: row.room_id,
              name: row.room_name,
              capacity: 0,
              type: 'CLASSROOM',
              createdAt: '',
              updatedAt: '',
            },
          })
        }
      }
    }
  }

  const uncovered: UncoveredEntry[] = assignments
    .filter((a) => !a.substituteFacultyId)
    .map((a) => ({
      originalEntryId: a.originalEntryId,
      reason: a.reasoning || 'NO SUBSTITUTE FOUND',
      attemptedCandidates: [],
    }))

  return {
    runId: run.id,
    date: run.date,
    assignments,
    uncovered,
    affectedEntries,
    statistics: {
      totalAffected: affectedEntries.length,
      covered: assignments.filter(a => a.substituteFacultyId).length,
      uncovered: uncovered.length,
      manuallyAssigned: assignments.filter(a => a.status === 'LOCKED').length,
    },
  }
}

/**
 * Approve substitution run
 */
export function approveSubstitutionRun(date: string, approvedBy: string): SubstitutionRun | null {
  const run = substitutionRunRepository.findByDate(date)
  if (!run) return null
  
  return substitutionRunRepository.approve(run.id, approvedBy)
}

/**
 * The slot a substitute is being considered for.
 */
export interface SubstituteSlot {
  date: string
  academicYearId: string
  dayOfWeek: string
  timeSlotId: string
  isBreak: boolean
  /** The entry being filled: covering *this* entry is the goal, not a conflict. */
  entryId?: string
  /** The assignment row being edited, so re-picking the same faculty stays legal. */
  excludeAssignmentId?: string
}

export interface SubstituteValidation {
  ok: boolean
  reason?: string
}

/**
 * Enforce the substitution engine's hard constraints on assignments made
 * *outside* generation.
 *
 * The generated plan is validated by `calculateSubstitutionScore` (absent,
 * busy, over-limit, break), but a manual override writes straight to the
 * database — without the same checks it can put a teacher into a class they
 * are already covering in that very slot, hand work to an absent teacher, or
 * blow past the daily limit.
 */
export function validateSubstitute(slot: SubstituteSlot, facultyId: string): SubstituteValidation {
  const faculty = facultyRepository.findById(facultyId)
  if (!faculty) return { ok: false, reason: 'That faculty member no longer exists.' }
  if (!faculty.isActive) return { ok: false, reason: `${faculty.name} is inactive.` }
  if (slot.isBreak) return { ok: false, reason: 'Classes cannot be substituted during the break.' }

  if (attendanceRepository.getAbsentFacultyIds(slot.date).includes(facultyId)) {
    return { ok: false, reason: `${faculty.name} is marked absent on ${slot.date}.` }
  }

  const teaching = timetableEntryRepository.findByFacultyAndDay(
    facultyId,
    slot.dayOfWeek as DayOfWeek,
    slot.academicYearId,
  )
  if (teaching.some((entry) => entry.timeSlotId === slot.timeSlotId)) {
    return { ok: false, reason: `${faculty.name} is already teaching another class during this slot.` }
  }

  const db = getDatabase()

  const covering = db.prepare(`
    SELECT sa.id, sa.original_entry_id, sec.name AS section_name
    FROM substitution_assignments sa
    JOIN substitution_runs sr ON sa.run_id = sr.id
    JOIN timetable_entries te ON sa.original_entry_id = te.id
    JOIN sections sec ON te.section_id = sec.id
    WHERE sr.date = ? AND sa.substitute_faculty_id = ? AND sa.status <> 'REJECTED'
      AND te.time_slot_id = ?
  `).all(slot.date, facultyId, slot.timeSlotId) as { id: string; original_entry_id: string; section_name: string }[]

  const other = covering.find(
    (row) => row.original_entry_id !== slot.entryId && row.id !== slot.excludeAssignmentId,
  )
  if (other) {
    return {
      ok: false,
      reason: `${faculty.name} is already substituting for ${other.section_name} in this slot.`,
    }
  }

  const assigned = db.prepare(`
    SELECT sa.id
    FROM substitution_assignments sa
    JOIN substitution_runs sr ON sa.run_id = sr.id
    WHERE sr.date = ? AND sa.substitute_faculty_id = ? AND sa.status <> 'REJECTED'
  `).all(slot.date, facultyId) as { id: string }[]

  const count = assigned.filter((row) => row.id !== slot.excludeAssignmentId).length
  const limit = faculty.maxDailySubstitutions ?? 0
  if (count >= limit) {
    return { ok: false, reason: `${faculty.name} is already at the daily limit of ${limit} substitution(s).` }
  }

  return { ok: true }
}

/**
 * Resolve the slot an existing assignment refers to (run date + entry).
 */
function slotForAssignment(assignmentId: string): SubstituteSlot | null {
  const assignment = substitutionAssignmentRepository.findById(assignmentId)
  if (!assignment) return null

  const run = substitutionRunRepository.findById(assignment.runId)
  if (!run) return null

  const relations = substitutionAssignmentRepository
    .findByRunWithRelations(run.id)
    .find((row) => row.id === assignmentId)
  const entry = relations?.originalEntry
  if (!entry) return null

  return {
    date: run.date,
    academicYearId: entry.academicYearId,
    dayOfWeek: entry.dayOfWeek,
    timeSlotId: entry.timeSlotId,
    isBreak: Boolean(entry.timeSlot?.isBreak),
    entryId: entry.id,
    excludeAssignmentId: assignmentId,
  }
}

/**
 * Validate a manual substitute choice for an existing assignment.
 */
export function validateSubstituteAssignment(
  assignmentId: string,
  substituteFacultyId: string
): SubstituteValidation {
  const slot = slotForAssignment(assignmentId)
  if (!slot) return { ok: false, reason: 'That substitution assignment could not be found.' }
  return validateSubstitute(slot, substituteFacultyId)
}

/**
 * Every active faculty member who may legally cover this assignment right now.
 * Used by the "Assign Substitute" picker so the list matches the constraints
 * `updateSubstitutionAssignment` enforces.
 */
export function availableSubstitutesForAssignment(assignmentId: string): Faculty[] {
  const slot = slotForAssignment(assignmentId)
  if (!slot) return []
  return facultyRepository.findActive().filter((faculty) => validateSubstitute(slot, faculty.id).ok)
}

/**
 * Update a single substitution assignment
 */
export function updateSubstitutionAssignment(
  assignmentId: string,
  updates: {
    substituteFacultyId?: string | null
    status?: 'PENDING' | 'APPROVED' | 'REJECTED' | 'LOCKED'
    isLocked?: boolean
    reasoning?: string
  }
): any {
  // A substitute chosen by hand must clear the same hard constraints as the
  // generated plan; `null` means the change was rejected.
  if (updates.substituteFacultyId) {
    const check = validateSubstituteAssignment(assignmentId, updates.substituteFacultyId)
    if (!check.ok) return null
  }

  const updated = substitutionAssignmentRepository.update(assignmentId, updates as any)
  if (!updated) return null
  
  const run = substitutionRunRepository.findById(updated.runId)
  if (!run) return null
  
  return substitutionAssignmentRepository.findByRunWithRelations(run.id).find(a => a.id === assignmentId) || null
}

/**
 * Lock/unlock assignment
 */
export function lockAssignment(assignmentId: string): any {
  const locked = substitutionAssignmentRepository.lock(assignmentId)
  if (!locked) return null
  
  const run = substitutionRunRepository.findById(locked.runId)
  if (!run) return null
  
  return substitutionAssignmentRepository.findByRunWithRelations(run.id).find(a => a.id === assignmentId) || null
}

export function unlockAssignment(assignmentId: string): any {
  const unlocked = substitutionAssignmentRepository.unlock(assignmentId)
  if (!unlocked) return null
  
  const run = substitutionRunRepository.findById(unlocked.runId)
  if (!run) return null
  
  return substitutionAssignmentRepository.findByRunWithRelations(run.id).find(a => a.id === assignmentId) || null
}

/**
 * Get revised timetable for a date (master + substitutions)
 */
export function getRevisedTimetable(date: string): RevisedTimetableEntry[] {
  const db = getDatabase()
  const academicYear = db.prepare('SELECT * FROM academic_years WHERE is_active = 1 LIMIT 1').get() as { id: string } | undefined
  
  if (!academicYear) return []

  const dateObj = new Date(date + 'T00:00:00')
  const dayIndex = dateObj.getDay()
  const dayNames = ['SUNDAY', 'MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY']
  const dayOfWeek = dayNames[dayIndex]
  
  const masterEntries = db.prepare(`
    SELECT 
      te.*,
      ts.name as time_slot_name, ts.start_time, ts.end_time, ts."order" as slot_order, ts.is_break,
      sec.name as section_name, sec.semester, sec.department_id as section_department_id,
      s.name as subject_name, s.code as subject_code,
      f.name as faculty_name, f.id as faculty_id,
      r.name as room_name, r.id as room_id
    FROM timetable_entries te
    JOIN time_slots ts ON te.time_slot_id = ts.id
    JOIN sections sec ON te.section_id = sec.id
    JOIN subjects s ON te.subject_id = s.id
    JOIN faculty f ON te.faculty_id = f.id
    JOIN rooms r ON te.room_id = r.id
    WHERE te.academic_year_id = ? AND te.day_of_week = ?
    ORDER BY ts."order"
  `).all(academicYear.id, dayOfWeek) as any[]

  const run = substitutionRunRepository.findByDate(date)
  const substitutions = run ? substitutionAssignmentRepository.findByRunWithRelations(run.id) : []
  const subMap = new Map(substitutions.map(s => [s.originalEntryId, s]))

  const revised: RevisedTimetableEntry[] = []

  for (const row of masterEntries) {
    const substitution = subMap.get(row.id)
    const isSubstituted = !!substitution && !!substitution.substituteFacultyId
    
    let substituteFaculty: Faculty | undefined
    if (isSubstituted && substitution.substituteFacultyId) {
      const fac = facultyRepository.findById(substitution.substituteFacultyId)
      if (fac) substituteFaculty = fac
    }

    revised.push({
      originalEntry: {
        id: row.id,
        academicYearId: row.academic_year_id,
        dayOfWeek: row.day_of_week,
        timeSlotId: row.time_slot_id,
        sectionId: row.section_id,
        subjectId: row.subject_id,
        facultyId: row.faculty_id,
        roomId: row.room_id,
        classType: row.class_type,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        timeSlot: {
          id: row.time_slot_id,
          name: row.time_slot_name,
          startTime: row.start_time,
          endTime: row.end_time,
          order: row.slot_order,
          isBreak: Boolean(row.is_break),
        },
        section: {
          id: row.section_id,
          name: row.section_name,
          semester: row.semester,
          departmentId: row.section_department_id,
          academicYearId: row.academic_year_id,
          createdAt: '',
          updatedAt: '',
        },
        subject: {
          id: row.subject_id,
          name: row.subject_name,
          code: row.subject_code,
          departmentId: '',
          defaultClassType: row.class_type as any,
          createdAt: '',
          updatedAt: '',
        },
        faculty: {
          id: row.faculty_id,
          name: row.faculty_name,
          departmentId: '',
          isActive: true,
          maxDailySubstitutions: 2,
          priority: 0,
          createdAt: '',
          updatedAt: '',
        },
        room: {
          id: row.room_id,
          name: row.room_name,
          capacity: 0,
          type: 'CLASSROOM',
          createdAt: '',
          updatedAt: '',
        },
      },
      substitution,
      isSubstituted,
      substituteFaculty,
    })
  }

  return revised
}

/**
 * Get all substitution runs
 */
export function getAllSubstitutionRuns(): SubstitutionRun[] {
  return substitutionRunRepository.findAll()
}

/**
 * Delete a substitution run
 */
export function deleteSubstitutionRun(date: string): boolean {
  const run = substitutionRunRepository.findByDate(date)
  if (!run) return false
  
  substitutionAssignmentRepository.deleteByRun(run.id)
  return substitutionRunRepository.delete(run.id)
}