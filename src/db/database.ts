import type { SqlDatabase } from './types'
import { createDatabase as createNodeDatabase } from '@/db/nodeDb'
import { createDatabase as createIpcDatabase, isRendererElectron } from '@/db/ipcDb'

let db: SqlDatabase | null = null

/**
 * Lazily open the SQLite connection.
 *  - inside Electron's renderer we talk to the main process over IPC
 *  - under Node (scripts, tests) we open the file directly
 */
export function getDatabase(): SqlDatabase {
  if (db) return db
  db = isRendererElectron() ? createIpcDatabase() : createNodeDatabase()
  return db
}

export function closeDatabase(): void {
  if (db) {
    db.close()
    db = null
  }
}
