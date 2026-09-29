import { readFileSync, existsSync } from 'fs'
import { join, dirname } from 'path'

/**
 * The schema lives in `src/db/schema.sql` (source of truth).
 * Depending on the runtime (vitest, ts-node, compiled Electron main) the file
 * may live next to this module or under the project root, so we probe a few
 * known locations.
 */
function resolveSchemaPath(): string {
  const candidates = [
    join(__dirname, 'schema.sql'),
    join(__dirname, '..', '..', 'src', 'db', 'schema.sql'),
    join(process.cwd(), 'src', 'db', 'schema.sql'),
    join(process.cwd(), 'schema.sql'),
  ]

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }

  throw new Error(
    `Could not locate schema.sql. Tried:\n${candidates.map((c) => `  - ${c}`).join('\n')}`
  )
}

export const schema = readFileSync(resolveSchemaPath(), 'utf-8')
