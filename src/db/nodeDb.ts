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
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
    return path.join(dir, 'substiflow.db')
  }

  const userDataPath = app.getPath('userData')
  const dbDir = path.join(userDataPath, 'database')
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true })
  }
  return path.join(dbDir, 'substiflow.db')
}

export function openNodeDatabase(dbPath: string): SqlDatabase {
  const db = new Database(dbPath)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  return db as unknown as SqlDatabase
}

export function createDatabase(): SqlDatabase {
  const db = openNodeDatabase(resolveDatabasePath())
  runMigrations(db)
  return db
}
