import { BaseRepository } from './base'
import { AuditLogEntry } from '@/types'

/** Canonical action names recorded by the application. */
export const AUDIT_ACTIONS = {
  TIMETABLE_CREATED: 'timetable.created',
  TIMETABLE_UPDATED: 'timetable.updated',
  TIMETABLE_DELETED: 'timetable.deleted',
  ATTENDANCE_MARKED: 'attendance.marked',
  SUBSTITUTION_GENERATED: 'substitution.generated',
  SUBSTITUTION_OVERRIDE: 'substitution.override',
  SUBSTITUTION_LOCKED: 'substitution.locked',
  SUBSTITUTION_UNLOCKED: 'substitution.unlocked',
  SUBSTITUTION_APPROVED: 'substitution.approved',
} as const

/**
 * Audit trail — who/what/when for important coordinator actions.
 * Rows are only ever written by real actions (no fabricated history).
 */
export class AuditLogRepository extends BaseRepository<AuditLogEntry> {
  protected tableName = 'audit_log'

  protected entityFromRow(row: any): AuditLogEntry {
    return {
      id: row.id,
      action: row.action,
      entityType: row.entity_type,
      entityId: row.entity_id ?? undefined,
      detail: row.detail ?? undefined,
      createdAt: row.created_at,
    }
  }

  record(
    action: string,
    entityType: string,
    entityId?: string,
    detail?: string
  ): AuditLogEntry {
    return this.create({
      id: crypto.randomUUID(),
      action,
      entityType,
      entityId,
      detail,
    })
  }

  findRecent(limit = 10): AuditLogEntry[] {
    const rows = this.db()
      .prepare('SELECT * FROM audit_log ORDER BY created_at DESC, rowid DESC LIMIT ?')
      .all(limit) as any[]
    return rows.map(row => this.entityFromRow(row))
  }
}

export const auditLogRepository = new AuditLogRepository()
