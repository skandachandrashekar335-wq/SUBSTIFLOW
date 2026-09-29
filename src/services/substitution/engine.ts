import { 
  TimetableEntryWithRelations, 
  Faculty, 
  TimeSlot,
  SubstitutionWeights, 
  DEFAULT_SUBSTITUTION_WEIGHTS,
} from '@/types'
import { facultyRepository, attendanceRepository, substitutionAssignmentRepository, settingsRepository, timetableEntryRepository } from '@/db/repositories'
import { getEligibleCandidates } from './scoring'
import { getDatabase } from '@/db/database'
import { SubstitutionProblem, SubstitutionAssignmentResult, UncoveredEntry, FacultyAvailability, SubstitutionCandidate } from './types'

/**
 * Build faculty availability map for a given date
 */
export function buildFacultyAvailability(
  date: string,
  academicYearId: string,
  timeSlots: TimeSlot[],
  absentFacultyIds: Set<string>
): Map<string, FacultyAvailability> {
  const db = getDatabase()
  const availabilityMap = new Map<string, FacultyAvailability>()
  const allFaculty = facultyRepository.findActive()

  // Calculate day of week
  const dateObj = new Date(date + 'T00:00:00')
  const dayIndex = dateObj.getDay() // 0=Sun, 1=Mon...
  const dayNames = ['SUNDAY', 'MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY']
  const dayOfWeek = dayNames[dayIndex]

  for (const faculty of allFaculty) {
    if (absentFacultyIds.has(faculty.id)) {
      availabilityMap.set(faculty.id, {
        facultyId: faculty.id,
        busySlots: new Set(),
        substitutionCount: 0,
        consecutiveSlots: 0,
      })
      continue
    }

    // Get master timetable entries for this faculty on this day
    const teachingEntries = timetableEntryRepository.findByFacultyAndDay(faculty.id, dayOfWeek as any, academicYearId)
    const busySlots = new Set<string>()
    for (const entry of teachingEntries) {
      busySlots.add(entry.timeSlotId)
    }

    // Get existing approved substitutions for this date
    const existingSubs = db.prepare(`
      SELECT sa.*, te.time_slot_id
      FROM substitution_assignments sa
      JOIN substitution_runs sr ON sa.run_id = sr.id
      JOIN timetable_entries te ON sa.original_entry_id = te.id
      WHERE sr.date = ? AND sa.substitute_faculty_id = ? AND sa.status IN ('APPROVED', 'LOCKED')
    `).all(date, faculty.id) as { time_slot_id: string }[]

    for (const sub of existingSubs) {
      busySlots.add(sub.time_slot_id)
    }

    const substitutionCount = facultyRepository.getDailySubstitutionCount(faculty.id, date)

    // Calculate consecutive slots
    let consecutiveSlots = 0
    const sortedSlots = timeSlots.filter(s => !s.isBreak).sort((a, b) => a.order - b.order)
    for (const slot of sortedSlots) {
      if (busySlots.has(slot.id)) {
        consecutiveSlots++
      } else {
        consecutiveSlots = 0
      }
    }

    availabilityMap.set(faculty.id, {
      facultyId: faculty.id,
      busySlots,
      substitutionCount,
      consecutiveSlots,
    })
  }

  return availabilityMap
}

/**
 * Solve substitution problem using greedy algorithm with backtracking for conflicts
 * This is deterministic - same input always produces same output
 */
export function solveSubstitutionProblem(problem: SubstitutionProblem): {
  assignments: SubstitutionAssignmentResult[]
  uncovered: UncoveredEntry[]
} {
  const {
    date,
    absentFacultyIds,
    affectedEntries,
    allFaculty,
    timeSlots,
    weights,
    maxDailySubstitutions,
  } = problem

  const academicYearId = affectedEntries[0]?.academicYearId || ''
  const facultyAvailability = buildFacultyAvailability(date, academicYearId, timeSlots, new Set(absentFacultyIds))

  // Get candidates for each entry
  const entriesWithCandidates = affectedEntries.map(entry => {
    const candidates = getEligibleCandidates(entry, allFaculty, facultyAvailability, weights, {
      absentFacultyIds: new Set(absentFacultyIds),
      lockedAssignments: new Map(),
    })
    return { entry, candidates: candidates.length, candidateList: candidates }
  })

  // Sort by number of candidates (ascending - hardest first), then by entry ID for determinism
  entriesWithCandidates.sort((a, b) => {
    if (a.candidates !== b.candidates) return a.candidates - b.candidates
    return a.entry.id.localeCompare(b.entry.id)
  })

  const assignments: SubstitutionAssignmentResult[] = []
  const uncovered: UncoveredEntry[] = []
  const usedFacultySlots = new Map<string, Set<string>>()
  const facultySubCounts = new Map<string, number>()

  for (const [facultyId, avail] of facultyAvailability) {
    usedFacultySlots.set(facultyId, new Set(avail.busySlots))
    facultySubCounts.set(facultyId, avail.substitutionCount)
  }

  // Try to assign each entry
  for (const { entry, candidateList } of entriesWithCandidates) {
    let assigned = false

    for (const candidate of candidateList) {
      const facultyId = candidate.faculty.id
      const timeSlotId = entry.timeSlotId

      if (usedFacultySlots.get(facultyId)?.has(timeSlotId)) continue
      const currentCount = facultySubCounts.get(facultyId) || 0
      if (currentCount >= maxDailySubstitutions) continue

      // Explainability: when subject-qualified faculty from other classes were
      // outranked by class familiarity, say so explicitly in the reasoning.
      const qualifiedOutranked = candidateList.filter(
        c =>
          c.priorityTier > candidate.priorityTier &&
          c.reasons.some(r => r.includes('Qualified for'))
      )
      let reasoning = candidate.reasons.join('; ')
      if (qualifiedOutranked.length > 0) {
        reasoning +=
          `; Class familiarity (P${candidate.priorityTier}) prioritized over ${qualifiedOutranked.length}` +
          ' subject-qualified candidate(s) teaching other classes, per configured rules'
      }

      assignments.push({
        originalEntryId: entry.id,
        substituteFacultyId: facultyId,
        score: candidate.score,
        reasoning,
        status: 'PENDING',
      })

      usedFacultySlots.get(facultyId)!.add(timeSlotId)
      facultySubCounts.set(facultyId, currentCount + 1)
      assigned = true
      break
    }

    if (!assigned) {
      uncovered.push({
        originalEntryId: entry.id,
        reason: 'No eligible faculty available',
        attemptedCandidates: candidateList.slice(0, 5),
      })
    }
  }

  // Restore original order for output
  const dayOrder = ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY']
  assignments.sort((a, b) => {
    const entryA = affectedEntries.find(e => e.id === a.originalEntryId)
    const entryB = affectedEntries.find(e => e.id === b.originalEntryId)
    if (!entryA || !entryB) return 0
    
    const dayA = dayOrder.indexOf(entryA.dayOfWeek)
    const dayB = dayOrder.indexOf(entryB.dayOfWeek)
    if (dayA !== dayB) return dayA - dayB
    
    const slotA = timeSlots.find(s => s.id === entryA.timeSlotId)?.order || 0
    const slotB = timeSlots.find(s => s.id === entryB.timeSlotId)?.order || 0
    return slotA - slotB
  })

  return { assignments, uncovered }
}

/**
 * Main entry point: Generate substitution plan for a date
 */
export function generateSubstitutionPlan(date: string, academicYearId: string): {
  assignments: SubstitutionAssignmentResult[]
  uncovered: UncoveredEntry[]
  affectedEntries: TimetableEntryWithRelations[]
} {
  // Get absent faculty
  const absentFacultyIds = new Set(attendanceRepository.getAbsentFacultyIds(date))
  
  if (absentFacultyIds.size === 0) {
    return { assignments: [], uncovered: [], affectedEntries: [] }
  }

  // Get day of week
  const dateObj = new Date(date + 'T00:00:00')
  const dayIndex = dateObj.getDay()
  const dayNames = ['SUNDAY', 'MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY']
  const dayOfWeek = dayNames[dayIndex]

  // Get affected timetable entries
  const affectedEntries: TimetableEntryWithRelations[] = []
  const db = getDatabase()
  
  for (const facultyId of absentFacultyIds) {
    const entries = timetableEntryRepository.findByFacultyAndDay(facultyId, dayOfWeek as any, academicYearId)
    for (const entry of entries) {
      const withRelations = db.prepare(`
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
        WHERE te.id = ?
      `).get(entry.id) as any
      
      if (withRelations && !withRelations.is_break) {
        affectedEntries.push({
          id: withRelations.id,
          academicYearId: withRelations.academic_year_id,
          dayOfWeek: withRelations.day_of_week,
          timeSlotId: withRelations.time_slot_id,
          sectionId: withRelations.section_id,
          subjectId: withRelations.subject_id,
          facultyId: withRelations.faculty_id,
          roomId: withRelations.room_id,
          classType: withRelations.class_type,
          createdAt: withRelations.created_at,
          updatedAt: withRelations.updated_at,
          timeSlot: {
            id: withRelations.time_slot_id,
            name: withRelations.time_slot_name,
            startTime: withRelations.start_time,
            endTime: withRelations.end_time,
            order: withRelations.slot_order,
            isBreak: Boolean(withRelations.is_break),
          },
          section: {
            id: withRelations.section_id,
            name: withRelations.section_name,
            semester: withRelations.semester,
            departmentId: withRelations.section_department_id,
            academicYearId: withRelations.academic_year_id,
            createdAt: '',
            updatedAt: '',
          },
          subject: {
            id: withRelations.subject_id,
            name: withRelations.subject_name,
            code: withRelations.subject_code,
            departmentId: '',
            defaultClassType: withRelations.class_type as any,
            createdAt: '',
            updatedAt: '',
          },
          faculty: {
            id: withRelations.faculty_id,
            name: withRelations.faculty_name,
            departmentId: '',
            isActive: true,
            maxDailySubstitutions: 2,
            priority: 0,
            createdAt: '',
            updatedAt: '',
          },
          room: {
            id: withRelations.room_id,
            name: withRelations.room_name,
            capacity: 0,
            type: 'CLASSROOM',
            createdAt: '',
            updatedAt: '',
          },
        })
      }
    }
  }

  if (affectedEntries.length === 0) {
    return { assignments: [], uncovered: [], affectedEntries: [] }
  }

  const allFaculty = facultyRepository.findActive()
  const timeSlots = db.prepare('SELECT * FROM time_slots ORDER BY "order"').all() as TimeSlot[]
  const weights = settingsRepository.getSubstitutionWeights() as unknown as SubstitutionWeights
  const maxDailySubstitutions = settingsRepository.getMaxDailySubstitutions()

  const problem: SubstitutionProblem = {
    date,
    absentFacultyIds: Array.from(absentFacultyIds),
    affectedEntries,
    allFaculty,
    timeSlots,
    weights,
    maxDailySubstitutions,
  }

  const { assignments, uncovered } = solveSubstitutionProblem(problem)

  return { assignments, uncovered, affectedEntries }
}

/**
 * Save substitution run to database.
 *
 * Locked (manually overridden) assignments are never deleted or overwritten —
 * regeneration must respect them.
 */
export function saveSubstitutionRun(
  date: string,
  assignments: SubstitutionAssignmentResult[],
  uncovered: UncoveredEntry[]
): string {
  const db = getDatabase()
  let runRow = db.prepare('SELECT id FROM substitution_runs WHERE date = ?').get(date) as { id: string } | undefined

  if (!runRow) {
    const id = crypto.randomUUID()
    // NOTE: better-sqlite3 builds SQLite with SQLITE_DQS=0 — double-quoted
    // tokens are identifiers only, so these must be single-quoted literals.
    db.prepare(
      "INSERT INTO substitution_runs (id, date, status, generated_at, created_at, updated_at) VALUES (?, ?, ?, datetime('now'), datetime('now'), datetime('now'))"
    ).run(id, date, 'GENERATED')
    runRow = { id }
  } else {
    db.prepare(
      "UPDATE substitution_runs SET status = ?, generated_at = datetime('now'), updated_at = datetime('now') WHERE id = ?"
    ).run('GENERATED', runRow.id)
  }

  const runId = runRow.id

  // Remember locked overrides so they survive regeneration.
  const lockedRows = db
    .prepare('SELECT original_entry_id FROM substitution_assignments WHERE run_id = ? AND is_locked = 1')
    .all(runId) as { original_entry_id: string }[]
  const lockedEntryIds = new Set(lockedRows.map((r) => r.original_entry_id))

  // Persist the whole plan atomically: if any insert fails, the DELETE is
  // rolled back too, so the previous plan is never left half-replaced.
  db.exec('BEGIN')
  try {
    // Clear only non-locked assignments.
    db.prepare('DELETE FROM substitution_assignments WHERE run_id = ? AND is_locked = 0').run(runId)

    const stmt = db.prepare(`
      INSERT INTO substitution_assignments
        (id, run_id, original_entry_id, substitute_faculty_id, status, score, reasoning, is_locked, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 0, datetime('now'), datetime('now'))
      ON CONFLICT(run_id, original_entry_id) DO UPDATE SET
        substitute_faculty_id = excluded.substitute_faculty_id,
        status = excluded.status,
        score = excluded.score,
        reasoning = excluded.reasoning,
        updated_at = datetime('now')
    `)

    for (const a of assignments) {
      if (lockedEntryIds.has(a.originalEntryId)) continue
      if (!a.substituteFacultyId) continue
      stmt.run(
        crypto.randomUUID(),
        runId,
        a.originalEntryId,
        a.substituteFacultyId,
        a.status === 'NO_CANDIDATE' ? 'PENDING' : a.status,
        a.score,
        a.reasoning
      )
    }

    // Persist uncovered classes so the UI can show "NO SUBSTITUTE FOUND".
    for (const u of uncovered) {
      if (lockedEntryIds.has(u.originalEntryId)) continue
      stmt.run(crypto.randomUUID(), runId, u.originalEntryId, null, 'PENDING', null, u.reason)
    }

    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }

  return runId
}