/**
 * Deterministic demo fixture for the isolated BCA demo environment.
 *
 * Provenance — what comes from the uploaded exam timetable image vs. what is
 * invented for the demo (full table in docs/DEMO-GUIDE.md):
 *
 *  - DERIVED from the image (Dayananda Sagar College of Arts, Science and
 *    Commerce — BCA examination timetable, 21–24 September 2026, I/III/V
 *    Semester): the subject catalogue and the section structure (I/III/V
 *    Semester, sections A & B).
 *  - Standard, unique NEP BCA course codes (24BCA51–24BCA57) are assigned
 *    to V Semester courses so every subject has a clean, unique course code
 *    and descriptive title without artificial -DUP suffixes or duplicate labels.
 *  - INVENTED (clearly synthetic demo values, none of them real staff or
 *    rooms): exam dates/periods are NOT converted into weekly teaching
 *    sessions; weekly session counts, span, teaching arrangements, fictional
 *    "Demo Faculty 01…" staff, two non-teaching "Demo Staff" members, demo
 *    rooms/labs and the weekly configuration (Mon–Sat, 09:00–16:00 with a
 *    13:00–14:00 break) are all synthetic.
 *
 * The builder writes through the plain `SqlDatabase` contract (raw SQL, one
 * transaction) so the SAME code runs from
 *   - the CLI (`scripts/demo/cli.js` under Electron, better-sqlite3), and
 *   - the vitest suite against an isolated in-memory database.
 * It never touches any other database — path safety is enforced by
 * `demoPaths.assertSafeDemoPaths` before this module is ever called.
 */
import * as fs from 'fs'
import * as path from 'path'
import { TARGET_SCHEMA_VERSION } from './migrations'
import type { SqlDatabase } from './types'

export const DEMO_YEAR_ID = 'year-2026-2027'
export const DEMO_DEPARTMENT_ID = 'dept-bca'

/** Apply the full schema and stamp the schema version (demo databases are always rebuilt from scratch). */
export function applyDemoSchema(db: SqlDatabase): void {
  const candidates = [
    path.join(__dirname, 'schema.sql'), // compiled dist layout (copy-assets)
    path.join(__dirname, '..', '..', '..', '..', 'src', 'db', 'schema.sql'), // dist → repo src
  ]
  const schemaFile = candidates.find((c) => fs.existsSync(c))
  if (!schemaFile) {
    throw new Error(`demo: schema.sql not found (looked in: ${candidates.join(', ')})`)
  }
  const hasVersionTable = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='schema_version'`)
    .get()
  if (!hasVersionTable) {
    db.exec(
      `CREATE TABLE schema_version (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (datetime('now')))`
    )
  }
  db.exec(fs.readFileSync(schemaFile, 'utf-8'))
  db.prepare('INSERT OR REPLACE INTO schema_version (version) VALUES (?)').run(
    TARGET_SCHEMA_VERSION
  )
}

// ---------------------------------------------------------------------------
// Fixture data
// ---------------------------------------------------------------------------

interface FacultySpec {
  id: string
  name: string
  employeeId: string
  staffType: 'TEACHING' | 'NON_TEACHING'
  priority: number
  maxDailySubstitutions: number
  notes?: string
}

const TEACHING_FACULTY: FacultySpec[] = [
  { id: 'demo-fac-01', name: 'Demo Faculty 01', employeeId: 'DEMO-F01', staffType: 'TEACHING', priority: 1, maxDailySubstitutions: 2 },
  { id: 'demo-fac-02', name: 'Demo Faculty 02', employeeId: 'DEMO-F02', staffType: 'TEACHING', priority: 1, maxDailySubstitutions: 2 },
  { id: 'demo-fac-03', name: 'Demo Faculty 03', employeeId: 'DEMO-F03', staffType: 'TEACHING', priority: 2, maxDailySubstitutions: 2 },
  { id: 'demo-fac-04', name: 'Demo Faculty 04', employeeId: 'DEMO-F04', staffType: 'TEACHING', priority: 2, maxDailySubstitutions: 2 },
  { id: 'demo-fac-05', name: 'Demo Faculty 05', employeeId: 'DEMO-F05', staffType: 'TEACHING', priority: 3, maxDailySubstitutions: 2 },
  { id: 'demo-fac-06', name: 'Demo Faculty 06', employeeId: 'DEMO-F06', staffType: 'TEACHING', priority: 3, maxDailySubstitutions: 2 },
  { id: 'demo-fac-07', name: 'Demo Faculty 07', employeeId: 'DEMO-F07', staffType: 'TEACHING', priority: 4, maxDailySubstitutions: 1 },
  { id: 'demo-fac-08', name: 'Demo Faculty 08', employeeId: 'DEMO-F08', staffType: 'TEACHING', priority: 4, maxDailySubstitutions: 2 },
  { id: 'demo-fac-09', name: 'Demo Faculty 09', employeeId: 'DEMO-F09', staffType: 'TEACHING', priority: 5, maxDailySubstitutions: 3 },
  { id: 'demo-fac-10', name: 'Demo Faculty 10', employeeId: 'DEMO-F10', staffType: 'TEACHING', priority: 5, maxDailySubstitutions: 2 },
  { id: 'demo-fac-11', name: 'Demo Faculty 11', employeeId: 'DEMO-F11', staffType: 'TEACHING', priority: 3, maxDailySubstitutions: 2 },
  { id: 'demo-fac-12', name: 'Demo Faculty 12', employeeId: 'DEMO-F12', staffType: 'TEACHING', priority: 4, maxDailySubstitutions: 2 },
]

const NON_TEACHING_FACULTY: FacultySpec[] = [
  {
    id: 'demo-staff-01',
    name: 'Demo Staff 01',
    employeeId: 'DEMO-S01',
    staffType: 'NON_TEACHING',
    priority: 0,
    maxDailySubstitutions: 2,
    notes: 'Administrative staff — must never be scheduled or used as a substitute.',
  },
  {
    id: 'demo-staff-02',
    name: 'Demo Staff 02',
    employeeId: 'DEMO-S02',
    staffType: 'NON_TEACHING',
    priority: 0,
    maxDailySubstitutions: 2,
    notes: 'Laboratory assistant (non-teaching) — must never be scheduled or used as a substitute.',
  },
]

interface SectionSpec {
  id: string
  name: string
  semester: number
}

const SECTIONS: SectionSpec[] = [
  { id: 'sec-i-a', name: 'I BCA A', semester: 1 },
  { id: 'sec-i-b', name: 'I BCA B', semester: 1 },
  { id: 'sec-iii-a', name: 'III BCA A', semester: 3 },
  { id: 'sec-iii-b', name: 'III BCA B', semester: 3 },
  { id: 'sec-v-a', name: 'V BCA A', semester: 5 },
  { id: 'sec-v-b', name: 'V BCA B', semester: 5 },
]

interface SubjectSpec {
  id: string
  name: string
  code: string
  classType: 'LECTURE' | 'LAB'
}

/**
 * Subject catalogue:
 *  - 21 subjects transcribed verbatim from the exam timetable image
 *    (Dayananda Sagar BCA examination timetable, September 2026).
 *  - 6 practical & tutorial additions to reflect a realistic full-week
 *    Indian college curriculum (labs for every semester + tutorials).
 */
const SUBJECTS: SubjectSpec[] = [
  // I Semester (exam reference + lab & tutorial additions)
  { id: 'sub-24bca11', name: 'DMS', code: '24BCA11', classType: 'LECTURE' },
  { id: 'sub-24bca13', name: 'CA', code: '24BCA13', classType: 'LECTURE' },
  { id: 'sub-24bacc1', name: 'EVS', code: '24BCACC1', classType: 'LECTURE' },
  { id: 'sub-24bcal11', name: 'GE', code: '24BCAL11', classType: 'LAB' },
  { id: 'sub-24bcal12', name: 'IL', code: '24BCAL12', classType: 'LAB' },
  { id: 'sub-24bca12', name: 'PST', code: '24BCA12', classType: 'LECTURE' },
  { id: 'sub-24bcal13', name: 'DMS Lab', code: '24BCAL13', classType: 'LAB' },
  { id: 'sub-24bcat11', name: 'Tutorial / Mentoring', code: '24BCAT11', classType: 'LECTURE' },
  // III Semester (exam reference + lab & tutorial additions)
  { id: 'sub-24bca31', name: 'DBMS', code: '24BCA31', classType: 'LECTURE' },
  { id: 'sub-24bca32', name: 'P&S', code: '24BCA32', classType: 'LECTURE' },
  { id: 'sub-24bca33', name: 'AI', code: '24BCA33', classType: 'LECTURE' },
  { id: 'sub-24bcal31', name: 'GE', code: '24BCAL31', classType: 'LAB' },
  { id: 'sub-24bcae1', name: 'FE/WP/BDA', code: '24BCAE1', classType: 'LECTURE' },
  { id: 'sub-24bcal32', name: 'IL', code: '24BCAL32', classType: 'LAB' },
  { id: 'sub-24bacc2', name: 'IC-1', code: '24BCACC2', classType: 'LECTURE' },
  { id: 'sub-24bcal33', name: 'DBMS Lab', code: '24BCAL33', classType: 'LAB' },
  { id: 'sub-24bcat31', name: 'AI Tutorial', code: '24BCAT31', classType: 'LECTURE' },
  // V Semester (standard NEP BCA curriculum with clean unique course codes)
  { id: 'sub-24bca51', name: 'ML & NN', code: '24BCA51', classType: 'LECTURE' },
  { id: 'sub-24bca52', name: 'FED', code: '24BCA52', classType: 'LECTURE' },
  { id: 'sub-24bsec2', name: 'QT', code: '24BCASEC2', classType: 'LECTURE' },
  { id: 'sub-24bca53', name: 'BED', code: '24BCA53', classType: 'LECTURE' },
  { id: 'sub-24bca54', name: 'DIP', code: '24BCA54', classType: 'LECTURE' },
  { id: 'sub-24bca55', name: 'NLP/CC', code: '24BCA55', classType: 'LECTURE' },
  { id: 'sub-24bca56', name: 'IOT', code: '24BCA56', classType: 'LECTURE' },
  { id: 'sub-24bca57', name: 'CS', code: '24BCA57', classType: 'LECTURE' },
  { id: 'sub-24bcal51', name: 'ML Lab', code: '24BCAL51', classType: 'LAB' },
  { id: 'sub-24bcal52', name: 'NLP Lab', code: '24BCAL52', classType: 'LAB' },
]

const ROOMS = [
  { id: 'room-101', name: 'Demo Room 101', capacity: 60, type: 'CLASSROOM' },
  { id: 'room-102', name: 'Demo Room 102', capacity: 60, type: 'CLASSROOM' },
  { id: 'room-103', name: 'Demo Room 103', capacity: 60, type: 'CLASSROOM' },
  { id: 'room-104', name: 'Demo Room 104', capacity: 60, type: 'CLASSROOM' },
  { id: 'room-lab-1', name: 'Demo Lab 1', capacity: 40, type: 'LAB' },
  { id: 'room-lab-2', name: 'Demo Lab 2', capacity: 40, type: 'LAB' },
  { id: 'room-lab-3', name: 'Demo Lab 3', capacity: 40, type: 'LAB' },
]

/** Hourly grid: 6 teaching periods + 1 lunch break (13:00–14:00). */
const TIME_SLOTS = [
  { id: 'slot-1', name: '09:00-10:00', start: '09:00', end: '10:00', order: 1, isBreak: false },
  { id: 'slot-2', name: '10:00-11:00', start: '10:00', end: '11:00', order: 2, isBreak: false },
  { id: 'slot-3', name: '11:00-12:00', start: '11:00', end: '12:00', order: 3, isBreak: false },
  { id: 'slot-4', name: '12:00-13:00', start: '12:00', end: '13:00', order: 4, isBreak: false },
  { id: 'break', name: '13:00-14:00', start: '13:00', end: '14:00', order: 5, isBreak: true },
  { id: 'slot-5', name: '14:00-15:00', start: '14:00', end: '15:00', order: 6, isBreak: false },
  { id: 'slot-6', name: '15:00-16:00', start: '15:00', end: '16:00', order: 7, isBreak: false },
]

const SETTINGS: Array<{ key: string; value: string; description: string }> = [
  { key: 'setup_complete', value: 'true', description: 'First-run setup completion flag' },
  { key: 'institution_name', value: 'DEMO — Dayananda Sagar BCA (sample data)', description: 'Institution name (demo)' },
  { key: 'institution_address', value: 'DEMO DATA — synthetic records for evaluation only', description: 'Institution address (demo)' },
  { key: 'working_hours_start', value: '09:00', description: 'Working day start time' },
  { key: 'working_hours_end', value: '16:00', description: 'Working day end time' },
  { key: 'break_start', value: '13:00', description: 'Break start time' },
  { key: 'break_end', value: '14:00', description: 'Break end time' },
  { key: 'working_days', value: 'MONDAY,TUESDAY,WEDNESDAY,THURSDAY,FRIDAY,SATURDAY', description: 'Working days (demo week)' },
  { key: 'max_daily_substitutions', value: '2', description: 'Maximum daily substitutions per faculty' },
]

/** Qualifications: each subject has a primary teacher plus backup staff for substitution. */
const QUALIFICATIONS: Array<{ facultyId: string; subjectId: string; proficiency: number }> = [
  // I Semester
  { facultyId: 'demo-fac-01', subjectId: 'sub-24bca11', proficiency: 5 }, // DMS
  { facultyId: 'demo-fac-02', subjectId: 'sub-24bca11', proficiency: 3 }, // DMS (backup)
  { facultyId: 'demo-fac-02', subjectId: 'sub-24bca13', proficiency: 5 }, // CA
  { facultyId: 'demo-fac-01', subjectId: 'sub-24bca13', proficiency: 3 }, // CA (backup)
  { facultyId: 'demo-fac-03', subjectId: 'sub-24bacc1', proficiency: 5 }, // EVS
  { facultyId: 'demo-fac-04', subjectId: 'sub-24bacc1', proficiency: 3 }, // EVS (backup)
  { facultyId: 'demo-fac-04', subjectId: 'sub-24bca12', proficiency: 5 }, // PST
  { facultyId: 'demo-fac-03', subjectId: 'sub-24bca12', proficiency: 3 }, // PST (backup)
  { facultyId: 'demo-fac-05', subjectId: 'sub-24bcal11', proficiency: 5 }, // GE lab (I)
  { facultyId: 'demo-fac-09', subjectId: 'sub-24bcal11', proficiency: 3 }, // GE lab (I) (backup)
  { facultyId: 'demo-fac-09', subjectId: 'sub-24bcal12', proficiency: 5 }, // IL lab (I)
  { facultyId: 'demo-fac-10', subjectId: 'sub-24bcal12', proficiency: 5 }, // IL lab (I)
  { facultyId: 'demo-fac-12', subjectId: 'sub-24bcal13', proficiency: 5 }, // DMS Lab
  { facultyId: 'demo-fac-01', subjectId: 'sub-24bcal13', proficiency: 4 }, // DMS Lab (backup)
  { facultyId: 'demo-fac-01', subjectId: 'sub-24bcat11', proficiency: 5 }, // Tutorial (I)
  { facultyId: 'demo-fac-02', subjectId: 'sub-24bcat11', proficiency: 5 }, // Tutorial (I)
  { facultyId: 'demo-fac-04', subjectId: 'sub-24bcat11', proficiency: 3 }, // Tutorial (I) (backup)

  // III Semester
  { facultyId: 'demo-fac-06', subjectId: 'sub-24bca31', proficiency: 5 }, // DBMS
  { facultyId: 'demo-fac-07', subjectId: 'sub-24bca31', proficiency: 3 }, // DBMS (backup)
  { facultyId: 'demo-fac-07', subjectId: 'sub-24bca32', proficiency: 5 }, // P&S
  { facultyId: 'demo-fac-06', subjectId: 'sub-24bca32', proficiency: 3 }, // P&S (backup)
  { facultyId: 'demo-fac-05', subjectId: 'sub-24bca33', proficiency: 5 }, // AI
  { facultyId: 'demo-fac-08', subjectId: 'sub-24bca33', proficiency: 5 }, // AI
  { facultyId: 'demo-fac-10', subjectId: 'sub-24bca33', proficiency: 3 }, // AI (backup)
  { facultyId: 'demo-fac-08', subjectId: 'sub-24bcae1', proficiency: 5 }, // FE/WP/BDA
  { facultyId: 'demo-fac-07', subjectId: 'sub-24bcae1', proficiency: 3 }, // FE/WP/BDA (backup)
  { facultyId: 'demo-fac-03', subjectId: 'sub-24bacc2', proficiency: 5 }, // IC-1
  { facultyId: 'demo-fac-04', subjectId: 'sub-24bacc2', proficiency: 3 }, // IC-1 (backup)
  { facultyId: 'demo-fac-09', subjectId: 'sub-24bcal31', proficiency: 5 }, // GE lab (III)
  { facultyId: 'demo-fac-05', subjectId: 'sub-24bcal31', proficiency: 4 }, // GE lab (III) (backup)
  { facultyId: 'demo-fac-09', subjectId: 'sub-24bcal32', proficiency: 5 }, // IL lab (III)
  { facultyId: 'demo-fac-10', subjectId: 'sub-24bcal32', proficiency: 5 }, // IL lab (III)
  { facultyId: 'demo-fac-06', subjectId: 'sub-24bcal33', proficiency: 5 }, // DBMS Lab
  { facultyId: 'demo-fac-09', subjectId: 'sub-24bcal33', proficiency: 4 }, // DBMS Lab (backup)
  { facultyId: 'demo-fac-11', subjectId: 'sub-24bcat31', proficiency: 5 }, // AI Tutorial
  { facultyId: 'demo-fac-05', subjectId: 'sub-24bcat31', proficiency: 4 }, // AI Tutorial (backup)

  // V Semester
  { facultyId: 'demo-fac-01', subjectId: 'sub-24bca51', proficiency: 5 }, // ML & NN
  { facultyId: 'demo-fac-02', subjectId: 'sub-24bca51', proficiency: 5 }, // ML & NN
  { facultyId: 'demo-fac-04', subjectId: 'sub-24bca52', proficiency: 5 }, // FED
  { facultyId: 'demo-fac-03', subjectId: 'sub-24bsec2', proficiency: 5 }, // QT
  { facultyId: 'demo-fac-08', subjectId: 'sub-24bsec2', proficiency: 3 }, // QT (backup)
  { facultyId: 'demo-fac-06', subjectId: 'sub-24bca53', proficiency: 5 }, // BED
  { facultyId: 'demo-fac-07', subjectId: 'sub-24bca54', proficiency: 5 }, // DIP
  { facultyId: 'demo-fac-08', subjectId: 'sub-24bca55', proficiency: 5 }, // NLP/CC
  { facultyId: 'demo-fac-05', subjectId: 'sub-24bca56', proficiency: 5 }, // IOT
  { facultyId: 'demo-fac-10', subjectId: 'sub-24bca57', proficiency: 5 }, // CS
  { facultyId: 'demo-fac-01', subjectId: 'sub-24bcal51', proficiency: 5 }, // ML Lab
  { facultyId: 'demo-fac-02', subjectId: 'sub-24bcal51', proficiency: 5 }, // ML Lab
  { facultyId: 'demo-fac-11', subjectId: 'sub-24bcal51', proficiency: 4 }, // ML Lab (backup)
  { facultyId: 'demo-fac-11', subjectId: 'sub-24bcal52', proficiency: 5 }, // NLP Lab
  { facultyId: 'demo-fac-08', subjectId: 'sub-24bcal52', proficiency: 4 }, // NLP Lab (backup)
]

interface AllocationSpec {
  facultyId: string
  /** sessions/week stored on the allocation row (teaching_allocations.required_sessions_per_week). */
  sessions: number
}

interface RequirementSpec {
  subjectId: string
  /** Weekly sessions on the requirement row (subject_requirements.required_sessions_per_week). */
  sessions: number
  span: number
  arrangement: 'AUTO' | 'TEAM' | 'ALTERNATE'
  faculty: AllocationSpec[]
}

/**
 * Synthetic weekly plan (realistic college teaching model) — one plan per semester,
 * applied to both A and B sections.
 *
 * Totals per section:
 *  - I Sem: 20 sessions, 23 periods (63.9% weekly load across 36 slots)
 *  - III Sem: 21 sessions, 24 periods (66.7% weekly load across 36 slots)
 *  - V Sem: 21 sessions, 23 periods (63.9% weekly load across 36 slots)
 * Total across 6 sections = 124 scheduled sessions (140 occupied periods).
 *
 * Exercises every arrangement the engine supports:
 *  - TEAM: IL labs (2 teachers, every session), ML & NN lecture, ML Lab.
 *  - ALTERNATE: III Sem AI (split 2+1) and I Sem Tutorial (split 1+1).
 *  - Contiguous multi-period labs: all LAB subjects use span = 2.
 */
const SEMESTER_PLAN: Record<number, RequirementSpec[]> = {
  1: [
    { subjectId: 'sub-24bca11', sessions: 4, span: 1, arrangement: 'AUTO', faculty: [{ facultyId: 'demo-fac-01', sessions: 4 }] },
    { subjectId: 'sub-24bca13', sessions: 4, span: 1, arrangement: 'AUTO', faculty: [{ facultyId: 'demo-fac-02', sessions: 4 }] },
    { subjectId: 'sub-24bca12', sessions: 4, span: 1, arrangement: 'AUTO', faculty: [{ facultyId: 'demo-fac-04', sessions: 4 }] },
    { subjectId: 'sub-24bacc1', sessions: 3, span: 1, arrangement: 'AUTO', faculty: [{ facultyId: 'demo-fac-03', sessions: 3 }] },
    { subjectId: 'sub-24bcal11', sessions: 1, span: 2, arrangement: 'AUTO', faculty: [{ facultyId: 'demo-fac-05', sessions: 1 }] },
    { subjectId: 'sub-24bcal12', sessions: 1, span: 2, arrangement: 'TEAM', faculty: [{ facultyId: 'demo-fac-09', sessions: 1 }, { facultyId: 'demo-fac-10', sessions: 1 }] },
    { subjectId: 'sub-24bcal13', sessions: 1, span: 2, arrangement: 'AUTO', faculty: [{ facultyId: 'demo-fac-12', sessions: 1 }] },
    { subjectId: 'sub-24bcat11', sessions: 2, span: 1, arrangement: 'ALTERNATE', faculty: [{ facultyId: 'demo-fac-01', sessions: 1 }, { facultyId: 'demo-fac-02', sessions: 1 }] },
  ],
  3: [
    { subjectId: 'sub-24bca31', sessions: 4, span: 1, arrangement: 'AUTO', faculty: [{ facultyId: 'demo-fac-06', sessions: 4 }] },
    { subjectId: 'sub-24bca32', sessions: 4, span: 1, arrangement: 'AUTO', faculty: [{ facultyId: 'demo-fac-07', sessions: 4 }] },
    { subjectId: 'sub-24bca33', sessions: 3, span: 1, arrangement: 'ALTERNATE', faculty: [{ facultyId: 'demo-fac-05', sessions: 2 }, { facultyId: 'demo-fac-08', sessions: 1 }] },
    { subjectId: 'sub-24bcae1', sessions: 3, span: 1, arrangement: 'AUTO', faculty: [{ facultyId: 'demo-fac-08', sessions: 3 }] },
    { subjectId: 'sub-24bacc2', sessions: 2, span: 1, arrangement: 'AUTO', faculty: [{ facultyId: 'demo-fac-03', sessions: 2 }] },
    { subjectId: 'sub-24bcal31', sessions: 1, span: 2, arrangement: 'AUTO', faculty: [{ facultyId: 'demo-fac-09', sessions: 1 }] },
    { subjectId: 'sub-24bcal32', sessions: 1, span: 2, arrangement: 'TEAM', faculty: [{ facultyId: 'demo-fac-09', sessions: 1 }, { facultyId: 'demo-fac-10', sessions: 1 }] },
    { subjectId: 'sub-24bcal33', sessions: 1, span: 2, arrangement: 'AUTO', faculty: [{ facultyId: 'demo-fac-06', sessions: 1 }] },
    { subjectId: 'sub-24bcat31', sessions: 2, span: 1, arrangement: 'AUTO', faculty: [{ facultyId: 'demo-fac-11', sessions: 2 }] },
  ],
  5: [
    { subjectId: 'sub-24bca51', sessions: 3, span: 1, arrangement: 'TEAM', faculty: [{ facultyId: 'demo-fac-01', sessions: 3 }, { facultyId: 'demo-fac-02', sessions: 3 }] },
    { subjectId: 'sub-24bca52', sessions: 3, span: 1, arrangement: 'AUTO', faculty: [{ facultyId: 'demo-fac-04', sessions: 3 }] },
    { subjectId: 'sub-24bsec2', sessions: 2, span: 1, arrangement: 'AUTO', faculty: [{ facultyId: 'demo-fac-03', sessions: 2 }] },
    { subjectId: 'sub-24bca53', sessions: 2, span: 1, arrangement: 'AUTO', faculty: [{ facultyId: 'demo-fac-06', sessions: 2 }] },
    { subjectId: 'sub-24bca54', sessions: 2, span: 1, arrangement: 'AUTO', faculty: [{ facultyId: 'demo-fac-07', sessions: 2 }] },
    { subjectId: 'sub-24bca55', sessions: 3, span: 1, arrangement: 'AUTO', faculty: [{ facultyId: 'demo-fac-08', sessions: 3 }] },
    { subjectId: 'sub-24bca56', sessions: 2, span: 1, arrangement: 'AUTO', faculty: [{ facultyId: 'demo-fac-05', sessions: 2 }] },
    { subjectId: 'sub-24bca57', sessions: 2, span: 1, arrangement: 'AUTO', faculty: [{ facultyId: 'demo-fac-10', sessions: 2 }] },
    { subjectId: 'sub-24bcal51', sessions: 1, span: 2, arrangement: 'TEAM', faculty: [{ facultyId: 'demo-fac-01', sessions: 1 }, { facultyId: 'demo-fac-02', sessions: 1 }] },
    { subjectId: 'sub-24bcal52', sessions: 1, span: 2, arrangement: 'AUTO', faculty: [{ facultyId: 'demo-fac-11', sessions: 1 }] },
  ],
}

/** Scenario hints shared by docs/DEMO-GUIDE.md, scripts/demo/verify.js and tests. */
export const DEMO_SCENARIO = {
  /** Suggested absent teacher for scenario A (the guide picks dynamically if this one has no sole-teacher class). */
  absentFacultyId: 'demo-fac-01',
  absentFacultyName: 'Demo Faculty 01',
  workingDays: ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY'] as const,
}

export interface DemoFixtureCounts {
  academicYears: number
  departments: number
  sections: number
  subjects: number
  faculty: number
  teachingFaculty: number
  nonTeachingFaculty: number
  rooms: number
  classrooms: number
  labs: number
  timeSlots: number
  settings: number
  requirements: number
  allocations: number
  qualifications: number
  sectionAssignments: number
}

function planRowCounts(): { requirements: number; allocations: number } {
  let requirements = 0
  let allocations = 0
  for (const section of SECTIONS) {
    for (const spec of SEMESTER_PLAN[section.semester]) {
      requirements += 1
      allocations += spec.faculty.length
    }
  }
  return { requirements, allocations }
}

const PLAN_COUNTS = planRowCounts()

export interface DemoFixtureOptions {
  variant?: 'balanced' | 'conflict'
}

/**
 * Exact record counts produced by `buildDemoFixture` (balanced variant) —
 * asserted by the test suite and printed by `demo:status` so a seeded database
 * can be verified at a glance.
 */
export const DEMO_EXPECTED_COUNTS: DemoFixtureCounts = {
  academicYears: 1,
  departments: 1,
  sections: SECTIONS.length, // 6 — I/III/V Semester, A & B
  subjects: SUBJECTS.length, // 27 — 21 from exam timetable + 6 labs/tutorials
  faculty: TEACHING_FACULTY.length + NON_TEACHING_FACULTY.length, // 14
  teachingFaculty: TEACHING_FACULTY.length, // 12
  nonTeachingFaculty: NON_TEACHING_FACULTY.length, // 2
  rooms: ROOMS.length, // 7 — 4 classrooms + 3 labs
  classrooms: ROOMS.filter((r) => r.type === 'CLASSROOM').length, // 4
  labs: ROOMS.filter((r) => r.type === 'LAB').length, // 3
  timeSlots: TIME_SLOTS.length, // 7 — 6 teaching periods + 1 break
  settings: SETTINGS.length, // 9
  requirements: PLAN_COUNTS.requirements, // 54 — (8+9+10 subjects) × 2 sections
  allocations: PLAN_COUNTS.allocations, // 66
  qualifications: QUALIFICATIONS.length, // 51
  sectionAssignments: 52, // distinct (faculty, section) pairs implied by the allocations
}

/**
 * Seed the demo fixture into an EMPTY database. One transaction: a failure
 * half-way leaves the database exactly as it was, never a partial demo set.
 * Returns the inserted record counts.
 */
export function buildDemoFixture(db: SqlDatabase, options?: DemoFixtureOptions): DemoFixtureCounts {
  const isConflict = options?.variant === 'conflict' || process.env.SUBSTIFLOW_DEMO_VARIANT === 'conflict'
  const subjectById = new Map(SUBJECTS.map((s) => [s.id, s]))

  // In conflict variant: only 1 lab room is provided and faculty availability
  // is artificially constrained to demonstrate solver conflict diagnostics.
  const activeRooms = isConflict
    ? ROOMS.filter((r) => r.id !== 'room-lab-2' && r.id !== 'room-lab-3')
    : ROOMS

  // The fixture always runs against a real better-sqlite3 handle (CLI under
  // Electron, or the test suite) — never over the renderer's IPC driver — so
  // the transactional convenience method is safe to use here.
  type TransactionalDb = SqlDatabase & { transaction<T>(fn: () => T): () => T }
  const seed = (db as TransactionalDb).transaction(() => {
    db.prepare('INSERT INTO departments (id, name, code) VALUES (?, ?, ?)').run(
      DEMO_DEPARTMENT_ID,
      'BCA',
      'BCA'
    )
    db.prepare(
      'INSERT INTO academic_years (id, name, start_date, end_date, is_active) VALUES (?, ?, ?, ?, 1)'
    ).run(DEMO_YEAR_ID, '2026-2027', '2026-06-01', '2027-05-31')

    const insertSection = db.prepare(
      'INSERT INTO sections (id, name, semester, department_id, academic_year_id) VALUES (?, ?, ?, ?, ?)'
    )
    for (const s of SECTIONS) insertSection.run(s.id, s.name, s.semester, DEMO_DEPARTMENT_ID, DEMO_YEAR_ID)

    const insertSubject = db.prepare(
      'INSERT INTO subjects (id, name, code, department_id, default_class_type) VALUES (?, ?, ?, ?, ?)'
    )
    for (const s of SUBJECTS) insertSubject.run(s.id, s.name, s.code, DEMO_DEPARTMENT_ID, s.classType)

    const insertFaculty = db.prepare(
      'INSERT INTO faculty (id, name, employee_id, department_id, is_active, staff_type, max_daily_substitutions, priority, notes) VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?)'
    )
    for (const f of [...TEACHING_FACULTY, ...NON_TEACHING_FACULTY]) {
      insertFaculty.run(f.id, f.name, f.employeeId, DEMO_DEPARTMENT_ID, f.staffType, f.maxDailySubstitutions, f.priority, f.notes ?? null)
    }

    const insertRoom = db.prepare(
      'INSERT INTO rooms (id, name, capacity, type, department_id) VALUES (?, ?, ?, ?, ?)'
    )
    for (const r of activeRooms) insertRoom.run(r.id, r.name, r.capacity, r.type, DEMO_DEPARTMENT_ID)

    const insertSlot = db.prepare(
      'INSERT INTO time_slots (id, name, start_time, end_time, "order", is_break) VALUES (?, ?, ?, ?, ?, ?)'
    )
    for (const t of TIME_SLOTS) insertSlot.run(t.id, t.name, t.start, t.end, t.order, t.isBreak ? 1 : 0)

    const insertSetting = db.prepare(
      'INSERT INTO application_settings (id, key, value, description) VALUES (?, ?, ?, ?)'
    )
    for (const s of SETTINGS) insertSetting.run(`set-${s.key}`, s.key, s.value, s.description)

    const insertQual = db.prepare(
      'INSERT INTO faculty_subjects (faculty_id, subject_id, proficiency) VALUES (?, ?, ?)'
    )
    for (const q of QUALIFICATIONS) insertQual.run(q.facultyId, q.subjectId, q.proficiency)

    const insertRequirement = db.prepare(
      'INSERT INTO subject_requirements (id, academic_year_id, section_id, subject_id, class_type, required_sessions_per_week, span, teaching_arrangement) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    )
    const insertAllocation = db.prepare(
      'INSERT INTO teaching_allocations (id, academic_year_id, faculty_id, section_id, subject_id, class_type, required_sessions_per_week) VALUES (?, ?, ?, ?, ?, ?, ?)'
    )
    const insertFacultySection = db.prepare(
      'INSERT OR IGNORE INTO faculty_sections (faculty_id, section_id) VALUES (?, ?)'
    )
    for (const section of SECTIONS) {
      for (const spec of SEMESTER_PLAN[section.semester]) {
        const subject = subjectById.get(spec.subjectId)
        if (!subject) throw new Error(`demo fixture: unknown subject ${spec.subjectId}`)
        insertRequirement.run(
          `req-${section.id}-${subject.id}`,
          DEMO_YEAR_ID,
          section.id,
          subject.id,
          subject.classType,
          spec.sessions,
          spec.span,
          spec.arrangement
        )
        for (const alloc of spec.faculty) {
          insertAllocation.run(
            `alloc-${section.id}-${subject.id}-${alloc.facultyId}`,
            DEMO_YEAR_ID,
            alloc.facultyId,
            section.id,
            subject.id,
            subject.classType,
            alloc.sessions
          )
          insertFacultySection.run(alloc.facultyId, section.id)
        }
      }
    }

    if (isConflict) {
      // Intentionally overload Demo Faculty 01 across multiple sections to demonstrate
      // realistic scheduling conflict resolution and diagnostics (38 sessions in a 36-slot week).
      insertRequirement.run(
        'req-sec-iii-a-conflict',
        DEMO_YEAR_ID,
        'sec-iii-a',
        'sub-24bca11',
        'LECTURE',
        10,
        1,
        'AUTO'
      )
      insertAllocation.run(
        'alloc-sec-iii-a-conflict',
        DEMO_YEAR_ID,
        'demo-fac-01',
        'sec-iii-a',
        'sub-24bca11',
        'LECTURE',
        10
      )
      insertFacultySection.run('demo-fac-01', 'sec-iii-a')

      insertRequirement.run(
        'req-sec-iii-b-conflict',
        DEMO_YEAR_ID,
        'sec-iii-b',
        'sub-24bca11',
        'LECTURE',
        10,
        1,
        'AUTO'
      )
      insertAllocation.run(
        'alloc-sec-iii-b-conflict',
        DEMO_YEAR_ID,
        'demo-fac-01',
        'sec-iii-b',
        'sub-24bca11',
        'LECTURE',
        10
      )
      insertFacultySection.run('demo-fac-01', 'sec-iii-b')
    }
  })

  seed()

  const count = (table: string): number =>
    (db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number }).c
  const countWhere = (table: string, where: string, ...params: unknown[]): number =>
    (db.prepare(`SELECT COUNT(*) AS c FROM ${table} WHERE ${where}`).get(...params) as { c: number }).c

  return {
    academicYears: count('academic_years'),
    departments: count('departments'),
    sections: count('sections'),
    subjects: count('subjects'),
    faculty: count('faculty'),
    teachingFaculty: countWhere('faculty', `staff_type = 'TEACHING'`),
    nonTeachingFaculty: countWhere('faculty', `staff_type = 'NON_TEACHING'`),
    rooms: count('rooms'),
    classrooms: countWhere('rooms', `type = 'CLASSROOM'`),
    labs: countWhere('rooms', `type = 'LAB'`),
    timeSlots: count('time_slots'),
    settings: count('application_settings'),
    requirements: count('subject_requirements'),
    allocations: count('teaching_allocations'),
    qualifications: count('faculty_subjects'),
    sectionAssignments: count('faculty_sections'),
  }
}
