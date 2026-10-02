import { 
  TimetableEntryWithRelations, 
  Faculty, 
  TimeSlot,
  SubstitutionWeights, 
  DEFAULT_SUBSTITUTION_WEIGHTS,
} from '@/types'
import { facultyRepository, attendanceRepository, substitutionAssignmentRepository, settingsRepository, timetableEntryRepository, timeSlotRepository } from '@/db/repositories'
import { getEligibleCandidates } from './scoring'
import { coveredSlotsOf } from '@/services/timetable'
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

    // Get master timetable entries for this faculty on this day.
    // SPAN-AWARE: a 2-hour lab occupies BOTH periods — the faculty member is
    // busy (and a substitute must be free) for the whole activity.
    const teachingEntries = timetableEntryRepository.findByFacultyAndDay(faculty.id, dayOfWeek as any, academicYearId)
    const busySlots = new Set<string>()
    for (const entry of teachingEntries) {
      for (const slot of coveredSlotsOf(entry, timeSlots)) busySlots.add(slot.id)
    }

    // Get existing approved substitutions for this date (span-expanded too —
    // an already-arranged 2-hour cover also blocks the substitute's second hour).
    const existingSubs = db.prepare(`
      SELECT sa.*, te.time_slot_id, te.span
      FROM substitution_assignments sa
      JOIN substitution_runs sr ON sa.run_id = sr.id
      JOIN timetable_entries te ON sa.original_entry_id = te.id
      WHERE sr.date = ? AND sa.substitute_faculty_id = ? AND sa.status IN ('APPROVED', 'LOCKED')
    `).all(date, faculty.id) as { time_slot_id: string; span: number }[]

    for (const sub of existingSubs) {
      for (const slot of coveredSlotsOf({ timeSlotId: sub.time_slot_id, span: sub.span }, timeSlots)) {
        busySlots.add(slot.id)
      }
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
  const absentSet = new Set(absentFacultyIds)

  // SPAN: every period each affected activity occupies. A substitute must be
  // free for ALL of them and, once assigned, is reserved for ALL of them —
  // no partial double-booking of a 2-hour lab's second hour.
  const coveredByEntry = new Map<string, TimeSlot[]>(
    affectedEntries.map(e => [e.id, coveredSlotsOf(e, timeSlots)])
  )

  for (const [facultyId, avail] of facultyAvailability) {
    usedFacultySlots.set(facultyId, new Set(avail.busySlots))
    facultySubCounts.set(facultyId, avail.substitutionCount)
  }

  // Try to assign each entry
  for (const { entry, candidateList } of entriesWithCandidates) {
    let assigned = false
    const covered = coveredByEntry.get(entry.id) ?? []

    for (const candidate of candidateList) {
      const facultyId = candidate.faculty.id

      if (covered.some(s => usedFacultySlots.get(facultyId)?.has(s.id))) continue
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
      // Multi-faculty activity under REPLACE_ABSENT: say exactly who is being
      // covered and that the rest of the team remains.
      if (entry.facultyIds.length > 1) {
        const absentHere = entry.facultyIds.filter(f => absentSet.has(f))
        if (absentHere.length > 0 && absentHere.length < entry.facultyIds.length) {
          const names = absentHere
            .map(id => facultyRepository.findById(id)?.name ?? 'A faculty member')
            .join(', ')
          reasoning = `Covering for absent faculty: ${names} (rest of the team continues); ${reasoning}`
        }
      }

      assignments.push({
        originalEntryId: entry.id,
        substituteFacultyId: facultyId,
        score: candidate.score,
        reasoning,
        status: 'PENDING',
      })

      // Reserve the substitute for the WHOLE activity duration.
      for (const s of covered) usedFacultySlots.get(facultyId)!.add(s.id)
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
/**
 * Activities affected on `date` under the configured multi-faculty absence
 * policy. Shared by plan generation AND run statistics so both always agree:
 *
 *  - ALL faculty of an activity absent → always affected.
 *  - SOME absent + TEAM_SUFFICIENT (default) → the remaining team runs it;
 *    not affected (no substitution generated).
 *  - SOME absent + REPLACE_ABSENT → affected; one substitute covers the
 *    absent member(s) while the rest of the team continues.
 *  - Faculty-less activities (library, mentoring, …) are never affected —
 *    there is no one to substitute.
 */
export function findAffectedEntries(
  absentFacultyIds: Set<string>,
  dayOfWeek: string,
  academicYearId: string
): TimetableEntryWithRelations[] {
  if (absentFacultyIds.size === 0) return []

  // Every activity an absent faculty member is part of (deduplicated — a
  // multi-faculty lab is found via each of its absent members once).
  const candidateEntryIds = new Set<string>()
  for (const facultyId of absentFacultyIds) {
    const entries = timetableEntryRepository.findByFacultyAndDay(
      facultyId,
      dayOfWeek as any,
      academicYearId
    )
    for (const entry of entries) candidateEntryIds.add(entry.id)
  }
  if (candidateEntryIds.size === 0) return []

  const policy = settingsRepository.getMultiFacultyAbsencePolicy()
  const withRelations = timetableEntryRepository.getWithRelationsByIds([...candidateEntryIds])
  const affectedEntries: TimetableEntryWithRelations[] = []

  for (const entry of withRelations) {
    if (entry.timeSlot?.isBreak) continue
    const team = entry.facultyIds
    if (team.length === 0) continue
    const absentHere = team.filter(f => absentFacultyIds.has(f))
    if (absentHere.length === 0) continue
    const allAbsent = absentHere.length === team.length
    if (!allAbsent && policy === 'TEAM_SUFFICIENT') continue // team continues
    affectedEntries.push(entry)
  }

  return affectedEntries
}

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

  const affectedEntries = findAffectedEntries(absentFacultyIds, dayOfWeek, academicYearId)

  if (affectedEntries.length === 0) {
    return { assignments: [], uncovered: [], affectedEntries: [] }
  }

  const allFaculty = facultyRepository.findActive()
  const timeSlots = timeSlotRepository.getOrdered()
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
    // Regeneration supersedes any previous approval — status AND approval
    // metadata reset together (a GENERATED run with a leftover approved_by
    // would misrepresent who signed off on what).
    db.prepare(
      "UPDATE substitution_runs SET status = ?, approved_at = NULL, approved_by = NULL, generated_at = datetime('now'), updated_at = datetime('now') WHERE id = ?"
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