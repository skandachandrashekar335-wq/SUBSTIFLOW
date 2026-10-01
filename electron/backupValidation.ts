/**
 * Backup file validation for the `backup:import` IPC path.
 *
 * Kept free of Electron imports so it can be unit-tested (vitest runs under
 * plain Node). The renderer supplies an arbitrary path here, so before
 * anything may touch the live database we verify: a plausible extension, a
 * non-empty file, and a real SQLite header — which also turns corrupt or
 * truncated backups into a clear error instead of a silent overwrite.
 */
import * as path from 'path'
import * as fs from 'fs'

export const SQLITE_HEADER = Buffer.from('SQLite format 3\0', 'binary')
export const BACKUP_EXTENSIONS = new Set(['.db', '.sqlite', '.sqlite3', '.backup'])

export function validateBackupFile(filePath: string): { ok: true } | { ok: false; error: string } {
  if (!BACKUP_EXTENSIONS.has(path.extname(filePath).toLowerCase())) {
    return { ok: false, error: 'That is not a SubstiFlow backup file (expected .db or .sqlite).' }
  }
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
    return { ok: true }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}
