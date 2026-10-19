/**
 * Single source of truth for opening a write transaction on the app's
 * SQLite connection (in-process driver under Node, IPC driver in the
 * renderer — both expose a synchronous `exec`).
 *
 * Multi-statement writes that must be all-or-nothing (e.g. replacing
 * conflicting timetable entries) wrap their work in `withTransaction` so a
 * failure half-way can never leave the database with half the operation
 * applied.
 *
 * Nesting: SQLite refuses `BEGIN` inside an open transaction. That refusal
 * is detected and the inner work runs under a SAVEPOINT instead, so an
 * inner failure rolls back only the inner work and rethrows, leaving the
 * outer transaction free to decide the fate of the whole operation. This
 * keeps working through the renderer's IPC driver, where the error arrives
 * as a string over the bridge.
 */
import { getDatabase } from './database'

let savepointCounter = 0

export function withTransaction<R>(fn: () => R): R {
  const db = getDatabase()

  let savepoint: string | null = null
  try {
    db.exec('BEGIN')
  } catch (error) {
    if (!/within a transaction/i.test(String((error as Error)?.message ?? error))) throw error
    savepoint = `sp_${savepointCounter++}`
    db.exec(`SAVEPOINT ${savepoint}`)
  }

  try {
    const result = fn()
    if (savepoint !== null) {
      db.exec(`RELEASE ${savepoint}`)
    } else {
      db.exec('COMMIT')
    }
    return result
  } catch (error) {
    try {
      if (savepoint !== null) {
        db.exec(`ROLLBACK TO ${savepoint}`)
        db.exec(`RELEASE ${savepoint}`)
      } else {
        db.exec('ROLLBACK')
      }
    } catch {
      // BEGIN itself may have failed — nothing to roll back.
    }
    throw error
  }
}
