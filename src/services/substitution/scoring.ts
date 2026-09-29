import { 
  TimetableEntryWithRelations, 
  Faculty, 
  SubstitutionWeights, 
  DEFAULT_SUBSTITUTION_WEIGHTS,
} from '@/types'
import { facultyRepository, settingsRepository } from '@/db/repositories'
import { getDatabase } from '@/db/database'
import { SubstitutionCandidate, FacultyAvailability, PriorityTier, PRIORITY_TIER_LABELS } from './types'

/**
 * Calculate substitution score for a faculty member for a specific timetable entry
 * This is the core deterministic scoring function
 */
export function calculateSubstitutionScore(
  entry: TimetableEntryWithRelations,
  candidate: Faculty,
  availability: FacultyAvailability,
  weights: SubstitutionWeights = DEFAULT_SUBSTITUTION_WEIGHTS,
  context: {
    allFaculty: Faculty[]
    absentFacultyIds: Set<string>
    lockedAssignments: Map<string, string>
  }
): SubstitutionCandidate {
  const reasons: string[] = []
  const warnings: string[] = []
  let score = 0

  // HARD CONSTRAINT CHECKS
  if (context.absentFacultyIds.has(candidate.id)) {
    return { faculty: candidate, score: -Infinity, reasons: [], warnings: ['Faculty is absent'], priorityTier: 5 }
  }

  if (availability.busySlots.has(entry.timeSlotId)) {
    return { faculty: candidate, score: -Infinity, reasons: [], warnings: ['Already teaching during this slot'], priorityTier: 5 }
  }

  if (availability.substitutionCount >= candidate.maxDailySubstitutions) {
    return { faculty: candidate, score: -Infinity, reasons: [], warnings: [`Daily substitution limit reached (${candidate.maxDailySubstitutions})`], priorityTier: 5 }
  }

  if (entry.timeSlot?.isBreak) {
    return { faculty: candidate, score: -Infinity, reasons: [], warnings: ['Cannot substitute during break'], priorityTier: 5 }
  }

  // SCORING FACTORS

  // 1. Same class/section (+100)
  const teachesSection = facultyRepository.teachesSection(candidate.id, entry.sectionId)
  if (teachesSection) {
    score += weights.sameClass
    reasons.push(`✓ Normally teaches ${entry.section?.name || entry.sectionId}`)
  }

  // 2. Same semester/year (+60)
  let sameSemester = false
  if (!teachesSection && entry.section) {
    const db = getDatabase()
    const candidateSectionSemesters = db.prepare(`
      SELECT DISTINCT sec.semester 
      FROM sections sec
      JOIN faculty_sections fs ON sec.id = fs.section_id
      WHERE fs.faculty_id = ?
    `).all(candidate.id) as { semester: number }[]
    
    sameSemester = candidateSectionSemesters.some(s => s.semester === entry.section!.semester)
    if (sameSemester) {
      score += weights.sameSemester
      reasons.push(`✓ Teaches same semester (Semester ${entry.section.semester})`)
    }
  }

  // 3. Same department (+40)
  const sameDepartment = candidate.departmentId === entry.section?.departmentId
  if (sameDepartment) {
    score += weights.sameDepartment
    reasons.push(`✓ Same department`)
  } else {
    score += weights.penaltyCrossDepartment
    warnings.push(`Cross-department substitution`)
  }

  // 4. Subject qualification (+30)
  const isQualified = facultyRepository.isQualifiedForSubject(candidate.id, entry.subjectId)
  if (isQualified) {
    score += weights.subjectQualified
    reasons.push(`✓ Qualified for ${entry.subject?.name || entry.subjectId}`)
  }

  // 5. Teaches same subject normally (+20)
  const db = getDatabase()
  const teachesSubject = db.prepare(`
    SELECT 1 FROM timetable_entries te
    WHERE te.faculty_id = ? AND te.subject_id = ? AND te.academic_year_id = ?
    LIMIT 1
  `).get(candidate.id, entry.subjectId, entry.academicYearId)
  if (teachesSubject) {
    score += weights.teachesSameSubject
    reasons.push(`✓ Normally teaches this subject`)
  }

  // 6. Free during slot (+20)
  score += weights.freeDuringSlot
  reasons.push(`✓ Free at ${entry.timeSlot?.name || entry.timeSlotId}`)

  // 7. Low substitution count today (+15 for 0)
  const subCount = availability.substitutionCount
  if (subCount === 0) {
    score += weights.lowSubCount
    reasons.push(`✓ No substitutions today`)
  } else if (subCount === 1) {
    score += weights.lowSubCount / 2
    reasons.push(`✓ Only 1 substitution today`)
  }

  // 8. Taught section before (+10)
  const taughtBefore = db.prepare(`
    SELECT 1 FROM timetable_entries te
    WHERE te.faculty_id = ? AND te.section_id = ? AND te.academic_year_id = ?
    LIMIT 1
  `).get(candidate.id, entry.sectionId, entry.academicYearId)
  if (taughtBefore && !teachesSection) {
    score += weights.taughtSectionBefore
    reasons.push(`✓ Has taught this section before`)
  }

  // PENALTIES
  if (subCount >= candidate.maxDailySubstitutions - 1) {
    score += weights.penaltyHighSubCount
    warnings.push(`Near daily substitution limit (${subCount}/${candidate.maxDailySubstitutions})`)
  }

  if (availability.consecutiveSlots >= 2) {
    score += weights.penaltyConsecutive
    warnings.push(`Consecutive teaching slots (${availability.consecutiveSlots})`)
  }

  // PRIORITY TIER (hierarchy applied after the hard constraints, before score).
  // Class familiarity deliberately outranks subject qualification: a teacher
  // who normally teaches the affected class is preferred over a teacher of
  // the same subject from another class/semester.
  const teachesAnySection = facultyRepository.getSections(candidate.id).length > 0
  const priorityTier: PriorityTier = teachesSection
    ? 1
    : sameSemester
      ? 2
      : sameDepartment && teachesAnySection
        ? 3
        : sameDepartment || isQualified || taughtBefore || teachesSubject
          ? 4
          : 5
  reasons.push(`✓ ${PRIORITY_TIER_LABELS[priorityTier]}`)

  return { faculty: candidate, score, reasons, warnings, priorityTier }
}

/**
 * Get all eligible candidates for an entry, sorted by priority tier first
 * (P1 same class → P5 unrelated) and then by score within the tier.
 *
 * Unrelated (P5) candidates are only considered when the college configuration
 * allows unrelated substitutions (Settings → Substitution Rules).
 */
export function getEligibleCandidates(
  entry: TimetableEntryWithRelations,
  allFaculty: Faculty[],
  facultyAvailability: Map<string, FacultyAvailability>,
  weights: SubstitutionWeights,
  context: {
    absentFacultyIds: Set<string>
    lockedAssignments: Map<string, string>
  }
): SubstitutionCandidate[] {
  const candidates: SubstitutionCandidate[] = []
  const allowUnrelated = settingsRepository.getAllowUnrelatedSubstitutions()

  for (const faculty of allFaculty) {
    if (!faculty.isActive) continue
    
    const availability = facultyAvailability.get(faculty.id)
    if (!availability) continue

    const candidate = calculateSubstitutionScore(entry, faculty, availability, weights, {
      allFaculty,
      absentFacultyIds: context.absentFacultyIds,
      lockedAssignments: context.lockedAssignments,
    })

    if (candidate.score === -Infinity) continue
    // P5 (unrelated) is filtered out entirely when configuration forbids it.
    if (!allowUnrelated && candidate.priorityTier >= 5) continue
    candidates.push(candidate)
  }

  // Tier dominates score; Array.prototype.sort is stable, so equal tier+score
  // keeps the input order (findActive → ORDER BY name) → deterministic output.
  return candidates.sort((a, b) => (a.priorityTier - b.priorityTier) || (b.score - a.score))
}