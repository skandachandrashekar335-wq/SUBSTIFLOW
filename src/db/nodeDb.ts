/**
 * Node/Electron driver.
 *
 * Only imported by the main process (and by scripts run under Node). The
 * renderer build swaps this module out for `nodeDb.browser.ts` via a Vite
 * alias, so `better-sqlite3` and `electron` never reach the browser bundle.
 */
import Database from 'better-sqlite3'
import { app } from 'electron'
import * as path from 'path'
import * as fs from 'fs'
import { schema } from './schema'
import type { SqlDatabase } from './types'

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

/** Apply the schema and any pending migrations. */
export function runMigrations(db: SqlDatabase): void {
  const hasSchemaVersion = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='schema_version'`)
    .get()

  if (!hasSchemaVersion) {
    db.exec(
      `CREATE TABLE schema_version (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (datetime('now')))`
    )
    db.exec(schema)
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(1)
    return
  }

  const current = db.prepare('SELECT MAX(version) as version FROM schema_version').get() as
    | { version: number | null }
    | undefined
  const currentVersion = current?.version ?? 0
  const targetVersion = 1

  for (let v = currentVersion + 1; v <= targetVersion; v++) {
    runMigration(db, v)
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(v)
  }
}

function runMigration(_db: SqlDatabase, version: number): void {
  // Add forward-only migration steps here when the schema evolves.
  console.log(`Applying database migration ${version}`)
}

export function createDatabase(): SqlDatabase {
  const db = openNodeDatabase(resolveDatabasePath())
  runMigrations(db)
  return db
}
