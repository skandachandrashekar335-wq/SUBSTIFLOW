/**
 * Migration pathway test (Req 28 — minimal/safe schema migrations).
 *
 * Builds a database in the ORIGINAL (v1) shape — single faculty_id / room_id
 * columns, no span, no terms, no audit log — and upgrades it with the exact
 * `runMigrations` the desktop app runs on launch. Verifies:
 *
 *  1. Nothing is lost: every timetable entry survives with its faculty/room
 *     relationships intact (now in the ordered join tables).
 *  2. `span` defaults to 1 for legacy single-period rows.
 *  3. A correctly-dated academic year becomes active and sections/entries are
 *     MOVED, never deleted; the old year row is preserved.
 *  4. The official term and the multi-faculty absence policy are seeded.
 *  5. `PRAGMA foreign_key_check` is clean and schema_version is stamped.
 *  6. Re-running migrations is a no-op (forward-only, idempotent).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import { runMigrations, TARGET_SCHEMA_VERSION } from '@/db/migrations'
import { timetableEntryRepository } from '@/db/repositories/timetableEntry'

let testDb: Database.Database | null = null

vi.mock('@/db/database', () => ({
  getDatabase: () => testDb,
  closeDatabase: () => undefined,
}))

/** The pre-upgrade (v1) schema, reduced to what migration 2 touches. */
const V1_SCHEMA = `
CREATE TABLE schema_version (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (datetime('now')));

CREATE TABLE academic_years (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, start_date TEXT NOT NULL, end_date TEXT NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE departments (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, code TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE faculty (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, employee_id TEXT, department_id TEXT NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 1, max_daily_substitutions INTEGER NOT NULL DEFAULT 2,
  priority INTEGER NOT NULL DEFAULT 0, notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (department_id) REFERENCES departments(id) ON DELETE CASCADE
);
CREATE TABLE subjects (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, code TEXT, department_id TEXT NOT NULL,
  default_class_type TEXT NOT NULL DEFAULT 'LECTURE',
  created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (department_id) REFERENCES departments(id) ON DELETE CASCADE
);
CREATE TABLE sections (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, semester INTEGER, department_id TEXT NOT NULL,
  academic_year_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (department_id) REFERENCES departments(id) ON DELETE CASCADE,
  FOREIGN KEY (academic_year_id) REFERENCES academic_years(id) ON DELETE CASCADE
);
CREATE TABLE rooms (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, capacity INTEGER, type TEXT, department_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE time_slots (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, start_time TEXT NOT NULL, end_time TEXT NOT NULL,
  "order" INTEGER NOT NULL, is_break INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE timetable_entries (
  id TEXT PRIMARY KEY,
  academic_year_id TEXT NOT NULL,
  day_of_week TEXT NOT NULL,
  time_slot_id TEXT NOT NULL,
  section_id TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  faculty_id TEXT NOT NULL,
  room_id TEXT NOT NULL,
  class_type TEXT NOT NULL DEFAULT 'LECTURE',
  created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (academic_year_id) REFERENCES academic_years(id) ON DELETE CASCADE,
  FOREIGN KEY (time_slot_id) REFERENCES time_slots(id) ON DELETE RESTRICT,
  FOREIGN KEY (section_id) REFERENCES sections(id) ON DELETE CASCADE,
  FOREIGN KEY (subject_id) REFERENCES subjects(id) ON DELETE RESTRICT,
  FOREIGN KEY (faculty_id) REFERENCES faculty(id) ON DELETE RESTRICT,
  FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE RESTRICT,
  UNIQUE(academic_year_id, day_of_week, time_slot_id, section_id),
  UNIQUE(academic_year_id, day_of_week, time_slot_id, faculty_id),
  UNIQUE(academic_year_id, day_of_week, time_slot_id, room_id)
);
CREATE INDEX idx_timetable_entries_academic_year ON timetable_entries(academic_year_id);
CREATE TABLE application_settings (
  key TEXT PRIMARY KEY, value TEXT NOT NULL, description TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`

const ENTRY_COUNT = 4
const SECTION_COUNT = 2
const FACULTY_COUNT = 3

function seedV1(): void {
  const db = testDb!
  db.prepare('INSERT INTO schema_version (version) VALUES (1)').run()
  db.prepare(
    "INSERT INTO academic_years (id, name, start_date, end_date, is_active) VALUES ('year-old', '2024-2025', '2024-06-01', '2025-05-31', 1)"
  ).run()
  db.prepare("INSERT INTO departments (id, name, code) VALUES ('dept', 'BCA', 'BCA')").run()
  for (const id of ['fac-1', 'fac-2', 'fac-3']) {
    db.prepare(
      "INSERT INTO faculty (id, name, department_id) VALUES (?, ?, 'dept')"
    ).run(id, `Faculty ${id}`)
  }
  db.prepare(
    "INSERT INTO subjects (id, name, code, department_id) VALUES ('sub-1', 'DBMS', 'DBM', 'dept')"
  ).run()
  for (const id of ['sec-a', 'sec-b']) {
    db.prepare(
      "INSERT INTO sections (id, name, department_id, academic_year_id) VALUES (?, ?, 'dept', 'year-old')"
    ).run(id, id.toUpperCase())
  }
  for (const id of ['room-1', 'room-2']) {
    db.prepare('INSERT INTO rooms (id, name, capacity, type) VALUES (?, ?, 40, ?)').run(id, id, 'CLASSROOM')
  }
  for (let i = 1; i <= 7; i++) {
    db.prepare(
      'INSERT INTO time_slots (id, name, start_time, end_time, "order", is_break) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(`slot-${i}`, `${8 + i}:00-${9 + i}:00`, `${8 + i}:00`, `${9 + i}:00`, i, i === 5 ? 1 : 0)
  }
  db.prepare("INSERT INTO application_settings (key, value) VALUES ('institution_name', 'Govt College')").run()

  const rows: [string, string, string, string][] = [
    ['tt-1', 'slot-1', 'sec-a', 'fac-1'],
    ['tt-2', 'slot-2', 'sec-a', 'fac-2'],
    ['tt-3', 'slot-3', 'sec-b', 'fac-1'],
    ['tt-4', 'slot-6', 'sec-b', 'fac-3'],
  ]
  for (const [id, slotId, sectionId, facultyId] of rows) {
    db.prepare(
      `INSERT INTO timetable_entries
         (id, academic_year_id, day_of_week, time_slot_id, section_id, subject_id, faculty_id, room_id, class_type)
       VALUES (?, 'year-old', 'WEDNESDAY', ?, ?, 'sub-1', ?, ?, 'LECTURE')`
    ).run(id, slotId, sectionId, facultyId, sectionId === 'sec-a' ? 'room-1' : 'room-2')
  }
}

beforeEach(() => {
  if (testDb) testDb.close()
  testDb = new Database(':memory:')
  testDb.pragma('foreign_keys = ON')
  testDb.exec(V1_SCHEMA)
  seedV1()
})

afterEach(() => {
  if (testDb) {
    testDb.close()
    testDb = null
  }
})

describe('migration v1 → current', () => {
  it('upgrades a v1 database without losing a single timetable relationship', () => {
    runMigrations(testDb as unknown as Parameters<typeof runMigrations>[0])

    // Entry count is unchanged and every row keeps its faculty + room.
    const entries = timetableEntryRepository.getWithRelations('year-2026-2027')
    expect(entries).toHaveLength(ENTRY_COUNT)
    for (const entry of entries) {
      expect(entry.span).toBe(1) // legacy single-period rows
      expect(entry.facultyIds).toHaveLength(1)
      expect(entry.roomIds).toHaveLength(1)
      expect(entry.faculty?.id).toBeTruthy()
    }
    expect(entries.map(e => e.facultyIds[0]).sort()).toEqual(['fac-1', 'fac-1', 'fac-2', 'fac-3'])

    // The join tables mirror the old columns exactly (position 0 = old value).
    const joinCount = (testDb!
      .prepare('SELECT COUNT(*) c FROM timetable_entry_faculty').get() as { c: number }).c
    expect(joinCount).toBe(ENTRY_COUNT)
    const roomJoinCount = (testDb!
      .prepare('SELECT COUNT(*) c FROM timetable_entry_rooms').get() as { c: number }).c
    expect(roomJoinCount).toBe(ENTRY_COUNT)

    // Old single-faculty columns are gone (the whole point of the rebuild).
    const cols = (testDb!.prepare('PRAGMA table_info(timetable_entries)').all() as { name: string }[])
      .map(c => c.name)
    expect(cols).not.toContain('faculty_id')
    expect(cols).not.toContain('room_id')
    expect(cols).toContain('span')
  })

  it('re-homes sections and entries to a correctly-dated active year (moved, never deleted)', () => {
    runMigrations(testDb as unknown as Parameters<typeof runMigrations>[0])

    const years = testDb!.prepare('SELECT id, is_active FROM academic_years ORDER BY id').all() as {
      id: string
      is_active: number
    }[]
    expect(years).toHaveLength(2)
    expect(years.find(y => y.id === 'year-2026-2027')?.is_active).toBe(1)
    expect(years.find(y => y.id === 'year-old')?.is_active).toBe(0) // preserved as history

    const sectionCount = (testDb!.prepare('SELECT COUNT(*) c FROM sections').get() as { c: number }).c
    expect(sectionCount).toBe(SECTION_COUNT)
    const moved = testDb!
      .prepare("SELECT COUNT(*) c FROM sections WHERE academic_year_id = 'year-2026-2027'")
      .get() as { c: number }
    expect(moved.c).toBe(SECTION_COUNT)

    const entryCount = (testDb!.prepare('SELECT COUNT(*) c FROM timetable_entries').get() as { c: number }).c
    expect(entryCount).toBe(ENTRY_COUNT)
    const movedEntries = testDb!
      .prepare("SELECT COUNT(*) c FROM timetable_entries WHERE academic_year_id = 'year-2026-2027'")
      .get() as { c: number }
    expect(movedEntries.c).toBe(ENTRY_COUNT)
    expect(FACULTY_COUNT).toBe(3) // faculty untouched by the move
  })

  it('seeds the official term, the absence policy and stamps the schema version', () => {
    runMigrations(testDb as unknown as Parameters<typeof runMigrations>[0])

    const term = testDb!
      .prepare('SELECT name, start_date, end_date, is_active FROM terms')
      .get() as { name: string; start_date: string; end_date: string; is_active: number }
    expect(term.start_date).toBe('2026-07-20')
    expect(term.end_date).toBe('2026-11-11')
    expect(term.is_active).toBe(1)

    const policy = testDb!
      .prepare("SELECT value FROM application_settings WHERE key = 'multi_faculty_absence_policy'")
      .get() as { value: string }
    expect(policy.value).toBe('TEAM_SUFFICIENT')

    // Existing settings survive.
    const institution = testDb!
      .prepare("SELECT value FROM application_settings WHERE key = 'institution_name'")
      .get() as { value: string }
    expect(institution.value).toBe('Govt College')

    expect(
      (testDb!.prepare('SELECT MAX(version) v FROM schema_version').get() as { v: number }).v
    ).toBe(TARGET_SCHEMA_VERSION)

    // Referential integrity verified after the rebuild.
    expect(testDb!.prepare('PRAGMA foreign_key_check').all()).toHaveLength(0)
    expect(testDb!.prepare('PRAGMA foreign_keys').get()).toMatchObject({ foreign_keys: 1 })
  })

  it('is idempotent — a second launch applies nothing', () => {
    runMigrations(testDb as unknown as Parameters<typeof runMigrations>[0])
    const snapshot = JSON.stringify(
      testDb!.prepare('SELECT * FROM timetable_entries ORDER BY id').all()
    )
    const version = (testDb!.prepare('SELECT MAX(version) v FROM schema_version').get() as { v: number }).v

    runMigrations(testDb as unknown as Parameters<typeof runMigrations>[0])

    expect(
      (testDb!.prepare('SELECT MAX(version) v FROM schema_version').get() as { v: number }).v
    ).toBe(version)
    expect(
      JSON.stringify(testDb!.prepare('SELECT * FROM timetable_entries ORDER BY id').all())
    ).toBe(snapshot)
    expect(
      (testDb!.prepare('SELECT COUNT(*) c FROM timetable_entry_faculty').get() as { c: number }).c
    ).toBe(ENTRY_COUNT) // no duplicated join rows
  })

  it('the audit log can actually be written after the upgrade (updated_at present)', () => {
    runMigrations(testDb as unknown as Parameters<typeof runMigrations>[0])
    const now = new Date().toISOString()
    expect(() =>
      testDb!
        .prepare(
          'INSERT INTO audit_log (id, action, entity_type, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
        )
        .run('audit-1', 'timetable.created', 'timetable_entry', now, now)
    ).not.toThrow()
    expect(
      (testDb!.prepare('SELECT COUNT(*) c FROM audit_log').get() as { c: number }).c
    ).toBe(1)
  })
})
