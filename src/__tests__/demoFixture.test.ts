/**
 * Demo environment — isolation guards, deterministic fixture, real weekly
 * generation and both substitution scenarios, all on isolated databases
 * (in-memory SQLite or mkdtemp directories). Nothing here can touch the
 * production database: the demo path guards are asserted directly, and every
 * service call runs against the in-memory fixture database.
 *
 * Coverage (per demo spec):
 *  1. Path safety: the demo resolves to <repo>/.substiflow-demo and refuses
 *     non-canonical locations, production paths, unmarked/symlinked removal.
 *  2. Fixture: exact seeded counts; duplicated source codes preserved and
 *     flagged (never "corrected"); non-teaching staff unallocated;
 *     deterministic rebuild; reseeding refuses (no duplicates, full rollback).
 *  3. Generation: the real engine schedules all 124 demo sessions — independent
 *     validation passes, spans/breaks/days honoured, no faculty/section/room
 *     double-booking, TEAM on every session, ALTERNATE split, labs contiguous,
 *     non-teaching staff never placed, publish lands all entries.
 *  4. Substitution: scenario A covers an absence with independently verified
 *     eligible substitutes (teaching, present, free, within daily caps) and
 *     approves; scenario B (whole staff absent) reports every class uncovered
 *     and assigns nobody ineligible.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import Database from 'better-sqlite3'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { schema } from '@/db/schema'
import {
  resolveDemoPaths,
  assertSafeDemoPaths,
  assertRemovableDemoDir,
  productionDataDir,
  writeDemoMarker,
  DEMO_DIR_NAME,
} from '@/db/demoPaths'
import {
  buildDemoFixture,
  applyDemoSchema,
  DEMO_EXPECTED_COUNTS,
  DEMO_YEAR_ID,
} from '@/db/demoFixture'
import {
  generateTimetable,
  validateDraftTimetable,
  publishDraftTimetable,
} from '@/services/timetableGenerator'
import { generateSubstitutions, approveSubstitutionRun, getRevisedTimetable } from '@/services/substitution'
import { attendanceRepository } from '@/db/repositories/attendance'

let testDb: Database.Database | null = null

vi.mock('@/db/database', () => ({
  getDatabase: () => testDb,
  closeDatabase: () => undefined,
}))

/* ------------------------------------------------------------------ *
 * 1. Demo path isolation guards (pure functions, no database)
 * ------------------------------------------------------------------ */

describe('demo path isolation', () => {
  it('resolves the demo database inside <root>/.substiflow-demo/database', () => {
    const p = resolveDemoPaths('/tmp/some-repo')
    expect(p.demoDir).toBe(path.resolve('/tmp/some-repo', DEMO_DIR_NAME))
    expect(p.dbPath).toBe(
      path.resolve('/tmp/some-repo', DEMO_DIR_NAME, 'database', 'substiflow.db')
    )
  })

  it('maps the production data directory per platform', () => {
    expect(productionDataDir({}, 'darwin', '/Users/x')).toBe(
      '/Users/x/Library/Application Support/SubstiFlow'
    )
    expect(productionDataDir({ APPDATA: 'C:\\Roaming' }, 'win32', 'C:\\Users\\x')).toBe(
      path.win32.join('C:\\Roaming', 'SubstiFlow')
    )
    expect(productionDataDir({}, 'linux', '/home/x')).toBe('/home/x/.config/SubstiFlow')
    expect(productionDataDir({ XDG_CONFIG_HOME: '/custom' }, 'linux', '/home/x')).toBe(
      '/custom/SubstiFlow'
    )
  })

  it('refuses a non-canonical demo location', () => {
    const p = resolveDemoPaths('/tmp/some-repo')
    const rogue = {
      ...p,
      demoDir: path.join(os.tmpdir(), 'rogue-demo'),
      dbPath: path.join(os.tmpdir(), 'rogue-demo', 'database', 'substiflow.db'),
      markerPath: path.join(os.tmpdir(), 'rogue-demo', 'marker'),
    }
    expect(() => assertSafeDemoPaths(rogue, { productionDataDir: '/unused' })).toThrow(/canonical/)
  })

  it('refuses demo paths that resolve inside the production data directory', () => {
    const prod = path.join('/Users/x', 'Library', 'Application Support', 'SubstiFlow')
    const p = resolveDemoPaths(path.join(prod, 'sneaky-repo'))
    expect(() => assertSafeDemoPaths(p, { productionDataDir: prod })).toThrow(
      /production data directory/
    )
  })

  it('refuses when the production data directory sits inside the demo directory', () => {
    const p = resolveDemoPaths('/tmp/some-repo')
    const prodInside = path.join('/tmp/some-repo', DEMO_DIR_NAME, 'prod-profile')
    expect(() => assertSafeDemoPaths(p, { productionDataDir: prodInside })).toThrow(
      /inside the demo directory/
    )
  })

  it('accepts the canonical isolated path', () => {
    const p = resolveDemoPaths('/tmp/some-repo')
    expect(() => assertSafeDemoPaths(p)).not.toThrow()
  })

  it('cleanup guard: refuses missing/unmarked/symlinked dirs, accepts a marked demo dir', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'demo-guard-'))
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'demo-outside-'))
    try {
      const p = resolveDemoPaths(tmp)
      // Missing directory
      expect(() => assertRemovableDemoDir(p)).toThrow(/does not exist/)
      // Existing but not created by demo:setup (no marker)
      fs.mkdirSync(p.demoDir, { recursive: true })
      expect(() => assertRemovableDemoDir(p)).toThrow(/marker file/)
      // Symlinked directory
      fs.rmdirSync(p.demoDir)
      fs.symlinkSync(outside, p.demoDir)
      expect(() => assertRemovableDemoDir(p)).toThrow(/symlink/)
      fs.unlinkSync(p.demoDir)
      // Properly marked demo directory
      fs.mkdirSync(p.demoDir, { recursive: true })
      writeDemoMarker(p)
      expect(() => assertRemovableDemoDir(p)).not.toThrow()
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true })
      fs.rmSync(outside, { recursive: true, force: true })
    }
  })
})

/* ------------------------------------------------------------------ *
 * 2. Fixture determinism and contents
 * ------------------------------------------------------------------ */

function fixtureCounts(db: Database.Database) {
  const c = (sql: string) => (db.prepare(sql).get() as { c: number }).c
  return {
    academicYears: c('SELECT COUNT(*) AS c FROM academic_years'),
    departments: c('SELECT COUNT(*) AS c FROM departments'),
    sections: c('SELECT COUNT(*) AS c FROM sections'),
    subjects: c('SELECT COUNT(*) AS c FROM subjects'),
    faculty: c('SELECT COUNT(*) AS c FROM faculty'),
    teachingFaculty: c(`SELECT COUNT(*) AS c FROM faculty WHERE staff_type = 'TEACHING'`),
    nonTeachingFaculty: c(`SELECT COUNT(*) AS c FROM faculty WHERE staff_type = 'NON_TEACHING'`),
    rooms: c('SELECT COUNT(*) AS c FROM rooms'),
    classrooms: c(`SELECT COUNT(*) AS c FROM rooms WHERE type = 'CLASSROOM'`),
    labs: c(`SELECT COUNT(*) AS c FROM rooms WHERE type = 'LAB'`),
    timeSlots: c('SELECT COUNT(*) AS c FROM time_slots'),
    settings: c('SELECT COUNT(*) AS c FROM application_settings'),
    requirements: c('SELECT COUNT(*) AS c FROM subject_requirements'),
    allocations: c('SELECT COUNT(*) AS c FROM teaching_allocations'),
    qualifications: c('SELECT COUNT(*) AS c FROM faculty_subjects'),
    sectionAssignments: c('SELECT COUNT(*) AS c FROM faculty_sections'),
  }
}

describe('demo fixture', () => {
  beforeAll(() => {
    testDb = new Database(':memory:')
    testDb.exec(schema)
    buildDemoFixture(testDb)
  })
  afterAll(() => {
    testDb?.close()
    testDb = null
  })

  it('seeds the exact expected record counts', () => {
    const counts = fixtureCounts(testDb!)
    expect(counts).toEqual(DEMO_EXPECTED_COUNTS)
    // The counts the demo spec asks for, spelled out:
    expect(counts.sections).toBe(6) // I/III/V Semester × A & B
    expect(counts.subjects).toBe(27) // 21 from exam timetable + 6 labs/tutorials
    expect(counts.teachingFaculty).toBe(12) // Demo Faculty 01…12
    expect(counts.nonTeachingFaculty).toBe(2) // Demo Staff 01/02 — unschedulable
    expect(counts.rooms).toBe(7) // 4 classrooms + 3 labs
    expect(counts.labs).toBeGreaterThanOrEqual(3)
    expect(counts.requirements).toBe(54) // (8+9+10 subjects) × 2 sections
    expect(counts.allocations).toBe(66)
  })

  it('assigns unique, legitimate course codes with no artificial -DUP suffixes', () => {
    const rows = testDb!.prepare('SELECT name, code FROM subjects').all() as Array<{
      name: string
      code: string
    }>
    // All 27 subjects must have unique codes and no artificial -DUP suffixes or duplicate labels
    expect(rows).toHaveLength(27)
    const codes = rows.map((r) => r.code)
    expect(new Set(codes).size).toBe(27)

    for (const row of rows) {
      expect(row.code).not.toContain('DUP')
      expect(row.name.toLowerCase()).not.toContain('duplicate')
    }

    // Verify V Semester clean NEP BCA codes and exact names
    expect(rows.find((r) => r.code === '24BCA51')!.name).toBe('ML & NN')
    expect(rows.find((r) => r.code === '24BCA52')!.name).toBe('FED')
    expect(rows.find((r) => r.code === '24BCA53')!.name).toBe('BED')
    expect(rows.find((r) => r.code === '24BCA54')!.name).toBe('DIP')
    expect(rows.find((r) => r.code === '24BCA55')!.name).toBe('NLP/CC')
    expect(rows.find((r) => r.code === '24BCA56')!.name).toBe('IOT')
    expect(rows.find((r) => r.code === '24BCA57')!.name).toBe('CS')
    expect(rows.find((r) => r.code === '24BCASEC2')!.name).toBe('QT')
    expect(rows.find((r) => r.code === '24BCAL51')!.name).toBe('ML Lab')
    expect(rows.find((r) => r.code === '24BCAL52')!.name).toBe('NLP Lab')
  })

  it('never allocates, qualifies or assigns the non-teaching staff', () => {
    const c = (sql: string) => (testDb!.prepare(sql).get() as { c: number }).c
    for (const table of ['teaching_allocations', 'faculty_subjects', 'faculty_sections']) {
      expect(
        c(
          `SELECT COUNT(*) AS c FROM ${table} x JOIN faculty f ON f.id = x.faculty_id
            WHERE f.staff_type = 'NON_TEACHING'`
        ),
        `${table} must contain no non-teaching rows`
      ).toBe(0)
    }
  })

  it('is deterministic: a second fresh build yields identical rows', () => {
    const db2 = new Database(':memory:')
    try {
      db2.exec(schema)
      const counts2 = buildDemoFixture(db2)
      expect(counts2).toEqual(fixtureCounts(testDb!))
      const ids = (db: Database.Database, t: string) => {
        // Two of the compared tables use composite keys without an id column.
        const key =
          t === 'faculty_subjects'
            ? "faculty_id || '|' || subject_id"
            : t === 'faculty_sections'
              ? "faculty_id || '|' || section_id"
              : 'id'
        return (db.prepare(`SELECT ${key} AS k FROM ${t} ORDER BY k`).all() as Array<{ k: string }>).map((r) => r.k)
      }
      for (const t of [
        'sections',
        'subjects',
        'faculty',
        'rooms',
        'subject_requirements',
        'teaching_allocations',
        'faculty_subjects',
        'faculty_sections',
      ]) {
        expect(ids(db2, t), `ids of ${t}`).toEqual(ids(testDb!, t))
      }
    } finally {
      db2.close()
    }
  })

  it('refuses to seed the same database twice — no duplicates, full rollback', () => {
    const before = fixtureCounts(testDb!)
    expect(() => buildDemoFixture(testDb!)).toThrow()
    expect(fixtureCounts(testDb!)).toEqual(before)
  })

  it('applyDemoSchema stamps the current schema version', () => {
    const db = new Database(':memory:')
    try {
      applyDemoSchema(db)
      const v = (db.prepare('SELECT MAX(version) AS v FROM schema_version').get() as { v: number }).v
      expect(v).toBe(8)
      const tables = (
        db.prepare("SELECT COUNT(*) AS c FROM sqlite_master WHERE type='table' AND name='sections'").get() as { c: number }
      ).c
      expect(tables).toBe(1)
    } finally {
      db.close()
    }
  })
})

/* ------------------------------------------------------------------ *
 * 3. Real weekly generation from the demo fixture
 * ------------------------------------------------------------------ */

function spanAwareConflictCount(db: Database.Database, generationId: string, joinClauses: string): number {
  // Two entries overlap on the hourly grid when their [order, order+span)
  // ranges intersect — exactly the span-aware rule the engine enforces.
  // (A conflicting pair is counted twice, e1↔e2 — irrelevant for `=== 0`.)
  return (
    db
      .prepare(
        `SELECT COUNT(*) AS c
           FROM draft_timetable_entries e1
           JOIN time_slots ts ON ts.id = e1.time_slot_id
           ${joinClauses}
           JOIN time_slots ts2 ON ts2.id = e2.time_slot_id
          WHERE e1.generation_id = ?
            AND e1.day_of_week = e2.day_of_week
            AND ts."order" < ts2."order" + e2.span
            AND ts2."order" < ts."order" + e1.span`
      )
      .get(generationId) as { c: number }
  ).c
}

describe('weekly timetable generation from the demo fixture', () => {
  let generationId = ''
  let genResult: Awaited<ReturnType<typeof generateTimetable>> | null = null

  beforeAll(() => {
    testDb = new Database(':memory:')
    testDb.exec(schema)
    buildDemoFixture(testDb)
    genResult = generateTimetable(DEMO_YEAR_ID)
    generationId = genResult.generationId
  })
  afterAll(() => {
    testDb?.close()
    testDb = null
  })

  it('schedules every demo session — COMPLETED, zero uncovered, exactly 124 activities and 140 occupied periods', () => {
    expect(genResult!.status).toBe('COMPLETED')
    expect(genResult!.statistics.uncovered).toBe(0)
    // Weekly sessions: I Sem 20 + III Sem 21 + V Sem 21 = 62 per section × 2 sections = 124
    expect(genResult!.assignments.length).toBe(124)
    expect(genResult!.assignments.reduce((periods, assignment) => periods + assignment.span, 0)).toBe(140)
    expect(genResult!.statistics.labs).toBe(16) // 8 lab subjects × 2 sections × 1 session
  })

  it('the draft passes independent validation', () => {
    const v = validateDraftTimetable(generationId)
    expect(v.errors).toEqual([])
    expect(v.valid).toBe(true)
    expect(v.entries).toBe(124)
    expect(v.scheduledSessions).toBe(v.requiredSessions)
    expect(v.labsScheduled).toBe(16)
  })

  it('respects working days, periods, breaks, and never double-books faculty, sections or rooms', () => {
    const db = testDb!
    // Non-break periods inside working hours only, on Mon–Sat only:
    const badSlot = (
      db
        .prepare(
          `SELECT COUNT(*) AS c FROM draft_timetable_entries d
             JOIN time_slots ts ON ts.id = d.time_slot_id
            WHERE d.generation_id = ?
              AND (ts.is_break = 1 OR ts.start_time < '09:00' OR ts.end_time > '16:00'
                   OR d.day_of_week NOT IN ('MONDAY','TUESDAY','WEDNESDAY','THURSDAY','FRIDAY','SATURDAY'))`
        )
        .get(generationId) as { c: number }
    ).c
    expect(badSlot).toBe(0)

    // Span-aware conflicts:
    const facultyConflicts = spanAwareConflictCount(
      db,
      generationId,
      `JOIN draft_timetable_entry_faculty f1 ON f1.entry_id = e1.id
       JOIN draft_timetable_entry_faculty f2 ON f2.faculty_id = f1.faculty_id AND f2.entry_id <> e1.id
       JOIN draft_timetable_entries e2 ON e2.id = f2.entry_id AND e2.generation_id = e1.generation_id`
    )
    const sectionConflicts = spanAwareConflictCount(
      db,
      generationId,
      `JOIN draft_timetable_entries e2 ON e2.section_id = e1.section_id AND e2.id <> e1.id AND e2.generation_id = e1.generation_id`
    )
    const roomConflicts = spanAwareConflictCount(
      db,
      generationId,
      `JOIN draft_timetable_entry_rooms r1 ON r1.entry_id = e1.id
       JOIN draft_timetable_entry_rooms r2 ON r2.room_id = r1.room_id AND r2.entry_id <> e1.id
       JOIN draft_timetable_entries e2 ON e2.id = r2.entry_id AND e2.generation_id = e1.generation_id`
    )
    expect(facultyConflicts).toBe(0)
    expect(sectionConflicts).toBe(0)
    expect(roomConflicts).toBe(0)
  })

  it('TEAM requirements put every allocated teacher on every session', () => {
    const rows = testDb!
      .prepare(
        `SELECT d.id, s.code, GROUP_CONCAT(f.faculty_id) AS fac
           FROM draft_timetable_entries d
           JOIN subjects s ON s.id = d.subject_id
           JOIN draft_timetable_entry_faculty f ON f.entry_id = d.id
          WHERE d.generation_id = ? AND s.code IN ('24BCAL12', '24BCAL32', '24BCA51', '24BCAL51')
          GROUP BY d.id`
      )
      .all(generationId) as Array<{ id: string; code: string; fac: string }>
    // IL labs (2 sections × 2 courses = 4) + ML & NN (2 sections × 3 sessions = 6) + ML Lab (2 sections × 1 session = 2)
    expect(rows.length).toBe(4 + 6 + 2)
    for (const r of rows) {
      const team = r.fac.split(',').sort()
      if (r.code === '24BCA51' || r.code === '24BCAL51') expect(team).toEqual(['demo-fac-01', 'demo-fac-02'])
      else expect(team).toEqual(['demo-fac-09', 'demo-fac-10'])
    }
  })

  it('ALTERNATE requirement alternates between its two allocated teachers', () => {
    const rows = testDb!
      .prepare(
        `SELECT d.id, GROUP_CONCAT(f.faculty_id) AS fac
           FROM draft_timetable_entries d
           JOIN subjects s ON s.id = d.subject_id
           JOIN draft_timetable_entry_faculty f ON f.entry_id = d.id
          WHERE d.generation_id = ? AND s.code = '24BCA33'
          GROUP BY d.id`
      )
      .all(generationId) as Array<{ id: string; fac: string }>
    expect(rows.length).toBe(6) // 3 sessions × 2 sections
    const teachers = new Set<string>()
    for (const r of rows) {
      const fac = r.fac.split(',')
      expect(fac).toHaveLength(1) // alternate = one teacher per session
      teachers.add(fac[0])
    }
    expect([...teachers].sort()).toEqual(['demo-fac-05', 'demo-fac-08'])
  })

  it('lab sessions are contiguous two-period spans', () => {
    const rows = testDb!
      .prepare(
        `SELECT d.span FROM draft_timetable_entries d
           JOIN subjects s ON s.id = d.subject_id
          WHERE d.generation_id = ? AND d.class_type = 'LAB'`
      )
      .all(generationId) as Array<{ span: number }>
    expect(rows.length).toBe(16)
    for (const r of rows) expect(r.span).toBe(2)
  })

  it('never schedules the non-teaching staff', () => {
    const c = (
      testDb!
        .prepare(
          `SELECT COUNT(*) AS c
             FROM draft_timetable_entry_faculty f
             JOIN faculty fac ON fac.id = f.faculty_id
             JOIN draft_timetable_entries d ON d.id = f.entry_id
            WHERE d.generation_id = ? AND fac.staff_type <> 'TEACHING'`
        )
        .get(generationId) as { c: number }
    ).c
    expect(c).toBe(0)
  })

  it('publishes the draft to the master timetable', () => {
    const pub = publishDraftTimetable(generationId)
    expect(pub.publishedEntries).toBe(124)
    const master = (testDb!.prepare('SELECT COUNT(*) AS c FROM timetable_entries').get() as { c: number }).c
    expect(master).toBe(124)
    const sectionsCovered = (
      testDb!.prepare('SELECT COUNT(DISTINCT section_id) AS c FROM timetable_entries').get() as { c: number }
    ).c
    expect(sectionsCovered).toBe(6)
    const draftStatuses = testDb!.prepare('SELECT DISTINCT status FROM draft_timetable_entries').all()
    expect(draftStatuses).toEqual([{ status: 'PUBLISHED' }])
  })
})

describe('conflict demo fixture', () => {
  beforeAll(() => {
    testDb?.close()
    testDb = new Database(':memory:')
    testDb.exec(schema)
    buildDemoFixture(testDb, { variant: 'conflict' })
  })

  afterAll(() => {
    testDb?.close()
    testDb = null
  })

  it('fails honestly on the intentionally overloaded faculty workload', () => {
    const result = generateTimetable(DEMO_YEAR_ID)

    expect(result.status).toBe('FAILED')
    expect(result.statistics.uncovered).toBeGreaterThan(0)
    expect(result.assignments).toEqual([])
    expect(
      result.diagnostics.some(
        (diagnostic) =>
          diagnostic.code === 'FACULTY_OVERLOADED' &&
          /Demo Faculty 01/.test(diagnostic.message) &&
          /38 periods/.test(diagnostic.message)
      )
    ).toBe(true)
    expect(
      testDb!.prepare('SELECT COUNT(*) AS c FROM draft_timetable_entries').get()
    ).toEqual({ c: 0 })
    expect(
      testDb!.prepare('SELECT COUNT(*) AS c FROM timetable_entries').get()
    ).toEqual({ c: 0 })
  })
})

/* ------------------------------------------------------------------ *
 * 4. Substitution scenarios on the published demo timetable
 * ------------------------------------------------------------------ */

const DAY_TO_JS: Record<string, number> = {
  SUNDAY: 0, MONDAY: 1, TUESDAY: 2, WEDNESDAY: 3, THURSDAY: 4, FRIDAY: 5, SATURDAY: 6,
}
/** Deterministic date whose weekday matches `dow` (base = Mon 2026-10-12). */
function dateForWeekday(dow: string): string {
  const d = new Date('2026-10-12T12:00:00')
  for (let i = 0; i < 8; i += 1) {
    if (d.getDay() === DAY_TO_JS[dow]) {
      const pad = (n: number) => String(n).padStart(2, '0')
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
    }
    d.setDate(d.getDate() + 1)
  }
  throw new Error(`no date for ${dow}`)
}

describe('substitution scenarios on the published demo timetable', () => {
  let scenarioDate = ''

  beforeAll(() => {
    testDb = new Database(':memory:')
    testDb.exec(schema)
    buildDemoFixture(testDb)
    const gen = generateTimetable(DEMO_YEAR_ID)
    expect(gen.status).toBe('COMPLETED')
    publishDraftTimetable(gen.generationId)
  })
  afterAll(() => {
    testDb?.close()
    testDb = null
  })

  it('scenario A: an absence is covered by eligible substitutes, then approved', () => {
    // The teacher with the most sole-teacher classes on some weekday.
    const pick = testDb!
      .prepare(
        `SELECT te.day_of_week AS dow, tef.faculty_id AS fid, COUNT(*) AS c
           FROM timetable_entries te
           JOIN timetable_entry_faculty tef ON tef.entry_id = te.id
          WHERE (SELECT COUNT(*) FROM timetable_entry_faculty x WHERE x.entry_id = te.id) = 1
          GROUP BY te.day_of_week, tef.faculty_id
          ORDER BY c DESC, tef.faculty_id
          LIMIT 1`
      )
      .get() as { dow: string; fid: string; c: number }
    expect(pick.c).toBeGreaterThanOrEqual(1)
    scenarioDate = dateForWeekday(pick.dow)

    attendanceRepository.upsert(scenarioDate, pick.fid, 'ABSENT')
    const result = generateSubstitutions(scenarioDate)

    expect(result.statistics.totalAffected).toBeGreaterThan(0)
    expect(result.statistics.covered).toBe(result.statistics.totalAffected)
    expect(result.statistics.uncovered).toBe(0)

    // Independent eligibility checks — not reusing the engine's own validation:
    const rows = testDb!
      .prepare(
        `SELECT a.substitute_faculty_id AS sub, o.day_of_week AS dow, o.time_slot_id AS slot, o.id AS entry
           FROM substitution_assignments a
           JOIN substitution_runs r ON r.id = a.run_id
           JOIN timetable_entries o ON o.id = a.original_entry_id
          WHERE r.date = ? AND a.substitute_faculty_id IS NOT NULL`
      )
      .all(scenarioDate) as Array<{ sub: string; dow: string; slot: string; entry: string }>
    expect(rows.length).toBe(result.statistics.covered)
    const absentIds = attendanceRepository.getAbsentFacultyIds(scenarioDate)
    for (const r of rows) {
      const staff = testDb!
        .prepare('SELECT staff_type, max_daily_substitutions FROM faculty WHERE id = ?')
        .get(r.sub) as { staff_type: string; max_daily_substitutions: number }
      expect(staff.staff_type).toBe('TEACHING')
      expect(absentIds).not.toContain(r.sub)
      const busy = (
        testDb!
          .prepare(
            `SELECT COUNT(*) AS c FROM timetable_entries te
               JOIN timetable_entry_faculty tef ON tef.entry_id = te.id
              WHERE tef.faculty_id = ? AND te.day_of_week = ? AND te.time_slot_id = ? AND te.id <> ?`
          )
          .get(r.sub, r.dow, r.slot, r.entry) as { c: number }
      ).c
      expect(busy, `substitute ${r.sub} must be free at ${r.dow} ${r.slot}`).toBe(0)
      const daily = (
        testDb!
          .prepare(
            `SELECT COUNT(*) AS c FROM substitution_assignments a2
               JOIN substitution_runs r2 ON r2.id = a2.run_id
              WHERE r2.date = ? AND a2.substitute_faculty_id = ?`
          )
          .get(scenarioDate, r.sub) as { c: number }
      ).c
      expect(daily).toBeLessThanOrEqual(Math.min(staff.max_daily_substitutions, 2))
    }
    const nonTeachingSubs = (
      testDb!
        .prepare(
          `SELECT COUNT(*) AS c FROM substitution_assignments a
             JOIN faculty f ON f.id = a.substitute_faculty_id
            WHERE f.staff_type <> 'TEACHING'`
        )
        .get() as { c: number }
    ).c
    expect(nonTeachingSubs).toBe(0)

    const run = approveSubstitutionRun(scenarioDate, 'Demo Coordinator')
    expect(run?.status).toBe('APPROVED')
    expect(getRevisedTimetable(scenarioDate).length).toBeGreaterThan(0)
  })

  it('scenario B: with the whole staff absent every class is uncovered — nobody ineligible is assigned', () => {
    expect(scenarioDate).toBeTruthy()
    const teaching = testDb!.prepare(`SELECT id FROM faculty WHERE staff_type = 'TEACHING'`).all() as Array<{ id: string }>
    for (const f of teaching) attendanceRepository.upsert(scenarioDate, f.id, 'ABSENT')

    const result = generateSubstitutions(scenarioDate)
    expect(result.statistics.totalAffected).toBeGreaterThan(0)
    expect(result.statistics.covered).toBe(0)
    expect(result.statistics.uncovered).toBe(result.statistics.totalAffected)

    const assigned = (
      testDb!
        .prepare(
          `SELECT COUNT(*) AS c FROM substitution_assignments a
             JOIN substitution_runs r ON r.id = a.run_id
            WHERE r.date = ? AND a.substitute_faculty_id IS NOT NULL`
        )
        .get(scenarioDate) as { c: number }
    ).c
    expect(assigned).toBe(0)
    const uncoveredRows = (
      testDb!
        .prepare(
          `SELECT COUNT(*) AS c FROM substitution_assignments a
             JOIN substitution_runs r ON r.id = a.run_id
            WHERE r.date = ? AND a.substitute_faculty_id IS NULL`
        )
        .get(scenarioDate) as { c: number }
    ).c
    expect(uncoveredRows).toBeGreaterThan(0)

    // Approval remains possible, but the run documents the gap.
    const run = approveSubstitutionRun(scenarioDate, 'Demo Coordinator')
    expect(run?.status).toBe('APPROVED')
  })
})
