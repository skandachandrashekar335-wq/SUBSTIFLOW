/**
 * Node/Electron driver.
 *
 * Only imported by the main process (and by scripts run under Node). The
 * renderer build swaps this module out for `nodeDb.browser.ts` via a Vite
 * alias, so `better-sqlite3` and `electron` never reach the browser bundle.
 *
 * The migration logic itself lives in `./migrations` (no Electron imports)
 * so tests and CLI scripts can run the exact same code path.
 */
import Database from 'better-sqlite3'
import { app } from 'electron'
import * as path from 'path'
import * as fs from 'fs'
import type { SqlDatabase } from './types'

export { runMigrations, TARGET_SCHEMA_VERSION } from './migrations'
import { runMigrations } from './migrations'

export function resolveDatabasePath(): string {
  const override = process.env.SUBSTIFLOW_DATA_DIR
  if (override) {
    const dir = path.join(override, 'database')
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
    return path.join(dir, 'substiflow.db')
  }

  const userDataPath = app.getPath('userData')
  const dbDir = path.join(userDataPath, 'database')
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true, mode: 0o700 })
  }
  return path.join(dbDir, 'substiflow.db')
}

export function openNodeDatabase(dbPath: string): SqlDatabase {
  const db = new Database(dbPath)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  // The school's timetable, faculty and attendance data is sensitive: keep it
  // readable/writable by the owner only. (No-op semantics on Windows, where
  // the ACL decides; SQLite creates the -wal/-shm sidecars with the main
  // file's permissions.)
  try {
    fs.chmodSync(dbPath, 0o600)
  } catch {
    // Permissions are hardening, not correctness — never fail an open over them.
  }
  return db as unknown as SqlDatabase
}

export function createDatabase(): SqlDatabase {
  const db = openNodeDatabase(resolveDatabasePath())
  // Corruption discovered HERE — at startup, in one place — instead of as a
  // cryptic SQLITE_NOTADB mid-session or, worse, half-way through a
  // destructive migration. quick_check is cheap for a database of this size.
  const integrity = db.prepare('PRAGMA quick_check').get() as { quick_check?: string } | undefined
  if (!integrity || integrity.quick_check !== 'ok') {
    db.close()
    throw new Error(
      'The database file failed its integrity check. ' +
        'Nothing has been changed — restore the newest file from the "auto-backups" folder next to your database.'
    )
  }
  try {
    runMigrations(db)
  } catch (error) {
    db.close() // never leak the connection when startup is about to abort
    throw error
  }
  return db
}
