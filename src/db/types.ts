/**
 * Minimal synchronous SQL driver contract shared by:
 *  - the Node/Electron main-process driver (`nodeDb.ts`)
 *  - the renderer IPC driver (`ipcDb.ts`)
 *
 * Repositories are intentionally synchronous (SQLite is a local, in-process
 * store), so the renderer talks to the main process over synchronous IPC.
 */

export interface SqlRunResult {
  changes: number
  lastInsertRowid: number | bigint
}

export interface SqlStatement {
  all(...params: unknown[]): unknown[]
  get(...params: unknown[]): unknown
  run(...params: unknown[]): SqlRunResult
}

export interface SqlDatabase {
  prepare(sql: string): SqlStatement
  exec(sql: string): void
  close(): void
}
