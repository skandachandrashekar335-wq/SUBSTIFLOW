/**
 * Renderer driver: forwards synchronous SQL calls to the Electron main
 * process through the preload bridge (`window.electron.db`).
 */
import type { SqlDatabase, SqlStatement, SqlRunResult } from './types'

export function isRendererElectron(): boolean {
  return typeof window !== 'undefined' && !!window.electron?.db
}

function unwrap<T>(result: { data?: T; error?: string }): T {
  if (result.error) throw new Error(result.error)
  return result.data as T
}

export function createDatabase(): SqlDatabase {
  const api = window.electron!.db

  return {
    prepare(sql: string): SqlStatement {
      return {
        all: (...params: unknown[]) =>
          unwrap<unknown[]>(api.allSync(sql, params as unknown[])),
        get: (...params: unknown[]) => unwrap<unknown>(api.getSync(sql, params as unknown[])),
        run: (...params: unknown[]) =>
          unwrap<SqlRunResult>(api.runSync(sql, params as unknown[])),
      }
    },
    exec(sql: string): void {
      unwrap<unknown>(api.execSync(sql))
    },
    close(): void {
      // The main process owns the connection lifecycle.
    },
  }
}
