import { getDatabase } from '../database'
import { BaseRepository } from './base'
import { TimeSlot, DEFAULT_WORKING_HOURS } from '@/types'

const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/

function isValidTime(time: unknown): time is string {
  return typeof time === 'string' && TIME_PATTERN.test(time)
}

function toMinutes(time: string): number {
  const [h, m] = time.split(':').map(Number)
  return h * 60 + m
}

function formatMinutes(total: number): string {
  const h = Math.floor(total / 60)
  const m = total % 60
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
}

export class TimeSlotRepository extends BaseRepository<TimeSlot> {
  protected tableName = 'time_slots'

  protected entityFromRow(row: any): TimeSlot {
    return {
      id: row.id,
      name: row.name,
      startTime: row.start_time,
      endTime: row.end_time,
      order: row.order,
      isBreak: Boolean(row.is_break),
    }
  }

  initializeDefaults(): void {
    const existing = this.findAll()
    if (existing.length > 0) return

    const db = getDatabase()
    const stmt = db.prepare(`
      INSERT INTO time_slots (id, name, start_time, end_time, "order", is_break)
      VALUES (?, ?, ?, ?, ?, ?)
    `)

    for (const slot of DEFAULT_WORKING_HOURS.slots) {
      stmt.run(slot.id, slot.name, slot.startTime, slot.endTime, slot.order, slot.isBreak ? 1 : 0)
    }
  }

  getOrdered(): TimeSlot[] {
    const rows = this.db().prepare('SELECT * FROM time_slots ORDER BY "order"').all() as any[]
    return rows.map(row => this.entityFromRow(row))
  }

  getTeachingSlots(): TimeSlot[] {
    const rows = this.db().prepare('SELECT * FROM time_slots WHERE is_break = 0 ORDER BY "order"').all() as any[]
    return rows.map(row => this.entityFromRow(row))
  }

  getBreakSlots(): TimeSlot[] {
    const rows = this.db().prepare('SELECT * FROM time_slots WHERE is_break = 1 ORDER BY "order"').all() as any[]
    return rows.map(row => this.entityFromRow(row))
  }

  /** How many timetable entries currently reference this period. */
  getUsageCount(id: string): number {
    const row = this.db()
      .prepare('SELECT COUNT(*) as count FROM timetable_entries WHERE time_slot_id = ?')
      .get(id) as { count: number }
    return row.count
  }

  /**
   * Domain validation for a period. Throws an Error with a message a
   * coordinator can act on ("overlaps with X", "end must be after start", ...).
   */
  private validate(candidate: { name: string; startTime: string; endTime: string }, excludeId?: string): void {
    if (!candidate.name || !candidate.name.trim()) {
      throw new Error('Period name is required.')
    }
    if (!isValidTime(candidate.startTime) || !isValidTime(candidate.endTime)) {
      throw new Error('Start and end time must be in HH:mm format (e.g. 09:00).')
    }
    if (toMinutes(candidate.endTime) <= toMinutes(candidate.startTime)) {
      throw new Error('End time must be after start time.')
    }
    for (const other of this.getOrdered()) {
      if (other.id === excludeId) continue
      const overlaps =
        toMinutes(candidate.startTime) < toMinutes(other.endTime) &&
        toMinutes(candidate.endTime) > toMinutes(other.startTime)
      if (overlaps) {
        throw new Error(`This period overlaps with "${other.name}" (${other.startTime}–${other.endTime}).`)
      }
    }
  }

  /** Keep orders a dense 1..N sequence in current display order. */
  private normalizeOrders(): void {
    const rows = this.db()
      .prepare('SELECT id, "order" FROM time_slots ORDER BY "order", start_time')
      .all() as { id: string; order: number }[]
    const stmt = this.db().prepare('UPDATE time_slots SET "order" = ? WHERE id = ?')
    rows.forEach((row, index) => {
      if (row.order !== index + 1) stmt.run(index + 1, row.id)
    })
  }

  create(entity: { id: string } & Record<string, any>): TimeSlot {
    const name =
      typeof entity.name === 'string' && entity.name.trim()
        ? entity.name.trim()
        : `${entity.startTime}-${entity.endTime}`
    this.validate({ name, startTime: entity.startTime, endTime: entity.endTime })

    let prepared: { id: string } & Record<string, any> = { ...entity, name }
    if (prepared.order === undefined || prepared.order === null) {
      const max = this.getOrdered().reduce((acc, s) => Math.max(acc, s.order), 0)
      prepared = { ...prepared, order: max + 1 }
    }

    const created = super.create(prepared)
    this.normalizeOrders()
    return this.findById(created.id)!
  }

  update(id: string, updates: Record<string, any>): TimeSlot | null {
    const current = this.findById(id)
    if (!current) return null

    const merged = { ...current, ...updates }
    const name =
      typeof merged.name === 'string' && merged.name.trim()
        ? merged.name.trim()
        : `${merged.startTime}-${merged.endTime}`
    this.validate({ name, startTime: merged.startTime, endTime: merged.endTime }, id)

    const result = super.update(id, { ...updates, name })
    this.normalizeOrders()
    return result
  }

  delete(id: string): boolean {
    const slot = this.findById(id)
    if (!slot) return false

    const usage = this.getUsageCount(id)
    if (usage > 0) {
      throw new Error(
        `"${slot.name}" is used by ${usage} timetable entr${usage === 1 ? 'y' : 'ies'} and cannot be deleted. Remove or move those entries first.`
      )
    }

    const removed = super.delete(id)
    if (removed) this.normalizeOrders()
    return removed
  }

  /** Move a period one position up (-1) or down (+1) in the display order. */
  move(id: string, direction: -1 | 1): boolean {
    const ordered = this.getOrdered()
    const index = ordered.findIndex(s => s.id === id)
    const target = index + direction
    if (index === -1 || target < 0 || target >= ordered.length) return false

    const now = new Date().toISOString()
    const stmt = this.db().prepare('UPDATE time_slots SET "order" = ?, updated_at = ? WHERE id = ?')
    stmt.run(ordered[target].order, now, ordered[index].id)
    stmt.run(ordered[index].order, now, ordered[target].id)
    return true
  }

  /**
   * Regenerate the day's periods from a working-hours configuration.
   * Existing periods whose start/end times match exactly are kept (so
   * timetable entries keep their references); anything else is replaced,
   * but only after verifying no timetable entry uses a period that would
   * disappear — otherwise a friendly error is thrown and nothing changes.
   */
  rebuildFromWorkingHours(config: {
    startTime: string
    endTime: string
    breakStart: string
    breakEnd: string
  }): TimeSlot[] {
    const { startTime, endTime, breakStart, breakEnd } = config
    if (!isValidTime(startTime) || !isValidTime(endTime)) {
      throw new Error('Working hours must be in HH:mm format (e.g. 09:00).')
    }
    const dayStart = toMinutes(startTime)
    const dayEnd = toMinutes(endTime)
    if (dayEnd <= dayStart) throw new Error('Working hours end time must be after start time.')

    let breakRange: { start: number; end: number } | null = null
    if (breakStart || breakEnd) {
      if (!isValidTime(breakStart) || !isValidTime(breakEnd)) {
        throw new Error('Break times must be in HH:mm format (e.g. 13:00).')
      }
      breakRange = { start: toMinutes(breakStart), end: toMinutes(breakEnd) }
      if (breakRange.end <= breakRange.start) throw new Error('Break end must be after break start.')
      if (breakRange.start < dayStart || breakRange.end > dayEnd) {
        throw new Error('Break must lie within working hours.')
      }
    }

    // Boundary set: working-hours bounds + every full hour inside + break bounds.
    const bounds = new Set<number>([dayStart, dayEnd])
    for (let m = dayStart + 60; m < dayEnd; m += 60) bounds.add(m)
    if (breakRange) {
      bounds.add(breakRange.start)
      bounds.add(breakRange.end)
    }
    const sorted = [...bounds].sort((a, b) => a - b)
    const segments = sorted.slice(0, -1).map((start, i) => ({
      start,
      end: sorted[i + 1],
      isBreak: breakRange ? start >= breakRange.start && sorted[i + 1] <= breakRange.end : false,
    }))

    const existing = this.getOrdered()
    const matches = (slot: TimeSlot) =>
      segments.some(seg => seg.start === toMinutes(slot.startTime) && seg.end === toMinutes(slot.endTime))

    // Guard first: never delete a period that timetable entries depend on.
    const blockers = existing.filter(slot => !matches(slot) && this.getUsageCount(slot.id) > 0)
    if (blockers.length > 0) {
      const names = blockers.map(b => `"${b.name}"`).join(', ')
      throw new Error(
        `Cannot rebuild periods: ${names} ${blockers.length === 1 ? 'is' : 'are'} used by timetable entries. Edit the periods manually instead.`
      )
    }

    // Remove periods that no longer exist in the new schedule.
    for (const slot of existing) {
      if (!matches(slot)) super.delete(slot.id)
    }

    // Keep matching periods (only syncing the break flag), create the new ones.
    for (const seg of segments) {
      const match = existing.find(
        s => toMinutes(s.startTime) === seg.start && toMinutes(s.endTime) === seg.end
      )
      if (match) {
        if (Boolean(match.isBreak) !== seg.isBreak) super.update(match.id, { isBreak: seg.isBreak ? 1 : 0 })
      } else {
        super.create({
          id: crypto.randomUUID(),
          name: `${formatMinutes(seg.start)}-${formatMinutes(seg.end)}`,
          startTime: formatMinutes(seg.start),
          endTime: formatMinutes(seg.end),
          order: seg.start,
          isBreak: seg.isBreak ? 1 : 0,
        })
      }
    }

    // Canonical order follows the clock.
    const rows = this.db()
      .prepare('SELECT id, start_time FROM time_slots ORDER BY start_time')
      .all() as { id: string; start_time: string }[]
    const stmt = this.db().prepare('UPDATE time_slots SET "order" = ? WHERE id = ?')
    rows.forEach((row, index) => stmt.run(index + 1, row.id))

    return this.getOrdered()
  }
}

export const timeSlotRepository = new TimeSlotRepository()
