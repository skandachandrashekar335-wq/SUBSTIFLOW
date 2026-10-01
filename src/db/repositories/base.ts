import { getDatabase } from '../database'

export interface BaseEntity {
  id: string
}

/** camelCase -> snake_case column name conversion */
function toColumn(key: string): string {
  if (key === 'order') return '"order"'
  if (key === 'key') return '"key"'
  return key.replace(/[A-Z]/g, (c) => '_' + c.toLowerCase())
}

/** Normalize a value for SQLite (booleans -> 0/1, undefined -> null) */
function toParam(value: unknown): unknown {
  if (value === undefined) return null
  if (typeof value === 'boolean') return value ? 1 : 0
  return value
}

function buildWhere(where: Record<string, any>): { sql: string; values: unknown[] } {
  const keys = Object.keys(where)
  const sql = keys.map((k) => `${toColumn(k)} = ?`).join(' AND ')
  const values = keys.map((k) => toParam(where[k]))
  return { sql, values }
}

export abstract class BaseRepository<T extends BaseEntity> {
  protected abstract tableName: string
  protected abstract entityFromRow(row: any): T

  protected db() {
    return getDatabase()
  }

  /**
   * Run `fn` inside a transaction so a multi-statement write can never
   * half-apply (e.g. mappings deleted but their replacements never inserted).
   * The original error is rethrown after rollback.
   */
  protected transaction<R>(fn: () => R): R {
    const db = this.db()
    db.exec('BEGIN')
    try {
      const result = fn()
      db.exec('COMMIT')
      return result
    } catch (error) {
      try {
        db.exec('ROLLBACK')
      } catch {
        // BEGIN itself may have failed — nothing to roll back.
      }
      throw error
    }
  }

  findAll(): T[] {
    const rows = this.db()
      .prepare(`SELECT * FROM ${this.tableName} ORDER BY created_at DESC`)
      .all() as any[]
    return rows.map((row) => this.entityFromRow(row))
  }

  findById(id: string): T | null {
    const row = this.db()
      .prepare(`SELECT * FROM ${this.tableName} WHERE id = ?`)
      .get(id) as any
    return row ? this.entityFromRow(row) : null
  }

  findWhere(where: Record<string, any>, orderBy?: string): T[] {
    const { sql, values } = buildWhere(where)
    const query = `SELECT * FROM ${this.tableName} WHERE ${sql} ${orderBy ? `ORDER BY ${orderBy}` : ''}`
    const rows = this.db().prepare(query).all(...values) as any[]
    return rows.map((row) => this.entityFromRow(row))
  }

  findOneWhere(where: Record<string, any>): T | null {
    const results = this.findWhere(where)
    return results[0] || null
  }

  create(entity: { id: string } & Record<string, any>): T {
    const now = new Date().toISOString()
    const keys = Object.keys(entity).filter((k) => k !== 'id')
    const columns = keys.map((k) => toColumn(k)).join(', ')
    const placeholders = keys.map(() => '?').join(', ')
    const values = keys.map((k) => toParam(entity[k]))

    this.db()
      .prepare(
        `INSERT INTO ${this.tableName} (id, ${columns}, created_at, updated_at) VALUES (?, ${placeholders}, ?, ?)`
      )
      .run(entity.id, ...values, now, now)

    return this.findById(entity.id)!
  }

  update(id: string, updates: Record<string, any>): T | null {
    const keys = Object.keys(updates).filter((k) => k !== 'id')
    if (keys.length === 0) return this.findById(id)

    const setClause = keys.map((k) => `${toColumn(k)} = ?`).join(', ')
    const values = keys.map((k) => toParam(updates[k]))
    const now = new Date().toISOString()

    const result = this.db()
      .prepare(`UPDATE ${this.tableName} SET ${setClause}, updated_at = ? WHERE id = ?`)
      .run(...values, now, id) as any

    if (result.changes === 0) return null
    return this.findById(id)
  }

  delete(id: string): boolean {
    const result = this.db()
      .prepare(`DELETE FROM ${this.tableName} WHERE id = ?`)
      .run(id) as any
    return result.changes > 0
  }

  count(): number {
    const row = this.db()
      .prepare(`SELECT COUNT(*) as count FROM ${this.tableName}`)
      .get() as { count: number }
    return row.count
  }

  exists(id: string): boolean {
    const row = this.db()
      .prepare(`SELECT 1 FROM ${this.tableName} WHERE id = ?`)
      .get(id)
    return !!row
  }
}
