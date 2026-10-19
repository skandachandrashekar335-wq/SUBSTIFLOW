/**
 * Backup file validation for the `backup:import` IPC path.
 *
 * Kept free of Electron imports so it can be unit-tested (vitest runs under
 * plain Node). The renderer supplies an arbitrary path here, and a successful
 * validation is followed by an overwrite of the LIVE database — so the bar is
 * deliberately high: a plausible extension, a non-empty file, a real SQLite
 * header, a passing `PRAGMA integrity_check`, the SubstiFlow table set, and a
 * schema version this build understands. Anything less turns a wrong file
 * choice into a destroyed database instead of a clear error.
 */
import * as path from 'path'
import * as fs from 'fs'
import Database from 'better-sqlite3'
import { TARGET_SCHEMA_VERSION } from '../src/db/migrations'

export const SQLITE_HEADER = Buffer.from('SQLite format 3\0', 'binary')
export const BACKUP_EXTENSIONS = new Set(['.db', '.sqlite', '.sqlite3', '.backup'])

/** Tables every genuine SubstiFlow backup must contain. */
const REQUIRED_TABLES = ['schema_version', 'institutions', 'faculty', 'timetable_entries']

export function validateBackupFile(filePath: string): { ok: true } | { ok: false; error: string } {
  if (!BACKUP_EXTENSIONS.has(path.extname(filePath).toLowerCase())) {
    return { ok: false, error: 'That is not a SubstiFlow backup file (expected .db or .sqlite).' }
  }

  // --- Plausible file: real SQLite header ---------------------------------
  try {
    const stat = fs.statSync(filePath)
    if (!stat.isFile() || stat.size < SQLITE_HEADER.length) {
      return { ok: false, error: 'The selected backup file is empty or truncated.' }
    }
    const fd = fs.openSync(filePath, 'r')
    try {
      const header = Buffer.alloc(SQLITE_HEADER.length)
      fs.readSync(fd, header, 0, SQLITE_HEADER.length, 0)
      if (!header.equals(SQLITE_HEADER)) {
        return { ok: false, error: 'The selected file is not a valid SQLite database backup.' }
      }
    } finally {
      fs.closeSync(fd)
    }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }

  // --- Genuine, intact SubstiFlow database this build can open ------------
  let db: Database.Database | null = null
  try {
    db = new Database(filePath, { readonly: true, fileMustExist: true })

    const integrity = db.pragma('integrity_check', { simple: true })
    if (integrity !== 'ok') {
      return {
        ok: false,
        error: 'The selected backup failed its integrity check and looks corrupt. Nothing was imported.',
      }
    }

    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as {
      name: string
    }[]).map((row) => row.name)
    const missing = REQUIRED_TABLES.filter((t) => !tables.includes(t))
    if (missing.length > 0) {
      return {
        ok: false,
        error: `The selected file is a SQLite database but not a SubstiFlow backup (missing: ${missing.join(', ')}). Nothing was imported.`,
      }
    }

    const versionRow = db.prepare('SELECT MAX(version) AS v FROM schema_version').get() as
      | { v: number | null }
      | undefined
    const version = versionRow?.v ?? 0
    if (!Number.isInteger(version) || version < 1) {
      return {
        ok: false,
        error: 'The selected backup has no valid schema version. Nothing was imported.',
      }
    }
    if (version > TARGET_SCHEMA_VERSION) {
      return {
        ok: false,
        error: `The selected backup was created by a NEWER version of SubstiFlow (schema v${version}; this build supports up to v${TARGET_SCHEMA_VERSION}). Upgrade the application first, or choose a backup from this version.`,
      }
    }

    return { ok: true }
  } catch (error) {
    return {
      ok: false,
      error: `The selected file could not be opened as a SQLite database (${error instanceof Error ? error.message : String(error)}). Nothing was imported.`,
    }
  } finally {
    try {
      db?.close()
    } catch {
      /* already closed */
    }
  }
}
