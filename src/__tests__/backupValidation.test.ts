/**
 * Regression tests for backup import validation (electron/backupValidation.ts).
 *
 * The renderer supplies an arbitrary file path to `backup:import`; these
 * tests pin down that only a real, non-corrupt SQLite backup can ever be
 * copied over the live database (and that corrupt files produce a clear
 * error instead of a silent overwrite).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import os from 'os'
import path from 'path'
import fs from 'fs'
import { validateBackupFile } from '../../electron/backupValidation'

let dir = ''

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'substiflow-backup-test-'))
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('backup import validation', () => {
  it('rejects files without a plausible backup extension', () => {
    const result = validateBackupFile(path.join(dir, 'payload.txt'))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toMatch(/not a SubstiFlow backup file/i)
  })

  it('rejects a non-existent file with an error instead of crashing', () => {
    const result = validateBackupFile(path.join(dir, 'missing.db'))
    expect(result.ok).toBe(false)
  })

  it('rejects an empty file as truncated', () => {
    const file = path.join(dir, 'empty.db')
    fs.writeFileSync(file, '')
    const result = validateBackupFile(file)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toMatch(/empty or truncated/i)
  })

  it('rejects a non-SQLite file even when it pretends to be a .db', () => {
    const file = path.join(dir, 'garbage.db')
    fs.writeFileSync(file, 'This is definitely not a database, just text...')
    const result = validateBackupFile(file)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toMatch(/not a valid SQLite database/i)
  })

  it('rejects a plain SQLite file that is not a SubstiFlow backup', () => {
    const file = path.join(dir, 'real.db')
    const db = new Database(file)
    db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY)')
    db.close()

    const result = validateBackupFile(file)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toMatch(/not a SubstiFlow backup.*missing/i)
  })

  it('accepts a genuine SubstiFlow backup (schema-stamped)', () => {
    const file = path.join(dir, 'substiflow.sqlite')
    const db = new Database(file)
    db.exec(`
      CREATE TABLE schema_version (version INTEGER PRIMARY KEY, applied_at TEXT);
      CREATE TABLE institutions (id TEXT PRIMARY KEY, name TEXT);
      CREATE TABLE faculty (id TEXT PRIMARY KEY, name TEXT);
      CREATE TABLE timetable_entries (id TEXT PRIMARY KEY);
      INSERT INTO schema_version (version, applied_at) VALUES (7, '2026-01-01');
    `)
    db.close()
    expect(validateBackupFile(file)).toEqual({ ok: true })
  })

  it('rejects a backup from a NEWER schema version instead of downgrading it', () => {
    const file = path.join(dir, 'future.db')
    const db = new Database(file)
    db.exec(`
      CREATE TABLE schema_version (version INTEGER PRIMARY KEY, applied_at TEXT);
      CREATE TABLE institutions (id TEXT PRIMARY KEY, name TEXT);
      CREATE TABLE faculty (id TEXT PRIMARY KEY, name TEXT);
      CREATE TABLE timetable_entries (id TEXT PRIMARY KEY);
      INSERT INTO schema_version (version, applied_at) VALUES (999, '2099-01-01');
    `)
    db.close()

    const result = validateBackupFile(file)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toMatch(/NEWER version of SubstiFlow/i)
  })

  it('rejects a file with a valid header but corrupted contents', () => {
    const file = path.join(dir, 'corrupt.db')
    const db = new Database(file)
    db.exec(`
      CREATE TABLE schema_version (version INTEGER PRIMARY KEY, applied_at TEXT);
      CREATE TABLE institutions (id TEXT PRIMARY KEY, name TEXT);
      CREATE TABLE faculty (id TEXT PRIMARY KEY, name TEXT);
      CREATE TABLE timetable_entries (id TEXT PRIMARY KEY);
      INSERT INTO schema_version (version, applied_at) VALUES (7, '2026-01-01');
    `)
    db.close()
    // Truncate mid-page: header still says SQLite, integrity check must fail.
    const bytes = fs.readFileSync(file)
    fs.writeFileSync(file, bytes.subarray(0, Math.floor(bytes.length / 2)))

    const result = validateBackupFile(file)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toMatch(/integrity|could not be opened|corrupt/i)
  })
})
