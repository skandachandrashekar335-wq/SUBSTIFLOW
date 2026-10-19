/**
 * Phase 1 — the real timetable generator, end to end.
 *
 * Every test runs on its own isolated in-memory SQLite database (fresh schema
 * per test), so nothing here can ever touch the production database or the
 * published III BCA-B timetable. Fixtures are built through the same
 * repositories the UI uses — no hardcoded college timetable, no recorded
 * production data.
 *
 * Coverage:
 *  1. Success: Teaching Allocations + Subject Requirements → valid draft with
 *     exact weekly counts, span-aware no-overlap, break/day/duration rules,
 *     lab room + team rules, published timetable untouched, independent
 *     validation passes.
 *  2. Determinism: two runs of identical input produce identical drafts.
 *  3. Multi-faculty lab = TEAM: every member teaches every session.
 *  4. Backtracking: a provably tight Monday-only instance whose greedy first
 *     choices dead-end — the search must retry (attempts > sessions) and still
 *     succeed with every hard constraint intact.
 *  5. Impossible instance: FAILED with administrator-readable diagnostics
 *     (section, subject, requirement, attempted scope, reason, suggested
 *     action) + search statistics; no draft rows; published data untouched;
 *     publish refuses the failed run.
 *  6. Input validation: overloaded section and requirement-without-allocation
 *     fail before any search, naming the problem.
 *  7. Search bounds: attempt limit and time limit stop the run with
 *     SEARCH_LIMIT_REACHED diagnostics and FAILED status.
 *  8. Draft tampering: independent validation catches it; publish refuses.
 *  9. Publish: replaces covered sections only, preserves unrelated sections,
 *     marks drafts PUBLISHED, writes an audit entry.
 * 10. Publish rollback: a kept-section conflict and a mid-transaction DB
 *     failure both leave the previous timetable byte-identical.
 * 11. Substitution records survive publish (remapped to the replacement cell)
 *     or are counted/audited as superseded with their runs retained.
 * 12. Summary helper queries bind every SQL parameter and filter by subject
 *     (regression: they once bound one argument too few and would throw).
 * 13. Re-publish guard: publishing the same generation twice throws a clear
 *     error before any transaction — timetable rows, substitution history and
 *     audit entries are byte-identical afterwards.
 * 14. Stale RUNNING recovery: a run abandoned by an unexpected shutdown is
 *     flipped to FAILED with diagnostics/drafts preserved and terminal rows
 *     untouched — while a generation genuinely in flight is never failed.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import { schema } from '@/db/schema'
import { departmentRepository } from '@/db/repositories/department'
import { academicYearRepository } from '@/db/repositories/academicYear'
import { timeSlotRepository } from '@/db/repositories/timeSlot'
import { facultyRepository } from '@/db/repositories/faculty'
import { subjectRepository } from '@/db/repositories/subject'
import { sectionRepository } from '@/db/repositories/section'
import { roomRepository } from '@/db/repositories/room'
import { settingsRepository } from '@/db/repositories/settings'
import { timetableEntryRepository } from '@/db/repositories/timetableEntry'
import {
  draftTimetableEntryRepository,
  timetableGenerationRepository,
  subjectRequirementRepository,
  teachingAllocationRepository,
  generationDiagnosticRepository,
  substitutionRunRepository,
  substitutionAssignmentRepository,
  auditLogRepository,
  AUDIT_ACTIONS,
} from '@/db/repositories'
import {
  generateTimetable,
  validateDraftTimetable,
  publishDraftTimetable,
  getGenerationStatus,
  recoverStaleGenerations,
  effectiveTeachingArrangement,
} from '@/services/timetableGenerator'
import { resolveCoveredSlots } from '@/services/timetable'
import {
  getTotalSessionsForSectionSubject,
  getTeachingAllocationsBySectionSubject,
  getRequiredSessionsForClassType,
} from '@/services/timetableGeneration'
import { getSubjectRequirementsBySectionSubjectClassType } from '@/services/subjectRequirement'
import { GenerationDiagnosticCode, DraftTimetableEntryWithRelations, GenerationDiagnostic } from '@/types'

let testDb: Database.Database | null = null

vi.mock('@/db/database', () => ({
  getDatabase: () => testDb,
  closeDatabase: () => undefined,
}))

const YEAR = 'year-1'

function detailsOf(d: GenerationDiagnostic): Record<string, any> {
  if (!d.details) return {}
  try {
    return JSON.parse(d.details)
  } catch {
    return {}
  }
}

/** Base world: departments, year, default periods, faculty, subjects, sections, rooms. */
function seedBase(): void {
  departmentRepository.create({ id: 'dept-bca', name: 'BCA', code: 'BCA' })
  academicYearRepository.create({
    id: YEAR,
    name: '2026-2027',
    startDate: '2026-06-01',
    endDate: '2027-05-31',
    isActive: true,
  })
  timeSlotRepository.initializeDefaults()
  facultyRepository.create({ id: 'fac-1', name: 'Dr. Asha', departmentId: 'dept-bca' })
  facultyRepository.create({ id: 'fac-2', name: 'Dr. Binu', departmentId: 'dept-bca' })
  facultyRepository.create({ id: 'fac-3', name: 'Dr. Chitra', departmentId: 'dept-bca' })
  subjectRepository.create({ id: 'sub-cs', name: 'Computer Science', code: 'CS101', departmentId: 'dept-bca' })
  subjectRepository.create({ id: 'sub-math', name: 'Mathematics', code: 'MA101', departmentId: 'dept-bca' })
  subjectRepository.create({ id: 'sub-chem', name: 'Chemistry', code: 'CH101', departmentId: 'dept-bca' })
  subjectRepository.create({ id: 'sub-x', name: 'Physics', code: 'PH101', departmentId: 'dept-bca' })
  subjectRepository.create({ id: 'sub-y', name: 'English', code: 'EN101', departmentId: 'dept-bca' })
  subjectRepository.create({ id: 'sub-z', name: 'Biology', code: 'BI101', departmentId: 'dept-bca' })
  sectionRepository.create({ id: 'sec-a', name: 'III BCA-A', departmentId: 'dept-bca', semester: 5, academicYearId: YEAR })
  sectionRepository.create({ id: 'sec-b', name: 'III BCA-B', departmentId: 'dept-bca', semester: 5, academicYearId: YEAR })
  sectionRepository.create({ id: 'sec-c', name: 'III BCA-C', departmentId: 'dept-bca', semester: 5, academicYearId: YEAR })
  sectionRepository.create({ id: 'sec-x', name: 'III BCA-X', departmentId: 'dept-bca', semester: 5, academicYearId: YEAR })
  roomRepository.create({ id: 'room-101', name: 'Room 101' })
  roomRepository.create({ id: 'room-102', name: 'Room 102' })
  roomRepository.create({ id: 'lab-1', name: 'CS Lab', type: 'LAB' })
}

function addRequirement(
  id: string,
  sectionId: string,
  subjectId: string,
  classType: string,
  requiredSessionsPerWeek: number,
  span: number,
  teachingArrangement?: string
): void {
  subjectRequirementRepository.create({
    id,
    academicYearId: YEAR,
    sectionId,
    subjectId,
    classType,
    requiredSessionsPerWeek,
    span,
    ...(teachingArrangement ? { teachingArrangement } : {}),
  })
}

function addAllocation(
  id: string,
  facultyId: string,
  sectionId: string,
  subjectId: string,
  classType: string,
  requiredSessionsPerWeek: number
): void {
  teachingAllocationRepository.create({
    id,
    academicYearId: YEAR,
    facultyId,
    sectionId,
    subjectId,
    classType,
    requiredSessionsPerWeek,
  })
}

/**
 * Standard fixture: sec-a needs 2 Computer Science + 1 Mathematics lecture,
 * sec-b needs one 2-period Chemistry lab; Dr. Asha teaches sec-a, Dr. Chitra
 * runs the lab. sec-x exists but has no requirements (an "unrelated section").
 */
function seedCommonFixture(): void {
  addRequirement('req-cs', 'sec-a', 'sub-cs', 'LECTURE', 2, 1)
  addRequirement('req-math', 'sec-a', 'sub-math', 'LECTURE', 1, 1)
  addRequirement('req-chem', 'sec-b', 'sub-chem', 'LAB', 1, 2)
  addAllocation('alloc-cs', 'fac-1', 'sec-a', 'sub-cs', 'LECTURE', 2)
  addAllocation('alloc-math', 'fac-1', 'sec-a', 'sub-math', 'LECTURE', 1)
  addAllocation('alloc-chem', 'fac-3', 'sec-b', 'sub-chem', 'LAB', 1)
}

/**
 * Hard-constraint sweep over a draft: every activity resolves to contiguous
 * non-break periods inside the working day, and no section, faculty member or
 * room is ever booked twice in the same period (span-aware).
 */
function expectNoHardConflicts(entries: DraftTimetableEntryWithRelations[]): void {
  const breakIds = new Set(timeSlotRepository.getBreakSlots().map((s) => s.id))
  const occupied = new Map<string, string>()
  for (const entry of entries) {
    const covered = resolveCoveredSlots(entry.timeSlotId, entry.span)
    if ('error' in covered) {
      throw new Error(`entry ${entry.id} (${entry.sectionId}) has an unresolvable span: ${covered.error}`)
    }
    expect(covered.slots).toHaveLength(entry.span)
    for (const slot of covered.slots) {
      expect(breakIds.has(slot.id)).toBe(false)
      expect(slot.isBreak).toBe(false)
      const keys = [
        `section|${entry.sectionId}|${entry.dayOfWeek}|${slot.id}`,
        ...(entry.facultyList ?? []).map((f) => `faculty|${f.id}|${entry.dayOfWeek}|${slot.id}`),
        ...(entry.roomList ?? []).map((r) => `room|${r.id}|${entry.dayOfWeek}|${slot.id}`),
      ]
      for (const key of keys) {
        expect(occupied.has(key), `double-booked: ${key}`).toBe(false)
        occupied.set(key, entry.id)
      }
    }
  }
}

function countBy(entries: DraftTimetableEntryWithRelations[], sectionId: string, subjectId: string, classType: string): number {
  return entries.filter((e) => e.sectionId === sectionId && e.subjectId === subjectId && e.classType === classType).length
}

beforeEach(() => {
  if (testDb) testDb.close()
  testDb = new Database(':memory:')
  testDb.pragma('foreign_keys = ON')
  testDb.exec(schema)
  seedBase()
})

afterEach(() => {
  vi.restoreAllMocks()
  if (testDb) {
    testDb.close()
    testDb = null
  }
})

// ---------------------------------------------------------------------------
// 1. Success path
// ---------------------------------------------------------------------------
describe('generation: successful run', () => {
  it('produces a valid draft honoring every hard constraint and exact weekly counts', () => {
    seedCommonFixture()

    const result = generateTimetable(YEAR)
    expect(result.status).toBe('COMPLETED')
    expect(result.statistics.totalAllocations).toBe(4)
    expect(result.statistics.scheduled).toBe(4)
    expect(result.statistics.uncovered).toBe(0)
    expect(result.statistics.labs).toBe(1)
    expect(result.statistics.errors).toBe(0)
    expect(result.search?.stopReason).toBeNull()

    const entries = draftTimetableEntryRepository.findByGenerationWithRelations(result.generationId)
    expect(entries).toHaveLength(4)

    // Exact weekly counts straight from Subject Requirements.
    expect(countBy(entries, 'sec-a', 'sub-cs', 'LECTURE')).toBe(2)
    expect(countBy(entries, 'sec-a', 'sub-math', 'LECTURE')).toBe(1)
    expect(countBy(entries, 'sec-b', 'sub-chem', 'LAB')).toBe(1)

    // Span-aware overlap + break + working-day + duration rules.
    expectNoHardConflicts(entries)
    const workingDays = settingsRepository.getWorkingDays()
    for (const entry of entries) {
      expect(workingDays).toContain(entry.dayOfWeek)
      const requiredSpan =
        entry.classType === 'LAB' ? 2 : 1
      expect(entry.span).toBe(requiredSpan)
    }

    // Lab: runs in a LAB room, span 2, taught by its allocated faculty.
    const lab = entries.find((e) => e.classType === 'LAB')!
    expect(lab.span).toBe(2)
    expect(lab.roomList?.map((r) => r.id)).toEqual(['lab-1'])
    expect(lab.facultyList?.map((f) => f.id)).toEqual(['fac-3'])

    // Generation never touches the published timetable.
    expect(timetableEntryRepository.count()).toBe(0)

    // Generation status for the UI.
    const status = getGenerationStatus(result.generationId)!
    expect(status.generation.status).toBe('COMPLETED')
    expect(status.draftEntries).toBe(4)
    expect(status.diagnostics.errors).toBe(0)
    expect(status.published).toBe(false)

    // Independent validation — the gate before publish.
    const validation = validateDraftTimetable(result.generationId)
    expect(validation.valid).toBe(true)
    expect(validation.errors).toEqual([])
    expect(validation.entries).toBe(4)
    expect(validation.requiredSessions).toBe(4)
    expect(validation.scheduledSessions).toBe(4)
    expect(validation.labsScheduled).toBe(1)
    expect(validation.missing).toEqual([])
  })

  it('is deterministic: two runs over identical input produce identical drafts', () => {
    seedCommonFixture()

    const first = generateTimetable(YEAR)
    const second = generateTimetable(YEAR)
    expect(first.status).toBe('COMPLETED')
    expect(second.status).toBe('COMPLETED')

    const tuple = (e: DraftTimetableEntryWithRelations) =>
      [
        e.dayOfWeek,
        e.timeSlotId,
        e.sectionId,
        e.subjectId,
        e.classType,
        e.span,
        (e.facultyList ?? []).map((f) => f.id).join(','),
        (e.roomList ?? []).map((r) => r.id).join(','),
      ].join('|')

    const a = draftTimetableEntryRepository
      .findByGenerationWithRelations(first.generationId)
      .map(tuple)
      .sort()
    const b = draftTimetableEntryRepository
      .findByGenerationWithRelations(second.generationId)
      .map(tuple)
      .sort()
    expect(b).toEqual(a)
  })

  it('schedules a multi-faculty lab as a TEAM — every member on every session', () => {
    addRequirement('req-chem', 'sec-b', 'sub-chem', 'LAB', 1, 2)
    addAllocation('alloc-chem-1', 'fac-1', 'sec-b', 'sub-chem', 'LAB', 1)
    addAllocation('alloc-chem-2', 'fac-2', 'sec-b', 'sub-chem', 'LAB', 1)

    const result = generateTimetable(YEAR)
    expect(result.status).toBe('COMPLETED')

    const entries = draftTimetableEntryRepository.findByGenerationWithRelations(result.generationId)
    expect(entries).toHaveLength(1)
    expect(entries[0].span).toBe(2)
    expect(entries[0].facultyList?.map((f) => f.id).sort()).toEqual(['fac-1', 'fac-2'])
    expect(entries[0].roomList?.map((r) => r.id)).toEqual(['lab-1'])
    expectNoHardConflicts(entries)
    expect(validateDraftTimetable(result.generationId).valid).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 2. Backtracking
// ---------------------------------------------------------------------------
describe('generation: backtracking search', () => {
  it('solves a provably tight instance — more placement attempts than sessions', () => {
    // Monday only (6 teaching periods). Three groups that must interleave:
    //  - sec-b · Physics  ×3 (span 2): Dr. Asha (target 2) or Dr. Binu (1)
    //  - sec-a · English  ×1 (span 2): Dr. Asha only
    //  - sec-c · Biology  ×2 (span 2): Dr. Binu only
    // Section capacities are exactly met (sec-b = 6/6 periods). The greedy
    // first choices (Dr. Asha + Dr. Binu both grabbing 09:00-11:00) leave the
    // sole-teacher groups without two disjoint periods, forcing the search to
    // undo placements and retry before it can finish.
    settingsRepository.setWorkingDays(['MONDAY'])
    addRequirement('req-x', 'sec-b', 'sub-x', 'LECTURE', 3, 2)
    addRequirement('req-y', 'sec-a', 'sub-y', 'LECTURE', 1, 2)
    addRequirement('req-z', 'sec-c', 'sub-z', 'LECTURE', 2, 2)
    addAllocation('alloc-x-1', 'fac-1', 'sec-b', 'sub-x', 'LECTURE', 2)
    addAllocation('alloc-x-2', 'fac-2', 'sec-b', 'sub-x', 'LECTURE', 1)
    addAllocation('alloc-y', 'fac-1', 'sec-a', 'sub-y', 'LECTURE', 1)
    addAllocation('alloc-z', 'fac-2', 'sec-c', 'sub-z', 'LECTURE', 2)

    const result = generateTimetable(YEAR)
    expect(result.status).toBe('COMPLETED')
    expect(result.statistics.totalAllocations).toBe(6)
    expect(result.statistics.scheduled).toBe(6)
    expect(result.statistics.uncovered).toBe(0)

    const entries = draftTimetableEntryRepository.findByGenerationWithRelations(result.generationId)
    expect(entries).toHaveLength(6)
    expect(countBy(entries, 'sec-b', 'sub-x', 'LECTURE')).toBe(3)
    expect(countBy(entries, 'sec-a', 'sub-y', 'LECTURE')).toBe(1)
    expect(countBy(entries, 'sec-c', 'sub-z', 'LECTURE')).toBe(2)
    expectNoHardConflicts(entries)

    // Backtracking proof: the greedy first branch dead-ends, so the number of
    // placement attempts must exceed the number of sessions actually kept.
    expect(result.search!.attempts).toBeGreaterThan(result.statistics.scheduled)

    // The independent validator agrees with all of the above.
    const validation = validateDraftTimetable(result.generationId)
    expect(validation.valid).toBe(true)
    expect(validation.errors).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// 3. Impossible instances → administrator-readable diagnostics
// ---------------------------------------------------------------------------
describe('generation: impossible inputs', () => {
  it('fails the search with section/subject/requirement, scope, reason and action', () => {
    // 5 teaching periods (slot-6 removed). One section needs a 3-period block
    // AND a 2-period block: the two 3-period windows ({1,2,3}, {2,3,4}) both
    // leave non-adjacent leftovers (the break sits between period 4 and 5),
    // so no arrangement exists — the search must prove it, not fake success.
    settingsRepository.setWorkingDays(['MONDAY'])
    expect(timeSlotRepository.delete('slot-6')).toBe(true)

    addRequirement('req-x', 'sec-a', 'sub-x', 'LECTURE', 1, 3)
    addRequirement('req-y', 'sec-a', 'sub-y', 'LECTURE', 1, 2)
    addAllocation('alloc-x', 'fac-1', 'sec-a', 'sub-x', 'LECTURE', 1)
    addAllocation('alloc-y', 'fac-1', 'sec-a', 'sub-y', 'LECTURE', 1)

    // Published data that must survive the failed generation untouched.
    timetableEntryRepository.create({
      id: 'old-mon',
      academicYearId: YEAR,
      dayOfWeek: 'MONDAY',
      timeSlotId: 'slot-1',
      sectionId: 'sec-a',
      subjectId: 'sub-x',
      classType: 'LECTURE',
      span: 1,
      facultyIds: ['fac-1'],
      roomIds: ['room-101'],
    })

    const result = generateTimetable(YEAR)
    expect(result.status).toBe('FAILED')
    expect(result.assignments).toEqual([])
    expect(result.statistics.totalAllocations).toBe(2)
    // The search's deepest partial solution is reported honestly — but as a
    // FAILED run with no assignments, never as a finished draft.
    expect(result.statistics.uncovered).toBeGreaterThan(0)

    // Search statistics: both 3-period windows were tried before giving up.
    expect(result.search!.attempts).toBeGreaterThanOrEqual(2)
    expect(result.search!.stopReason).toBe('exhausted')
    expect(result.search!.limitAttempts).toBeGreaterThan(0)

    // Diagnostics identify the requirement and tell an administrator what to do.
    const errors = result.diagnostics.filter((d) => d.severity === 'ERROR')
    expect(errors.length).toBeGreaterThan(0)
    const withSubject = errors.find((d) => d.message.includes('III BCA-A'))
    expect(withSubject).toBeTruthy()
    const details = detailsOf(withSubject!)
    expect(details.sectionName).toBe('III BCA-A')
    expect(details.subjectName).toBeTruthy()
    expect(details.requirementId).toBeTruthy()
    expect(details.attemptedScope).toBeTruthy()
    expect(details.reason).toBeTruthy()
    expect(details.suggestedAction).toBeTruthy()

    // Search summary for the UI (attempts, deepest partial solution, stop reason).
    const summary = result.diagnostics.find(
      (d) => d.code === GenerationDiagnosticCode.CONSTRAINT_UNSATISFIABLE
    )
    expect(summary).toBeTruthy()
    const summaryDetails = detailsOf(summary!)
    expect(summaryDetails.search.attempts).toBeGreaterThanOrEqual(2)
    expect(summaryDetails.search.stopReason).toBe('exhausted')
    expect(summaryDetails.reason).toBeTruthy()
    expect(summaryDetails.suggestedAction).toBeTruthy()

    // No partial draft is ever presented as success; published data intact.
    expect(draftTimetableEntryRepository.findByGeneration(result.generationId)).toHaveLength(0)
    expect(timetableGenerationRepository.findById(result.generationId)!.status).toBe('FAILED')
    expect(timetableEntryRepository.findById('old-mon')).toBeTruthy()
    expect(timetableEntryRepository.count()).toBe(1)

    // A failed generation can never be published.
    expect(() => publishDraftTimetable(result.generationId)).toThrow(/successfully completed/i)
    expect(getGenerationStatus(result.generationId)!.diagnostics.errors).toBeGreaterThan(0)
  })

  it('rejects an overloaded section before searching, naming the section and the numbers', () => {
    settingsRepository.setWorkingDays(['MONDAY']) // capacity = 6 periods/week
    addRequirement('req-cs', 'sec-a', 'sub-cs', 'LECTURE', 4, 2) // needs 8 > 6
    addAllocation('alloc-cs', 'fac-1', 'sec-a', 'sub-cs', 'LECTURE', 4)

    const result = generateTimetable(YEAR)
    expect(result.status).toBe('FAILED')

    const diag = result.diagnostics.find((d) => d.code === GenerationDiagnosticCode.SECTION_OVERLOADED)
    expect(diag).toBeTruthy()
    expect(diag!.severity).toBe('ERROR')
    expect(diag!.message).toContain('III BCA-A')
    expect(diag!.message).toContain('8 periods')
    expect(diag!.message).toContain('6')
    const details = detailsOf(diag!)
    expect(details.periodsNeeded).toBe(8)
    expect(details.periodsAvailable).toBe(6)
    expect(details.reason).toBeTruthy()
    expect(details.suggestedAction).toBeTruthy()

    expect(result.assignments).toEqual([])
    expect(draftTimetableEntryRepository.findByGeneration(result.generationId)).toHaveLength(0)
    expect(timetableEntryRepository.count()).toBe(0)
  })

  it('reports a requirement that has no teaching allocation', () => {
    // One healthy requirement + allocation (so the global "no allocations at
    // all" check passes) and one requirement nobody is allocated to — the
    // diagnostic must pinpoint that requirement.
    addRequirement('req-cs', 'sec-a', 'sub-cs', 'LECTURE', 2, 1)
    addAllocation('alloc-cs', 'fac-1', 'sec-a', 'sub-cs', 'LECTURE', 2)
    addRequirement('req-math', 'sec-a', 'sub-math', 'LECTURE', 1, 1)

    const result = generateTimetable(YEAR)
    expect(result.status).toBe('FAILED')

    const diag = result.diagnostics.find(
      (d) => d.code === GenerationDiagnosticCode.NO_QUALIFIED_FACULTY && d.message.includes('III BCA-A')
    )
    expect(diag).toBeTruthy()
    expect(diag!.severity).toBe('ERROR')
    expect(diag!.message).toContain('Mathematics')
    expect(diag!.message).toContain('no teaching allocation')
    const details = detailsOf(diag!)
    expect(details.sectionName).toBe('III BCA-A')
    expect(details.subjectName).toBe('Mathematics')
    expect(details.requirementId).toBe('req-math')
    expect(details.attemptedScope).toBeTruthy()
    expect(details.reason).toContain('No Teaching Allocation')
    expect(details.suggestedAction).toContain('Teaching Allocations')

    expect(result.assignments).toEqual([])
    expect(draftTimetableEntryRepository.findByGeneration(result.generationId)).toHaveLength(0)
    expect(timetableGenerationRepository.findById(result.generationId)!.status).toBe('FAILED')
  })
})

// ---------------------------------------------------------------------------
// 4. Search bounds
// ---------------------------------------------------------------------------
describe('generation: search bounds', () => {
  it('stops at the configured attempt limit and says so (SEARCH_LIMIT_REACHED)', () => {
    seedCommonFixture()
    settingsRepository.setMaxGenerationAttempts(1)

    const result = generateTimetable(YEAR)
    expect(result.status).toBe('FAILED')
    expect(result.search!.stopReason).toBe('attempts')
    expect(result.search!.limitAttempts).toBe(1)
    expect(result.search!.attempts).toBeLessThanOrEqual(1)

    const diag = result.diagnostics.find((d) => d.code === GenerationDiagnosticCode.SEARCH_LIMIT_REACHED)
    expect(diag).toBeTruthy()
    const details = detailsOf(diag!)
    expect(details.reason).toContain('attempt limit')
    expect(details.suggestedAction).toContain('attempt')

    expect(timetableGenerationRepository.findById(result.generationId)!.status).toBe('FAILED')
    expect(draftTimetableEntryRepository.findByGeneration(result.generationId)).toHaveLength(0)
  })

  it('stops at the configured time limit and says so', () => {
    seedCommonFixture()
    settingsRepository.setGenerationTimeoutMs(100)

    // Advance the clock by far more than the budget on every call so the
    // deadline check trips on the very first placement attempt.
    let tick = 0
    const spy = vi.spyOn(Date, 'now').mockImplementation(() => (tick += 1_000_000))
    try {
      const result = generateTimetable(YEAR)
      spy.mockRestore()

      expect(result.status).toBe('FAILED')
      expect(result.search!.stopReason).toBe('timeout')
      expect(result.search!.limitTimeoutMs).toBe(100)

      const diag = result.diagnostics.find((d) => d.code === GenerationDiagnosticCode.SEARCH_LIMIT_REACHED)
      expect(diag).toBeTruthy()
      const details = detailsOf(diag!)
      expect(details.reason).toContain('time limit')
      expect(details.suggestedAction).toBeTruthy()

      expect(timetableGenerationRepository.findById(result.generationId)!.status).toBe('FAILED')
      expect(draftTimetableEntryRepository.findByGeneration(result.generationId)).toHaveLength(0)
      // The published timetable is untouched by a timed-out run.
      expect(timetableEntryRepository.count()).toBe(0)
    } finally {
      spy.mockRestore()
    }
  })
})

// ---------------------------------------------------------------------------
// 5. Independent validation
// ---------------------------------------------------------------------------
describe('draft validation and publish refusal', () => {
  it('validation catches a tampered draft and publish refuses it', () => {
    seedCommonFixture()
    const result = generateTimetable(YEAR)
    expect(result.status).toBe('COMPLETED')

    // Tamper: drop a second activity into a period the lab already occupies.
    const entries = draftTimetableEntryRepository.findByGenerationWithRelations(result.generationId)
    const lab = entries.find((e) => e.classType === 'LAB')!
    const covered = resolveCoveredSlots(lab.timeSlotId, lab.span)
    if ('error' in covered) throw new Error(covered.error)
    const clashSlotId = covered.slots[1].id

    testDb!
      .prepare(
        `INSERT INTO draft_timetable_entries
           (id, generation_id, academic_year_id, day_of_week, time_slot_id, section_id,
            subject_id, class_type, span, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'DRAFT', datetime('now'), datetime('now'))`
      )
      .run('draft-dup', result.generationId, YEAR, lab.dayOfWeek, clashSlotId, lab.sectionId, 'sub-chem', 'LAB', 1)

    const validation = validateDraftTimetable(result.generationId)
    expect(validation.valid).toBe(false)
    expect(validation.errors.join('\n')).toMatch(/double-booked/i)
    expect(validation.errors.join('\n')).toMatch(/requires exactly/i)

    expect(() => publishDraftTimetable(result.generationId)).toThrow(/failed validation/i)
    // Nothing was published.
    expect(timetableEntryRepository.count()).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// 6. Publication
// ---------------------------------------------------------------------------
describe('publishing a draft', () => {
  it('replaces covered sections, keeps unrelated ones, audits, and never touches data early', () => {
    seedCommonFixture()
    // Prior master timetable: one entry for a covered section, one for sec-x
    // (which the draft does not cover — it must survive publication).
    timetableEntryRepository.create({
      id: 'old-a1',
      academicYearId: YEAR,
      dayOfWeek: 'MONDAY',
      timeSlotId: 'slot-1',
      sectionId: 'sec-a',
      subjectId: 'sub-cs',
      classType: 'LECTURE',
      span: 1,
      facultyIds: ['fac-1'],
      roomIds: ['room-101'],
    })
    timetableEntryRepository.create({
      id: 'old-x1',
      academicYearId: YEAR,
      dayOfWeek: 'MONDAY',
      timeSlotId: 'slot-1',
      sectionId: 'sec-x',
      subjectId: 'sub-x',
      classType: 'LECTURE',
      span: 1,
      facultyIds: ['fac-2'],
      roomIds: [],
    })

    const result = generateTimetable(YEAR)
    expect(result.status).toBe('COMPLETED')

    // Generation alone must never modify the published timetable.
    expect(timetableEntryRepository.count()).toBe(2)
    expect(validateDraftTimetable(result.generationId).valid).toBe(true)

    const published = publishDraftTimetable(result.generationId)
    expect(published.publishedEntries).toBe(4)
    expect(published.replacedEntries).toBe(1)
    expect(published.untouchedSections).toBe(1)
    expect(published.substitutionRecordsRemapped).toBe(0)
    expect(published.substitutionRecordsSuperseded).toBe(0)

    // Master timetable now mirrors the draft for covered sections…
    const draft = draftTimetableEntryRepository.findByGenerationWithRelations(result.generationId)
    const master = timetableEntryRepository.getWithRelations(YEAR)
    const cell = (e: { dayOfWeek: string; timeSlotId: string; sectionId: string }) =>
      `${e.sectionId}|${e.dayOfWeek}|${e.timeSlotId}`
    expect(master.filter((e) => e.sectionId === 'sec-a').map(cell).sort()).toEqual(
      draft.filter((e) => e.sectionId === 'sec-a').map(cell).sort()
    )
    expect(master.filter((e) => e.sectionId === 'sec-b')).toHaveLength(1)

    // …while unrelated sections keep their exact rows.
    expect(timetableEntryRepository.findById('old-x1')).toBeTruthy()
    expect(timetableEntryRepository.findById('old-a1')).toBeNull()

    // Draft rows become PUBLISHED history.
    const statuses = testDb!
      .prepare('SELECT DISTINCT status FROM draft_timetable_entries WHERE generation_id = ?')
      .all(result.generationId) as { status: string }[]
    expect(statuses.map((s) => s.status)).toEqual(['PUBLISHED'])
    expect(getGenerationStatus(result.generationId)!.published).toBe(true)

    // Audit entry names the generation and what happened.
    const audits = auditLogRepository.findWhere({ action: AUDIT_ACTIONS.TIMETABLE_UPDATED, entityId: result.generationId })
    expect(audits).toHaveLength(1)
    expect(audits[0].detail).toContain(`Published generation ${result.generationId}`)
    expect(audits[0].detail).toContain('4 entries across 2 section(s)')
  })

  it('rolls back when the draft clashes with a kept section — prior timetable stays identical', () => {
    seedCommonFixture()
    timetableEntryRepository.create({
      id: 'old-a1',
      academicYearId: YEAR,
      dayOfWeek: 'MONDAY',
      timeSlotId: 'slot-1',
      sectionId: 'sec-a',
      subjectId: 'sub-cs',
      classType: 'LECTURE',
      span: 1,
      facultyIds: ['fac-1'],
      roomIds: ['room-101'],
    })

    const result = generateTimetable(YEAR)
    expect(result.status).toBe('COMPLETED')

    // A section the draft does NOT cover keeps a faculty member busy in the
    // same period the draft wants to use that faculty member.
    const draft = draftTimetableEntryRepository.findByGenerationWithRelations(result.generationId)
    const clash = draft.find((e) => (e.facultyList ?? []).length > 0)!
    timetableEntryRepository.create({
      id: 'old-x1',
      academicYearId: YEAR,
      dayOfWeek: clash.dayOfWeek,
      timeSlotId: clash.timeSlotId,
      sectionId: 'sec-x',
      subjectId: 'sub-x',
      classType: 'LECTURE',
      span: 1,
      facultyIds: clash.facultyList!.map((f) => f.id),
      roomIds: [],
    })

    expect(() => publishDraftTimetable(result.generationId)).toThrow(/double-book/i)

    // Nothing changed: prior rows intact, drafts still DRAFT, no audit entry.
    expect(timetableEntryRepository.count()).toBe(2)
    expect(timetableEntryRepository.findById('old-a1')).toBeTruthy()
    expect(timetableEntryRepository.findById('old-x1')).toBeTruthy()
    const statuses = testDb!
      .prepare('SELECT DISTINCT status FROM draft_timetable_entries WHERE generation_id = ?')
      .all(result.generationId) as { status: string }[]
    expect(statuses.map((s) => s.status)).toEqual(['DRAFT'])
    expect(auditLogRepository.findWhere({ action: AUDIT_ACTIONS.TIMETABLE_UPDATED })).toHaveLength(0)
  })

  it('rolls back a mid-transaction database failure — deletes and partial inserts are undone', () => {
    seedCommonFixture()
    timetableEntryRepository.create({
      id: 'old-a1',
      academicYearId: YEAR,
      dayOfWeek: 'MONDAY',
      timeSlotId: 'slot-1',
      sectionId: 'sec-a',
      subjectId: 'sub-cs',
      classType: 'LECTURE',
      span: 1,
      facultyIds: ['fac-1'],
      roomIds: ['room-101'],
    })

    const result = generateTimetable(YEAR)
    expect(result.status).toBe('COMPLETED')

    // Fail the SECOND insert into the master timetable, after publish has
    // already deleted the old rows and written at least one new one.
    testDb!.exec('CREATE TABLE boom(cnt INTEGER NOT NULL)')
    testDb!.exec('INSERT INTO boom (cnt) VALUES (0)')
    testDb!.exec(`
      CREATE TRIGGER fail_publish BEFORE INSERT ON timetable_entries
      BEGIN
        UPDATE boom SET cnt = cnt + 1;
        SELECT RAISE(ABORT, 'simulated disk failure')
          WHERE (SELECT cnt FROM boom) >= 2;
      END
    `)

    let message = ''
    try {
      publishDraftTimetable(result.generationId)
    } catch (error) {
      message = error instanceof Error ? error.message : String(error)
    }
    testDb!.exec('DROP TRIGGER fail_publish')

    expect(message).toMatch(/rolled back/i)
    expect(message).toContain('simulated disk failure')

    // Transactional integrity: the previous timetable is byte-identical.
    expect(timetableEntryRepository.count()).toBe(1)
    expect(timetableEntryRepository.findById('old-a1')).toBeTruthy()
    const statuses = testDb!
      .prepare('SELECT DISTINCT status FROM draft_timetable_entries WHERE generation_id = ?')
      .all(result.generationId) as { status: string }[]
    expect(statuses.map((s) => s.status)).toEqual(['DRAFT'])
    expect(auditLogRepository.findWhere({ action: AUDIT_ACTIONS.TIMETABLE_UPDATED })).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// 7. Substitution records across publication
// ---------------------------------------------------------------------------
describe('substitution records across publish', () => {
  it('remaps assignments to the replacement cell and supersedes the rest (runs retained)', () => {
    seedCommonFixture()
    const result = generateTimetable(YEAR)
    expect(result.status).toBe('COMPLETED')

    const draft = draftTimetableEntryRepository.findByGenerationWithRelations(result.generationId)
    const target = draft.find((e) => e.sectionId === 'sec-a')!

    // Find a cell for sec-a the draft does NOT use (→ superseded on publish).
    const occupied = new Set(
      draft.filter((e) => e.sectionId === 'sec-a').map((e) => `${e.dayOfWeek}|${e.timeSlotId}`)
    )
    let freeDay = ''
    let freeSlot = ''
    for (const day of settingsRepository.getWorkingDays()) {
      for (const slot of timeSlotRepository.getTeachingSlots()) {
        if (!occupied.has(`${day}|${slot.id}`)) {
          freeDay = day
          freeSlot = slot.id
          break
        }
      }
      if (freeDay) break
    }
    expect(freeDay).toBeTruthy()

    // Historical entries + their substitution assignments.
    timetableEntryRepository.create({
      id: 'old-remap',
      academicYearId: YEAR,
      dayOfWeek: target.dayOfWeek,
      timeSlotId: target.timeSlotId,
      sectionId: 'sec-a',
      subjectId: 'sub-cs',
      classType: 'LECTURE',
      span: 1,
      facultyIds: ['fac-1'],
      roomIds: [],
    })
    timetableEntryRepository.create({
      id: 'old-gone',
      academicYearId: YEAR,
      dayOfWeek: freeDay,
      timeSlotId: freeSlot,
      sectionId: 'sec-a',
      subjectId: 'sub-math',
      classType: 'LECTURE',
      span: 1,
      facultyIds: [],
      roomIds: [],
    })
    substitutionRunRepository.create({ id: 'run-1', date: '2026-10-12', status: 'DRAFT' })
    substitutionAssignmentRepository.create({
      id: 'sub-remap',
      runId: 'run-1',
      originalEntryId: 'old-remap',
      substituteFacultyId: 'fac-3',
      status: 'PENDING',
      isLocked: false,
    })
    substitutionAssignmentRepository.create({
      id: 'sub-gone',
      runId: 'run-1',
      originalEntryId: 'old-gone',
      substituteFacultyId: 'fac-3',
      status: 'PENDING',
      isLocked: false,
    })

    const published = publishDraftTimetable(result.generationId)
    expect(published.substitutionRecordsRemapped).toBe(1)
    expect(published.substitutionRecordsSuperseded).toBe(1)

    // The remapped assignment points at the replacement entry of the SAME cell.
    const remapped = substitutionAssignmentRepository.findById('sub-remap')
    expect(remapped).toBeTruthy()
    const newEntry = timetableEntryRepository.findById(remapped!.originalEntryId)
    expect(newEntry).toBeTruthy()
    expect(newEntry!.sectionId).toBe('sec-a')
    expect(newEntry!.dayOfWeek).toBe(target.dayOfWeek)
    expect(newEntry!.timeSlotId).toBe(target.timeSlotId)

    // The superseded assignment is accounted for (row removed with its entry),
    // but the run itself is preserved and the outcome is audited.
    expect(substitutionAssignmentRepository.findById('sub-gone')).toBeNull()
    expect(substitutionRunRepository.findById('run-1')).toBeTruthy()

    const audits = auditLogRepository.findWhere({ action: AUDIT_ACTIONS.TIMETABLE_UPDATED, entityId: result.generationId })
    expect(audits).toHaveLength(1)
    expect(audits[0].detail).toContain('1 substitution record(s) kept against their replacement period')
    expect(audits[0].detail).toContain('superseded')
  })
})

// ---------------------------------------------------------------------------
// 12. Regression: summary helpers bind every SQL parameter (subject-scoped)
// ---------------------------------------------------------------------------
describe('summary helper queries (regression)', () => {
  beforeEach(() => {
    // Two subjects in sec-a plus the same subject in sec-b, so both a
    // parameter-count error and a missing subject filter are caught here.
    addRequirement('req-r-cs', 'sec-a', 'sub-cs', 'LECTURE', 2, 1)
    addRequirement('req-r-math', 'sec-a', 'sub-math', 'LECTURE', 3, 1)
    addRequirement('req-r-cs-b', 'sec-b', 'sub-cs', 'LECTURE', 4, 1)
    addAllocation('alloc-r-cs', 'fac-1', 'sec-a', 'sub-cs', 'LECTURE', 2)
    addAllocation('alloc-r-math', 'fac-2', 'sec-a', 'sub-math', 'LECTURE', 3)
    addAllocation('alloc-r-cs-b', 'fac-3', 'sec-b', 'sub-cs', 'LECTURE', 4)
  })

  it('requirement count/lookup helpers filter by section, subject and class type', () => {
    expect(subjectRequirementRepository.getRequiredSessionsForSectionSubject(YEAR, 'sec-a', 'sub-cs')).toBe(2)
    expect(subjectRequirementRepository.getRequiredSessionsForClassType(YEAR, 'sec-a', 'sub-cs', 'LECTURE')).toBe(2)
    expect(subjectRequirementRepository.getRequiredSessionsForClassType(YEAR, 'sec-a', 'sub-math', 'LECTURE')).toBe(3)
    expect(subjectRequirementRepository.getRequiredSessionsForSectionSubject(YEAR, 'sec-b', 'sub-cs')).toBe(4)

    const rows = getSubjectRequirementsBySectionSubjectClassType(YEAR, 'sec-a', 'sub-cs', 'LECTURE')
    expect(rows).toHaveLength(1)
    expect(rows[0].subject_id).toBe('sub-cs')
    expect(rows[0].required_sessions_per_week).toBe(2)
  })

  it('allocation count/lookup helpers filter by section, subject and class type', () => {
    expect(getTotalSessionsForSectionSubject(YEAR, 'sec-a', 'sub-cs')).toBe(2)
    expect(getTotalSessionsForSectionSubject(YEAR, 'sec-a', 'sub-math')).toBe(3)
    expect(getTotalSessionsForSectionSubject(YEAR, 'sec-b', 'sub-cs')).toBe(4)

    const allocs = getTeachingAllocationsBySectionSubject(YEAR, 'sec-a', 'sub-cs')
    expect(allocs).toHaveLength(1)
    expect(allocs[0].subject_id).toBe('sub-cs')
    expect(allocs[0].faculty_id).toBe('fac-1')

    expect(getRequiredSessionsForClassType(YEAR, 'sec-a', 'sub-cs', 'LECTURE')).toBe(2)
    expect(getRequiredSessionsForClassType(YEAR, 'sec-b', 'sub-cs', 'LECTURE')).toBe(4)
  })
})

// ---------------------------------------------------------------------------
// 13. Repeated publication is refused without touching any data
// ---------------------------------------------------------------------------
describe('repeated publication guard', () => {
  it('refuses a second publish of the same run; timetable, substitutions and audit stay intact', () => {
    seedCommonFixture()
    const result = generateTimetable(YEAR)
    expect(result.status).toBe('COMPLETED')

    // A historical entry on a covered cell, with a substitution assignment —
    // the first publish remaps that assignment onto the replacement entry.
    const draft = draftTimetableEntryRepository.findByGenerationWithRelations(result.generationId)
    const target = draft.find((e) => e.sectionId === 'sec-a')!
    timetableEntryRepository.create({
      id: 'old-guard',
      academicYearId: YEAR,
      dayOfWeek: target.dayOfWeek,
      timeSlotId: target.timeSlotId,
      sectionId: 'sec-a',
      subjectId: 'sub-cs',
      classType: 'LECTURE',
      span: 1,
      facultyIds: ['fac-1'],
      roomIds: [],
    })
    substitutionRunRepository.create({ id: 'run-guard', date: '2026-10-12', status: 'DRAFT' })
    substitutionAssignmentRepository.create({
      id: 'sub-guard',
      runId: 'run-guard',
      originalEntryId: 'old-guard',
      substituteFacultyId: 'fac-3',
      status: 'PENDING',
      isLocked: false,
    })

    const first = publishDraftTimetable(result.generationId)
    expect(first.publishedEntries).toBe(4)
    expect(first.substitutionRecordsRemapped).toBe(1)

    // Snapshot everything a second publish could possibly alter.
    const entriesBefore = JSON.stringify(timetableEntryRepository.findByAcademicYear(YEAR))
    const assignmentBefore = JSON.stringify(substitutionAssignmentRepository.findById('sub-guard'))
    const auditsBefore = auditLogRepository.findWhere({
      action: AUDIT_ACTIONS.TIMETABLE_UPDATED,
      entityId: result.generationId,
    })
    expect(auditsBefore).toHaveLength(1)
    expect(assignmentBefore).not.toBeNull()

    // The second attempt fails with a clear error before any transaction.
    expect(() => publishDraftTimetable(result.generationId)).toThrow(/already been published/i)

    // Byte-identical published timetable, unchanged substitution history,
    // still exactly one audit entry, drafts still PUBLISHED.
    expect(JSON.stringify(timetableEntryRepository.findByAcademicYear(YEAR))).toBe(entriesBefore)
    expect(JSON.stringify(substitutionAssignmentRepository.findById('sub-guard'))).toBe(assignmentBefore)
    const auditsAfter = auditLogRepository.findWhere({
      action: AUDIT_ACTIONS.TIMETABLE_UPDATED,
      entityId: result.generationId,
    })
    expect(auditsAfter).toHaveLength(1)
    expect(getGenerationStatus(result.generationId)!.published).toBe(true)
    expect(timetableGenerationRepository.findById(result.generationId)!.status).toBe('COMPLETED')
  })
})

// ---------------------------------------------------------------------------
// 14. Stale RUNNING recovery after an unexpected shutdown
// ---------------------------------------------------------------------------
describe('stale RUNNING recovery', () => {
  it('fails an abandoned run while preserving its diagnostics, drafts and every terminal run', () => {
    seedCommonFixture()

    // A healthy completed run (terminal — must never be selected).
    const healthy = generateTimetable(YEAR)
    expect(healthy.status).toBe('COMPLETED')
    const healthyBefore = timetableGenerationRepository.findById(healthy.generationId)!

    // A run abandoned by a crash: RUNNING row + persisted diagnostic + draft
    // rows (crash after draft persistence, before the status transition).
    timetableGenerationRepository.create({
      id: 'gen-stale',
      academicYearId: YEAR,
      status: 'RUNNING',
    })
    generationDiagnosticRepository.create({
      id: 'diag-stale',
      generationId: 'gen-stale',
      teachingAllocationId: null,
      severity: 'WARNING',
      code: 'INSUFFICIENT_ROOMS',
      message: 'warning persisted before the shutdown',
      details: '{}',
    })
    draftTimetableEntryRepository.create({
      id: 'draft-stale',
      generationId: 'gen-stale',
      academicYearId: YEAR,
      dayOfWeek: 'MONDAY',
      timeSlotId: 'slot-1',
      sectionId: 'sec-a',
      subjectId: 'sub-cs',
      classType: 'LECTURE',
      span: 1,
      status: 'DRAFT',
      facultyIds: ['fac-1'],
      roomIds: [],
    })

    const recovered = recoverStaleGenerations()
    expect(recovered).toEqual(['gen-stale'])

    // The stale run is FAILED with an explicit interrupted summary…
    const stale = timetableGenerationRepository.findById('gen-stale')!
    expect(stale.status).toBe('FAILED')
    expect(stale.completedAt).toBeTruthy()
    expect(stale.diagnosticsSummary).toContain('interrupted')

    // …while its diagnostic and draft history are preserved…
    expect(generationDiagnosticRepository.findByGeneration('gen-stale')).toHaveLength(1)
    const drafts = draftTimetableEntryRepository.findByGeneration('gen-stale')
    expect(drafts).toHaveLength(1)
    expect(drafts[0].status).toBe('DRAFT')

    // …terminal runs are untouched, and nothing else is returned/changed.
    const healthyAfter = timetableGenerationRepository.findById(healthy.generationId)!
    expect(healthyAfter.status).toBe('COMPLETED')
    expect(healthyAfter.diagnosticsSummary).toBe(healthyBefore.diagnosticsSummary)

    // A second recovery is a no-op (idempotent).
    expect(recoverStaleGenerations()).toEqual([])
  })

  it('never fails a generation that is genuinely in flight', () => {
    seedCommonFixture()

    // Re-enter recovery from a mid-run hook: at that moment the generation
    // row exists with status RUNNING and its id is in flight.
    const originalBulkCreate = draftTimetableEntryRepository.bulkCreate.bind(draftTimetableEntryRepository)
    let statusMidRun: string | null = null
    let recoveredMidRun: string[] = ['not-run']
    vi.spyOn(draftTimetableEntryRepository, 'bulkCreate').mockImplementation((entries: any[]) => {
      const row = testDb!.prepare('SELECT status FROM timetable_generations').get() as { status: string }
      statusMidRun = row.status
      recoveredMidRun = recoverStaleGenerations()
      return originalBulkCreate(entries)
    })

    const result = generateTimetable(YEAR)
    expect(result.status).toBe('COMPLETED')

    // Mid-run: the row really was RUNNING, recovery skipped it entirely…
    expect(statusMidRun).toBe('RUNNING')
    expect(recoveredMidRun).toEqual([])
    // …and the run completed normally afterwards.
    expect(timetableGenerationRepository.findById(result.generationId)!.status).toBe('COMPLETED')
  })
})

// ---------------------------------------------------------------------------
// 15. Manual-testing fixes: staff type (teaching vs non-teaching) and the
//     configurable teaching arrangement (TEAM vs ALTERNATE vs AUTO)
// ---------------------------------------------------------------------------
describe('generation: staff type and teaching arrangement', () => {
  it('refuses to schedule a non-teaching faculty member and names them', () => {
    seedCommonFixture()
    facultyRepository.update('fac-1', { staffType: 'NON_TEACHING' })

    const result = generateTimetable(YEAR)
    expect(result.status).toBe('FAILED')

    const diag = result.diagnostics.find((d) => /non-teaching/i.test(d.message))
    expect(diag, 'a diagnostic must explain the non-teaching allocation').toBeTruthy()
    expect(diag!.severity).toBe('ERROR')
    expect(diag!.code).toBe(GenerationDiagnosticCode.INPUT_INVALID)
    expect(diag!.message).toContain('Dr. Asha')
    expect(detailsOf(diag!).suggestedAction).toMatch(/allocation/i)

    // Nothing was scheduled and no diagnostics were lost along the way.
    expect(draftTimetableEntryRepository.findByGeneration(result.generationId)).toHaveLength(0)
    expect(generationDiagnosticRepository.findByGeneration(result.generationId).length).toBeGreaterThan(0)
  })

  it('requires at least two teachers when an explicit TEAM arrangement is configured', () => {
    addRequirement('req-team1', 'sec-a', 'sub-cs', 'LECTURE', 2, 1, 'TEAM')
    addAllocation('alloc-team1', 'fac-1', 'sec-a', 'sub-cs', 'LECTURE', 2)

    const result = generateTimetable(YEAR)
    expect(result.status).toBe('FAILED')

    const diag = result.diagnostics.find(
      (d) => d.code === GenerationDiagnosticCode.INPUT_INVALID && /teaching Team/i.test(d.message)
    )
    expect(diag, 'an incomplete team must be diagnosed').toBeTruthy()
    expect(diag!.message).toContain('only 1 teacher is allocated')
    const details = detailsOf(diag!)
    expect(details.suggestedAction).toMatch(/second teacher/i)
    expect(details.suggestedAction).toMatch(/Alternate|Automatic/i)
    expect(draftTimetableEntryRepository.findByGeneration(result.generationId)).toHaveLength(0)
  })

  it('schedules an explicitly configured TEAM with every teacher on every session', () => {
    addRequirement('req-team', 'sec-c', 'sub-x', 'LECTURE', 3, 1, 'TEAM')
    addAllocation('alloc-t1', 'fac-1', 'sec-c', 'sub-x', 'LECTURE', 1)
    addAllocation('alloc-t2', 'fac-2', 'sec-c', 'sub-x', 'LECTURE', 1)
    addAllocation('alloc-t3', 'fac-3', 'sec-c', 'sub-x', 'LECTURE', 1)

    const result = generateTimetable(YEAR)
    expect(result.status).toBe('COMPLETED')

    const entries = draftTimetableEntryRepository.findByGenerationWithRelations(result.generationId)
    expect(entries).toHaveLength(3)
    for (const entry of entries) {
      const ids = (entry.facultyList ?? []).map((f) => f.id).sort()
      expect(ids, `session on ${entry.dayOfWeek}`).toEqual(['fac-1', 'fac-2', 'fac-3'])
    }
    expect(validateDraftTimetable(result.generationId).errors).toEqual([])
  })

  it('schedules an explicitly configured ALTERNATE with one teacher per session, spread across the team', () => {
    addRequirement('req-alt', 'sec-c', 'sub-chem', 'LAB', 3, 2, 'ALTERNATE')
    addAllocation('alloc-a1', 'fac-1', 'sec-c', 'sub-chem', 'LAB', 1)
    addAllocation('alloc-a2', 'fac-2', 'sec-c', 'sub-chem', 'LAB', 1)
    addAllocation('alloc-a3', 'fac-3', 'sec-c', 'sub-chem', 'LAB', 1)

    const result = generateTimetable(YEAR)
    expect(result.status).toBe('COMPLETED')

    const entries = draftTimetableEntryRepository.findByGenerationWithRelations(result.generationId)
    expect(entries).toHaveLength(3)
    const used: string[] = []
    for (const entry of entries) {
      expect(entry.facultyList, `session on ${entry.dayOfWeek}`).toHaveLength(1)
      used.push(entry.facultyList![0].id)
    }
    // Separate sessions: each allocated teacher takes their own session.
    expect(new Set(used).size).toBe(3)
    expect(validateDraftTimetable(result.generationId).errors).toEqual([])
  })

  it('rejects a draft where a teaching-team session is missing an allocated teacher', () => {
    addRequirement('req-team-v', 'sec-c', 'sub-x', 'LECTURE', 2, 1, 'TEAM')
    addAllocation('alloc-tv1', 'fac-1', 'sec-c', 'sub-x', 'LECTURE', 1)
    addAllocation('alloc-tv2', 'fac-2', 'sec-c', 'sub-x', 'LECTURE', 1)

    const result = generateTimetable(YEAR)
    expect(result.status).toBe('COMPLETED')
    expect(validateDraftTimetable(result.generationId).errors).toEqual([])

    // Tamper with the persisted draft (hand edit / damaged import): drop the
    // second teacher from every session.
    testDb!
      .prepare(
        `DELETE FROM draft_timetable_entry_faculty
         WHERE faculty_id = 'fac-2'
           AND entry_id IN (SELECT id FROM draft_timetable_entries WHERE generation_id = ?)`
      )
      .run(result.generationId)

    const validation = validateDraftTimetable(result.generationId)
    expect(validation.errors.some((e) => /teaching-team session is missing Dr\. Binu/.test(e))).toBe(true)
  })

  it('rejects a draft where an alternate session has more than one teacher', () => {
    addRequirement('req-alt-v', 'sec-c', 'sub-chem', 'LAB', 2, 2, 'ALTERNATE')
    addAllocation('alloc-av1', 'fac-1', 'sec-c', 'sub-chem', 'LAB', 1)
    addAllocation('alloc-av2', 'fac-2', 'sec-c', 'sub-chem', 'LAB', 1)

    const result = generateTimetable(YEAR)
    expect(result.status).toBe('COMPLETED')
    expect(validateDraftTimetable(result.generationId).errors).toEqual([])

    // Tamper: attach a second teacher to one of the alternating sessions.
    const entry = testDb!
      .prepare('SELECT id FROM draft_timetable_entries WHERE generation_id = ? LIMIT 1')
      .get(result.generationId) as { id: string }
    testDb!
      .prepare('INSERT INTO draft_timetable_entry_faculty (entry_id, faculty_id, position) VALUES (?, ?, 9)')
      .run(entry.id, 'fac-2')

    const validation = validateDraftTimetable(result.generationId)
    expect(validation.errors.some((e) => /alternate teaching means exactly one teacher/.test(e))).toBe(true)
  })

  it('rejects a scheduled session whose teacher was reclassified as non-teaching', () => {
    addRequirement('req-nt', 'sec-c', 'sub-x', 'LECTURE', 1, 1)
    addAllocation('alloc-nt', 'fac-1', 'sec-c', 'sub-x', 'LECTURE', 1)

    const result = generateTimetable(YEAR)
    expect(result.status).toBe('COMPLETED')

    // The coordinator reclassifies the person after the draft was built.
    facultyRepository.update('fac-1', { staffType: 'NON_TEACHING' })

    const validation = validateDraftTimetable(result.generationId)
    expect(
      validation.errors.some((e) => /Dr\. Asha is non-teaching staff and can never be scheduled/.test(e))
    ).toBe(true)
  })

  it('effectiveTeachingArrangement: explicit always wins, AUTO keeps the historical rule', () => {
    expect(effectiveTeachingArrangement({ classType: 'LAB', teachingArrangement: 'TEAM' }, 3)).toBe('TEAM')
    expect(effectiveTeachingArrangement({ classType: 'LAB', teachingArrangement: 'TEAM' }, 1)).toBe('TEAM')
    expect(effectiveTeachingArrangement({ classType: 'LECTURE', teachingArrangement: 'ALTERNATE' }, 3)).toBe('ALTERNATE')
    expect(effectiveTeachingArrangement({ classType: 'LAB', teachingArrangement: 'AUTO' }, 3)).toBe('TEAM')
    expect(effectiveTeachingArrangement({ classType: 'LAB', teachingArrangement: 'AUTO' }, 1)).toBe('ALTERNATE')
    expect(effectiveTeachingArrangement({ classType: 'LECTURE', teachingArrangement: 'AUTO' }, 3)).toBe('ALTERNATE')
    // The subject's class type and configuration decide — never its name.
    expect(effectiveTeachingArrangement({ classType: 'LECTURE', teachingArrangement: undefined as any }, 5)).toBe(
      'ALTERNATE'
    )
  })
})
