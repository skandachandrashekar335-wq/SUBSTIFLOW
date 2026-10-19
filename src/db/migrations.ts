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
export const TARGET_SCHEMA_VERSION = 8

/** Apply the schema and any pending migrations. */
export function runMigrations(db: SqlDatabase): void {
  const hasSchemaVersion = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='schema_version'`)
    .get()

  if (!hasSchemaVersion) {
    // First init is atomic: if schema application fails partway, everything
    // rolls back so the next launch retries cleanly instead of stamping a
    // half-created schema as complete.
    //
    // WAL and foreign_keys are connection pragmas that cannot take effect
    // inside a transaction (the node driver pre-sets them, but callers that
    // open a fresh file themselves must not depend on that): set them before
    // BEGIN so applying schema.sql — which contains `PRAGMA journal_mode=WAL`
    // — can never fail on a fresh connection.
    try {
      db.exec('PRAGMA journal_mode = WAL')
    } catch {
      // Non-fatal: the connection may already be in WAL mode.
    }
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
  if (version === 4) migrateV4Phase1TeachingAllocations(db)
  if (version === 5) migrateV5SubjectRequirements(db)
  if (version === 6) migrateV6NullableDiagnosticAllocation(db)
  if (version === 7) migrateV7StaffTypeArrangementAuditIds(db)
  if (version === 8) migrateV8UpdatedAtIndexTriggers(db)
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
  // Idempotency guard: the schema_version stamp lands AFTER this function
  // commits, so a crash inside that window re-runs the migration on the next
  // launch. The rebuild below is NOT re-runnable — it copies from columns it
  // then drops — so a `span` column on timetable_entries means "already
  // applied": no-op and let the stamp land.
  const existing = db.prepare(`PRAGMA table_info(timetable_entries)`).all() as { name: string }[]
  if (existing.length > 0 && existing.some((c) => c.name === 'span')) return

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
      // id is required: a NULL id would make every later update (which targets
      // `WHERE id = ?`) silently match no rows, so the setting could never
      // be changed from the Settings screen.
      db.prepare(
        `INSERT INTO application_settings (id, key, value, description)
         SELECT 'setting-multi-faculty-absence-policy', 'multi_faculty_absence_policy', 'TEAM_SUFFICIENT',
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

/**
 * Migration 4 — Phase 1: Teaching Allocations & Automatic Timetable Generation
 *
 * New tables for the automatic master timetable generation workflow:
 *
 * 1. `teaching_allocations` — Faculty × Section × Subject × ClassType + weekly session count
 *    The core input for the generator. One row = "Faculty X teaches Subject Y to Section Z, K periods/week as ClassType T".
 *    Supports multi-faculty labs (same section+subject, multiple faculty rows, same required_sessions).
 *
 * 2. `draft_timetable_entries` — Generator output (DRAFT timetable).
 *    Separate table from `timetable_entries` so generation is non-destructive.
 *    Same shape as `timetable_entries` plus `status` (DRAFT/PUBLISHED) and `generation_id`.
 *
 * 5. `timetable_generations` — Generation runs with metadata.
 *    Tracks each generation run: status, constraints, diagnostics, created_at.
 *
 * 6. `generation_diagnostics` — Detailed diagnostics for failed/uncovered activities.
 *    Explains WHY something couldn't be scheduled (conflict details, no qualified faculty, etc.).
 *
 * Safety: Forward-only, additive only. No existing tables modified.
 */
function migrateV4Phase1TeachingAllocations(db: SqlDatabase): void {
  db.exec('PRAGMA foreign_keys = OFF')
  try {
    db.exec('BEGIN')
    try {
      // --- 1. Teaching Allocations: Faculty × Section × Subject × ClassType ---
      db.exec(`
        CREATE TABLE IF NOT EXISTS teaching_allocations (
            id TEXT PRIMARY KEY,
            academic_year_id TEXT NOT NULL,
            faculty_id TEXT NOT NULL,
            section_id TEXT NOT NULL,
            subject_id TEXT NOT NULL,
            class_type TEXT NOT NULL DEFAULT 'LECTURE',
            required_sessions_per_week INTEGER NOT NULL DEFAULT 1,
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at TEXT NOT NULL DEFAULT (datetime('now')),
            FOREIGN KEY (academic_year_id) REFERENCES academic_years(id) ON DELETE CASCADE,
            FOREIGN KEY (faculty_id) REFERENCES faculty(id) ON DELETE RESTRICT,
            FOREIGN KEY (section_id) REFERENCES sections(id) ON DELETE CASCADE,
            FOREIGN KEY (subject_id) REFERENCES subjects(id) ON DELETE RESTRICT,
            UNIQUE(academic_year_id, faculty_id, section_id, subject_id, class_type)
        )
      `)
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_teaching_allocations_academic_year ON teaching_allocations(academic_year_id)
      `)
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_teaching_allocations_faculty ON teaching_allocations(faculty_id)
      `)
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_teaching_allocations_section ON teaching_allocations(section_id)
      `)
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_teaching_allocations_subject ON teaching_allocations(subject_id)
      `)

      // --- 1b. Subject Requirements ---
      db.exec(`
        CREATE TABLE IF NOT EXISTS subject_requirements (
            id TEXT PRIMARY KEY,
            academic_year_id TEXT NOT NULL,
            section_id TEXT NOT NULL,
            subject_id TEXT NOT NULL,
            class_type TEXT NOT NULL DEFAULT 'LECTURE',
            required_sessions_per_week INTEGER NOT NULL DEFAULT 1,
            span INTEGER NOT NULL DEFAULT 1,
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at TEXT NOT NULL DEFAULT (datetime('now')),
            FOREIGN KEY (academic_year_id) REFERENCES academic_years(id) ON DELETE CASCADE,
            FOREIGN KEY (section_id) REFERENCES sections(id) ON DELETE CASCADE,
            FOREIGN KEY (subject_id) REFERENCES subjects(id) ON DELETE RESTRICT,
            UNIQUE(academic_year_id, section_id, subject_id, class_type)
        )
      `)
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_subject_requirements_academic_year ON subject_requirements(academic_year_id)
      `)
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_subject_requirements_section ON subject_requirements(section_id)
      `)
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_subject_requirements_subject ON subject_requirements(subject_id)
      `)
      db.exec(`
        CREATE TRIGGER IF NOT EXISTS update_subject_requirements_updated_at
        AFTER UPDATE ON subject_requirements
        BEGIN
            UPDATE subject_requirements SET updated_at = datetime('now') WHERE id = NEW.id;
        END
      `)

      // --- 2. Timetable Generations (generation runs) ---
      db.exec(`
        CREATE TABLE IF NOT EXISTS timetable_generations (
            id TEXT PRIMARY KEY,
            academic_year_id TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED')),
            constraints_snapshot TEXT NOT NULL DEFAULT '{}',
            diagnostics_summary TEXT,
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at TEXT NOT NULL DEFAULT (datetime('now')),
            completed_at TEXT,
            FOREIGN KEY (academic_year_id) REFERENCES academic_years(id) ON DELETE CASCADE
        )
      `)
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_timetable_generations_academic_year ON timetable_generations(academic_year_id)
      `)
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_timetable_generations_status ON timetable_generations(status)
      `)

      // --- 3. Draft Timetable Entries (generator output) ---
      db.exec(`
        CREATE TABLE IF NOT EXISTS draft_timetable_entries (
            id TEXT PRIMARY KEY,
            generation_id TEXT NOT NULL,
            academic_year_id TEXT NOT NULL,
            day_of_week TEXT NOT NULL,
            time_slot_id TEXT NOT NULL,
            section_id TEXT NOT NULL,
            subject_id TEXT NOT NULL,
            class_type TEXT NOT NULL DEFAULT 'LECTURE',
            span INTEGER NOT NULL DEFAULT 1,
            status TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'PUBLISHED')),
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at TEXT NOT NULL DEFAULT (datetime('now')),
            FOREIGN KEY (generation_id) REFERENCES timetable_generations(id) ON DELETE CASCADE,
            FOREIGN KEY (academic_year_id) REFERENCES academic_years(id) ON DELETE CASCADE,
            FOREIGN KEY (time_slot_id) REFERENCES time_slots(id) ON DELETE RESTRICT,
            FOREIGN KEY (section_id) REFERENCES sections(id) ON DELETE CASCADE,
            FOREIGN KEY (subject_id) REFERENCES subjects(id) ON DELETE RESTRICT,
            UNIQUE(generation_id, day_of_week, time_slot_id, section_id)
        )
      `)
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_draft_entries_generation ON draft_timetable_entries(generation_id)
      `)
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_draft_entries_academic_year ON draft_timetable_entries(academic_year_id)
      `)
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_draft_entries_section ON draft_timetable_entries(section_id)
      `)

      // --- 4. Generation Diagnostics (failed/uncovered activity explanations) ---
      db.exec(`
        CREATE TABLE IF NOT EXISTS generation_diagnostics (
            id TEXT PRIMARY KEY,
            generation_id TEXT NOT NULL,
            teaching_allocation_id TEXT NOT NULL,
            severity TEXT NOT NULL DEFAULT 'ERROR' CHECK (severity IN ('ERROR', 'WARNING', 'INFO')),
            code TEXT NOT NULL,
            message TEXT NOT NULL,
            details TEXT,
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            FOREIGN KEY (generation_id) REFERENCES timetable_generations(id) ON DELETE CASCADE,
            FOREIGN KEY (teaching_allocation_id) REFERENCES teaching_allocations(id) ON DELETE CASCADE
        )
      `)
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_generation_diagnostics_generation ON generation_diagnostics(generation_id)
      `)
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_generation_diagnostics_allocation ON generation_diagnostics(teaching_allocation_id)
      `)

      // --- 6. Draft Timetable Entry Faculty (join table for draft entries) ---
      db.exec(`
        CREATE TABLE IF NOT EXISTS draft_timetable_entry_faculty (
            entry_id TEXT NOT NULL,
            faculty_id TEXT NOT NULL,
            position INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (entry_id, faculty_id),
            FOREIGN KEY (entry_id) REFERENCES draft_timetable_entries(id) ON DELETE CASCADE,
            FOREIGN KEY (faculty_id) REFERENCES faculty(id) ON DELETE RESTRICT
        )
      `)

      // --- 7. Draft Timetable Entry Rooms (join table for draft entries) ---
      db.exec(`
        CREATE TABLE IF NOT EXISTS draft_timetable_entry_rooms (
            entry_id TEXT NOT NULL,
            room_id TEXT NOT NULL,
            position INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (entry_id, room_id),
            FOREIGN KEY (entry_id) REFERENCES draft_timetable_entries(id) ON DELETE CASCADE,
            FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE RESTRICT
        )
      `)

      // --- 8. Settings for Generation ---
      db.prepare(
        `INSERT INTO application_settings (id, key, value, description)
         SELECT 'setting-max-generation-attempts', 'max_generation_attempts', '1000',
                'Maximum number of placement attempts per activity during timetable generation.'
         WHERE NOT EXISTS (SELECT 1 FROM application_settings WHERE key = 'max_generation_attempts')`
      ).run()

      db.prepare(
        `INSERT INTO application_settings (id, key, value, description)
         SELECT 'setting-generation-timeout-ms', 'generation_timeout_ms', '30000',
                'Maximum time in milliseconds to spend on a single generation run.'
         WHERE NOT EXISTS (SELECT 1 FROM application_settings WHERE key = 'generation_timeout_ms')`
      ).run()

      db.prepare(
        `INSERT INTO application_settings (id, key, value, description)
         SELECT 'setting-prefer-spread', 'prefer_spread', 'true',
                'When true, the generator tries to spread sessions across the week rather than cluster them.'
         WHERE NOT EXISTS (SELECT 1 FROM application_settings WHERE key = 'prefer_spread')`
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

  // Verify referential integrity BEFORE callers can stamp this version complete.
  const violations = db.prepare('PRAGMA foreign_key_check').all() as unknown[]
  if (violations.length > 0) {
    throw new Error(
      `Migration 4 left ${violations.length} foreign-key violation(s); database not upgraded.`
    )
  }
}
/**
 * Migration 5 — Subject Requirements
 *
 * Adds the subject_requirements table for defining how many sessions per week
 * each subject requires for each section. This is separate from teaching
 * allocations (which define who teaches what).
 */
function migrateV5SubjectRequirements(db: SqlDatabase): void {
  db.exec('PRAGMA foreign_keys = OFF')
  try {
    db.exec('BEGIN')
    try {
      // --- 1. Subject Requirements ---
      db.exec(`
        CREATE TABLE IF NOT EXISTS subject_requirements (
            id TEXT PRIMARY KEY,
            academic_year_id TEXT NOT NULL,
            section_id TEXT NOT NULL,
            subject_id TEXT NOT NULL,
            class_type TEXT NOT NULL DEFAULT 'LECTURE',
            required_sessions_per_week INTEGER NOT NULL DEFAULT 1,
            span INTEGER NOT NULL DEFAULT 1,
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at TEXT NOT NULL DEFAULT (datetime('now')),
            FOREIGN KEY (academic_year_id) REFERENCES academic_years(id) ON DELETE CASCADE,
            FOREIGN KEY (section_id) REFERENCES sections(id) ON DELETE CASCADE,
            FOREIGN KEY (subject_id) REFERENCES subjects(id) ON DELETE RESTRICT,
            UNIQUE(academic_year_id, section_id, subject_id, class_type)
        )
      `)
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_subject_requirements_academic_year ON subject_requirements(academic_year_id)
      `)
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_subject_requirements_section ON subject_requirements(section_id)
      `)
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_subject_requirements_subject ON subject_requirements(subject_id)
      `)
      db.exec(`
        CREATE TRIGGER IF NOT EXISTS update_subject_requirements_updated_at
        AFTER UPDATE ON subject_requirements
        BEGIN
            UPDATE subject_requirements SET updated_at = datetime('now') WHERE id = NEW.id;
        END
      `)

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

  // Verify referential integrity BEFORE callers can stamp this version complete.
  const violations = db.prepare('PRAGMA foreign_key_check').all() as unknown[]
  if (violations.length > 0) {
    throw new Error(
      `Migration 5 left ${violations.length} foreign-key violation(s); database not upgraded.`
    )
  }
}

/**
 * Migration 6 — nullable `generation_diagnostics.teaching_allocation_id`.
 *
 * Diagnostics must explain failures that are NOT attributable to one existing
 * allocation row ("No teaching allocations are defined for this academic
 * year.", "Subject Requirement X has no teaching allocation."). The v4 table
 * declared the column NOT NULL with a foreign key, so persisting those
 * (the most important) diagnostics was impossible — the INSERT failed with a
 * FK/NOT NULL error and the administrator saw nothing.
 *
 * Forward-only, data-preserving rebuild: existing rows keep their allocation
 * link; the column simply becomes optional. Nothing else changes.
 */
function migrateV6NullableDiagnosticAllocation(db: SqlDatabase): void {
  db.exec('PRAGMA foreign_keys = OFF')
  try {
    db.exec('BEGIN')
    try {
      const columns = db.prepare(`PRAGMA table_info(generation_diagnostics)`).all() as {
        name: string
      }[]
      if (columns.length === 0) {
        // Table does not exist (should not happen) — create the current shape.
        db.exec(`
          CREATE TABLE IF NOT EXISTS generation_diagnostics (
              id TEXT PRIMARY KEY,
              generation_id TEXT NOT NULL,
              teaching_allocation_id TEXT,
              severity TEXT NOT NULL DEFAULT 'ERROR' CHECK (severity IN ('ERROR', 'WARNING', 'INFO')),
              code TEXT NOT NULL,
              message TEXT NOT NULL,
              details TEXT,
              created_at TEXT NOT NULL DEFAULT (datetime('now')),
              FOREIGN KEY (generation_id) REFERENCES timetable_generations(id) ON DELETE CASCADE,
              FOREIGN KEY (teaching_allocation_id) REFERENCES teaching_allocations(id) ON DELETE CASCADE
          )
        `)
      } else {
        const allocationColumn = columns.find(c => c.name === 'teaching_allocation_id')
        const isNullable = allocationColumn !== undefined && String((allocationColumn as any).notnull ?? 0) === '0'
        if (!isNullable) {
          db.exec(`
            CREATE TABLE generation_diagnostics_v6 (
                id TEXT PRIMARY KEY,
                generation_id TEXT NOT NULL,
                teaching_allocation_id TEXT,
                severity TEXT NOT NULL DEFAULT 'ERROR' CHECK (severity IN ('ERROR', 'WARNING', 'INFO')),
                code TEXT NOT NULL,
                message TEXT NOT NULL,
                details TEXT,
                created_at TEXT NOT NULL DEFAULT (datetime('now')),
                FOREIGN KEY (generation_id) REFERENCES timetable_generations(id) ON DELETE CASCADE,
                FOREIGN KEY (teaching_allocation_id) REFERENCES teaching_allocations(id) ON DELETE CASCADE
            )
          `)
          db.exec(`
            INSERT INTO generation_diagnostics_v6
                (id, generation_id, teaching_allocation_id, severity, code, message, details, created_at)
            SELECT id, generation_id, teaching_allocation_id, severity, code, message, details, created_at
            FROM generation_diagnostics
          `)
          db.exec('DROP TABLE generation_diagnostics')
          db.exec('ALTER TABLE generation_diagnostics_v6 RENAME TO generation_diagnostics')
        }
      }

      db.exec(
        'CREATE INDEX IF NOT EXISTS idx_generation_diagnostics_generation ON generation_diagnostics(generation_id)'
      )
      db.exec(
        'CREATE INDEX IF NOT EXISTS idx_generation_diagnostics_allocation ON generation_diagnostics(teaching_allocation_id)'
      )

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

  const violations = db.prepare('PRAGMA foreign_key_check').all() as unknown[]
  if (violations.length > 0) {
    throw new Error(
      `Migration 6 left ${violations.length} foreign-key violation(s); database not upgraded.`
    )
  }
}

/**
 * Migration 7 — manual-testing fixes:
 *
 *  1. `faculty.staff_type` — explicit teaching / non-teaching distinction.
 *     Existing rows default to TEACHING (no behaviour changes until the
 *     coordinator marks someone as non-teaching in the Faculty page).
 *  2. `subject_requirements.teaching_arrangement` — configurable TEAM vs
 *     ALTERNATE teaching (AUTO = the historical "lab with 2+ teachers is a
 *     team" rule). Existing rows default to AUTO.
 *  3. Backfill `audit_log.id` for legacy rows written by an old build that
 *     inserted audit rows without a primary key. Those NULL ids surfaced in
 *     the Dashboard's Recent Activity list as duplicate React keys.
 *
 * All steps are guarded (no-op when already applied) and run in one
 * transaction; nothing is ever deleted or rewritten beyond filling the
 * missing primary keys with fresh unique values.
 */
function migrateV7StaffTypeArrangementAuditIds(db: SqlDatabase): void {
  db.exec('BEGIN')
  try {
    const facultyColumns = db.prepare(`PRAGMA table_info(faculty)`).all() as { name: string }[]
    if (facultyColumns.length > 0 && !facultyColumns.some(c => c.name === 'staff_type')) {
      db.exec(
        `ALTER TABLE faculty ADD COLUMN staff_type TEXT NOT NULL DEFAULT 'TEACHING' CHECK (staff_type IN ('TEACHING', 'NON_TEACHING'))`
      )
    }

    const requirementColumns = db
      .prepare(`PRAGMA table_info(subject_requirements)`)
      .all() as { name: string }[]
    if (requirementColumns.length > 0 && !requirementColumns.some(c => c.name === 'teaching_arrangement')) {
      db.exec(
        `ALTER TABLE subject_requirements ADD COLUMN teaching_arrangement TEXT NOT NULL DEFAULT 'AUTO' CHECK (teaching_arrangement IN ('AUTO', 'TEAM', 'ALTERNATE'))`
      )
    }

    const auditColumns = db.prepare(`PRAGMA table_info(audit_log)`).all() as { name: string }[]
    if (auditColumns.length > 0 && auditColumns.some(c => c.name === 'id')) {
      // 128 bits of randomness → a collision would trip the PRIMARY KEY and
      // roll the whole migration back loudly rather than silently merging rows.
      db.exec(`UPDATE audit_log SET id = lower(hex(randomblob(16))) WHERE id IS NULL`)
    }

    db.exec('COMMIT')
  } catch (error) {
    try {
      db.exec('ROLLBACK')
    } catch {
      // BEGIN never landed — nothing to roll back.
    }
    throw error
  }

  const violations = db.prepare('PRAGMA foreign_key_check').all() as unknown[]
  if (violations.length > 0) {
    throw new Error(
      `Migration 7 left ${violations.length} foreign-key violation(s); database not upgraded.`
    )
  }
}

/**
 * Migration 8 — schema parity: `updated_at` triggers for EVERY table.
 *
 * schema.sql (fresh installs) declares an AFTER UPDATE trigger per table that
 * auto-bumps `updated_at` — 18 of them. No migration ever created most of
 * them: a database upgraded from an older schema carried only 7 triggers
 * (timetable_entries, terms via v2; subject_requirements via v4/v5), so the
 * 11 base tables (faculty, subjects, sections, rooms, attendance,
 * substitution_*, settings, …) silently lost the automatic `updated_at`
 * bump that a fresh install had. Latent today because `BaseRepository.update`
 * writes the column explicitly, but any raw UPDATE on those tables would
 * diverge between fresh and upgraded databases.
 *
 * Forward-only, additive, guarded: every trigger is created with
 * IF NOT EXISTS, so re-running is a no-op. `migration.test.ts` asserts the
 * upgraded trigger set is EXACTLY the fresh-install set — if schema.sql ever
 * gains a trigger, that test fails until this list is extended.
 */
const UPDATED_AT_TRIGGER_TABLES = [
  'academic_years',
  'application_settings',
  'attendance',
  'departments',
  'draft_timetable_entries',
  'faculty',
  'generation_diagnostics',
  'rooms',
  'sections',
  'subjects',
  'subject_requirements',
  'substitution_assignments',
  'substitution_rules',
  'substitution_runs',
  'teaching_allocations',
  'terms',
  'timetable_entries',
  'timetable_generations',
]

function migrateV8UpdatedAtIndexTriggers(db: SqlDatabase): void {
  for (const table of UPDATED_AT_TRIGGER_TABLES) {
    // A database missing the table (partial/legacy state) must never brick
    // startup: trigger creation is parity polish, not a data requirement.
    const tableExists = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`)
      .get(table)
    if (!tableExists) continue
    const exists = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='trigger' AND name=?`)
      .get(`update_${table}_updated_at`)
    if (exists) continue
    db.exec(
      `CREATE TRIGGER update_${table}_updated_at
       AFTER UPDATE ON ${table}
       BEGIN
           UPDATE ${table} SET updated_at = datetime('now') WHERE id = NEW.id;
       END`
    )
  }
}
