/**
 * Forward-only schema migrations.
 *
 * Kept free of Electron/Node-only imports so the exact same code that runs in
 * the desktop app can also run under Vitest (against a snapshot of the real
 * production database) and under `scripts/tasks/migrate.js`.
 *
 * `schema.sql` always describes the CURRENT shape (fresh installs); each
 * numbered step upgrades a database created at the previous version to that
 * shape.
 */
import { schema } from './schema'
import type { SqlDatabase } from './types'

/** Highest schema version `src/db/schema.sql` represents. */
export const TARGET_SCHEMA_VERSION = 3

/** Apply the schema and any pending migrations. */
export function runMigrations(db: SqlDatabase): void {
  const hasSchemaVersion = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='schema_version'`)
    .get()

  if (!hasSchemaVersion) {
    // First init is atomic: if schema application fails partway, everything
    // rolls back so the next launch retries cleanly instead of stamping a
    // half-created schema as complete.
    db.exec('BEGIN')
    try {
      db.exec(
        `CREATE TABLE schema_version (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (datetime('now')))`
      )
      db.exec(schema)
      db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(TARGET_SCHEMA_VERSION)
      db.exec('COMMIT')
    } catch (error) {
      try {
        db.exec('ROLLBACK')
      } catch {
        // BEGIN never landed — nothing to roll back.
      }
      throw error
    }
    return
  }

  const current = db.prepare('SELECT MAX(version) as version FROM schema_version').get() as
    | { version: number | null }
    | undefined
  const currentVersion = current?.version ?? 0

  for (let v = currentVersion + 1; v <= TARGET_SCHEMA_VERSION; v++) {
    runMigration(db, v)
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(v)
  }
}

function runMigration(db: SqlDatabase, version: number): void {
  console.log(`Applying database migration ${version}`)
  if (version === 2) migrateV2MultiFacultySpanAndDates(db)
  if (version === 3) migrateV3AuditLogUpdatedAt(db)
}

/**
 * Migration 3 — audit_log.updated_at.
 *
 * `BaseRepository.create` always writes `created_at` and `updated_at`; the
 * original migration-2 build of `audit_log` only declared `created_at`, so an
 * audit write would fail on databases stamped by that build. Forward-only,
 * additive fix: add the column when it is missing (a no-op when the table was
 * created from the current schema.sql).
 */
function migrateV3AuditLogUpdatedAt(db: SqlDatabase): void {
  const columns = db.prepare(`PRAGMA table_info(audit_log)`).all() as { name: string }[]
  if (columns.length === 0) return // table does not exist yet — nothing to repair
  if (columns.some(c => c.name === 'updated_at')) return
  db.exec(`ALTER TABLE audit_log ADD COLUMN updated_at TEXT NOT NULL DEFAULT (datetime('now'))`)
}

/**
 * Migration 2 — product data-model upgrade:
 *
 *  1. `timetable_entries`: faculty/room move to ordered join tables
 *     (`timetable_entry_faculty`, `timetable_entry_rooms`) so an activity can
 *     be taught by a TEAM or by NOBODY (library, mentoring, …) and can have
 *     zero/multiple rooms. The per-slot faculty/room UNIQUE constraints are
 *     dropped — conflicts are now enforced span-aware by the timetable
 *     service. New `span` column = number of consecutive periods.
 *  2. `terms`: timetable validity windows ("20 Jul – 11 Nov 2026").
 *  3. `audit_log`: who/what/when for coordinator actions.
 *  4. Academic year: a correctly-dated 2026-2027 year becomes active and all
 *     existing sections/entries are MOVED (never deleted) into it; the old
 *     2024-2025 year row is preserved as an inactive historical record.
 *  5. Settings default for the configurable multi-faculty absence policy.
 *
 * Safety: runs inside one transaction with foreign_keys off, then re-verifies
 * every FK before the schema_version stamp lands.
 */
function migrateV2MultiFacultySpanAndDates(db: SqlDatabase): void {
  db.exec('PRAGMA foreign_keys = OFF')
  try {
    db.exec('BEGIN')
    try {
      // --- 1a. New tables -------------------------------------------------
      db.exec(`
        CREATE TABLE IF NOT EXISTS timetable_entry_faculty (
            entry_id TEXT NOT NULL,
            faculty_id TEXT NOT NULL,
            position INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (entry_id, faculty_id),
            FOREIGN KEY (entry_id) REFERENCES timetable_entries(id) ON DELETE CASCADE,
            FOREIGN KEY (faculty_id) REFERENCES faculty(id) ON DELETE RESTRICT
        )
      `)
      db.exec(`
        CREATE TABLE IF NOT EXISTS timetable_entry_rooms (
            entry_id TEXT NOT NULL,
            room_id TEXT NOT NULL,
            position INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (entry_id, room_id),
            FOREIGN KEY (entry_id) REFERENCES timetable_entries(id) ON DELETE CASCADE,
            FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE RESTRICT
        )
      `)
      db.exec(`
        CREATE TABLE IF NOT EXISTS terms (
            id TEXT PRIMARY KEY,
            academic_year_id TEXT NOT NULL,
            name TEXT NOT NULL,
            start_date TEXT NOT NULL,
            end_date TEXT NOT NULL,
            is_active INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at TEXT NOT NULL DEFAULT (datetime('now')),
            FOREIGN KEY (academic_year_id) REFERENCES academic_years(id) ON DELETE CASCADE
        )
      `)
      db.exec(`
        CREATE TABLE IF NOT EXISTS audit_log (
            id TEXT PRIMARY KEY,
            action TEXT NOT NULL,
            entity_type TEXT NOT NULL,
            entity_id TEXT,
            detail TEXT,
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        )
      `)

      // --- 1b. Rebuild timetable_entries (SQLite cannot ALTER NOT NULL) ----
      db.exec(`
        CREATE TABLE timetable_entries_v2 (
            id TEXT PRIMARY KEY,
            academic_year_id TEXT NOT NULL,
            day_of_week TEXT NOT NULL,
            time_slot_id TEXT NOT NULL,
            section_id TEXT NOT NULL,
            subject_id TEXT NOT NULL,
            class_type TEXT NOT NULL DEFAULT 'LECTURE',
            span INTEGER NOT NULL DEFAULT 1,
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at TEXT NOT NULL DEFAULT (datetime('now')),
            FOREIGN KEY (academic_year_id) REFERENCES academic_years(id) ON DELETE CASCADE,
            FOREIGN KEY (time_slot_id) REFERENCES time_slots(id) ON DELETE RESTRICT,
            FOREIGN KEY (section_id) REFERENCES sections(id) ON DELETE CASCADE,
            FOREIGN KEY (subject_id) REFERENCES subjects(id) ON DELETE RESTRICT,
            UNIQUE(academic_year_id, day_of_week, time_slot_id, section_id)
        )
      `)
      db.exec(`
        INSERT INTO timetable_entries_v2
            (id, academic_year_id, day_of_week, time_slot_id, section_id,
             subject_id, class_type, span, created_at, updated_at)
        SELECT id, academic_year_id, day_of_week, time_slot_id, section_id,
               subject_id, class_type, 1, created_at, updated_at
        FROM timetable_entries
      `)
      db.exec(`
        INSERT INTO timetable_entry_faculty (entry_id, faculty_id, position)
        SELECT id, faculty_id, 0 FROM timetable_entries WHERE faculty_id IS NOT NULL
      `)
      db.exec(`
        INSERT INTO timetable_entry_rooms (entry_id, room_id, position)
        SELECT id, room_id, 0 FROM timetable_entries WHERE room_id IS NOT NULL
      `)
      db.exec('DROP TABLE timetable_entries')
      db.exec('ALTER TABLE timetable_entries_v2 RENAME TO timetable_entries')

      // Indexes/triggers died with the dropped table — recreate (minus the
      // old single-faculty index; the join-table index replaces it).
      db.exec(
        'CREATE INDEX IF NOT EXISTS idx_timetable_entries_academic_year ON timetable_entries(academic_year_id)'
      )
      db.exec(
        'CREATE INDEX IF NOT EXISTS idx_timetable_entries_day_slot ON timetable_entries(day_of_week, time_slot_id)'
      )
      db.exec(
        'CREATE INDEX IF NOT EXISTS idx_timetable_entries_section ON timetable_entries(section_id)'
      )
      db.exec(
        'CREATE INDEX IF NOT EXISTS idx_timetable_entry_faculty_faculty ON timetable_entry_faculty(faculty_id)'
      )
      db.exec(
        'CREATE INDEX IF NOT EXISTS idx_timetable_entry_rooms_room ON timetable_entry_rooms(room_id)'
      )
      db.exec('CREATE INDEX IF NOT EXISTS idx_terms_academic_year ON terms(academic_year_id)')
      db.exec('CREATE INDEX IF NOT EXISTS idx_audit_log_created ON audit_log(created_at)')
      db.exec(`
        CREATE TRIGGER IF NOT EXISTS update_timetable_entries_updated_at
        AFTER UPDATE ON timetable_entries
        BEGIN
            UPDATE timetable_entries SET updated_at = datetime('now') WHERE id = NEW.id;
        END
      `)
      db.exec(`
        CREATE TRIGGER IF NOT EXISTS update_terms_updated_at
        AFTER UPDATE ON terms
        BEGIN
            UPDATE terms SET updated_at = datetime('now') WHERE id = NEW.id;
        END
      `)

      // --- 4. Correctly-dated academic year; move (never delete) data -----
      db.prepare(
        `INSERT INTO academic_years (id, name, start_date, end_date, is_active)
         SELECT 'year-2026-2027', '2026-2027', '2026-07-01', '2027-06-30', 1
         WHERE NOT EXISTS (SELECT 1 FROM academic_years WHERE id = 'year-2026-2027')`
      ).run()
      db.prepare(`UPDATE academic_years SET is_active = 0 WHERE id <> 'year-2026-2027'`).run()
      db.prepare(
        `UPDATE sections SET academic_year_id = 'year-2026-2027' WHERE academic_year_id <> 'year-2026-2027'`
      ).run()
      db.prepare(
        `UPDATE timetable_entries SET academic_year_id = 'year-2026-2027' WHERE academic_year_id <> 'year-2026-2027'`
      ).run()

      // --- 2. Term = official timetable validity window (source-exact) -----
      db.prepare(
        `INSERT INTO terms (id, academic_year_id, name, start_date, end_date, is_active)
         SELECT 'term-2026-jul-nov', 'year-2026-2027', '20 Jul – 11 Nov 2026',
                '2026-07-20', '2026-11-11', 1
         WHERE NOT EXISTS (SELECT 1 FROM terms)`
      ).run()

      // --- 5. Configurable multi-faculty absence policy -------------------
      db.prepare(
        `INSERT INTO application_settings (key, value, description)
         SELECT 'multi_faculty_absence_policy', 'TEAM_SUFFICIENT',
                'What to do when some (not all) faculty of a multi-faculty activity are absent: TEAM_SUFFICIENT keeps the class running with the remaining team; REPLACE_ABSENT generates a substitution for the absent member(s).'
         WHERE NOT EXISTS (SELECT 1 FROM application_settings WHERE key = 'multi_faculty_absence_policy')`
      ).run()

      db.exec('COMMIT')
    } catch (error) {
      try {
        db.exec('ROLLBACK')
      } catch {
        // BEGIN never landed — nothing to roll back.
      }
      throw error
    }
  } finally {
    db.exec('PRAGMA foreign_keys = ON')
  }

  // The rebuild happened with FKs off — verify referential integrity BEFORE
  // callers can stamp this version complete.
  const violations = db.prepare('PRAGMA foreign_key_check').all() as unknown[]
  if (violations.length > 0) {
    throw new Error(
      `Migration 2 left ${violations.length} foreign-key violation(s); database not upgraded.`
    )
  }
}
