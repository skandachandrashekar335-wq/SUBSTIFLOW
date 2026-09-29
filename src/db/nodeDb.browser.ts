/**
 * Browser replacement for `nodeDb.ts` (selected by the Vite alias in
 * `vite.config.ts`). Keeps native modules out of the renderer bundle.
 */
import type { SqlDatabase } from './types'

export function createDatabase(): SqlDatabase {
  throw new Error(
    'The local database is only available inside the SubstiFlow desktop app.'
  )
}
