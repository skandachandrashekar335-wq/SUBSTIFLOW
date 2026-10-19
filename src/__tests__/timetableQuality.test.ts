/**
 * Timetable quality regressions — the real generator against the demo fixture.
 *
 * Background: the generator used to satisfy every HARD constraint while
 * clustering all sessions into the earliest free periods: the whole afternoon
 * (14:00–16:00) stayed empty for every section, one period carried a third of
 * a section's week, room contention at those peaks left lectures without
 * rooms, and faculty stacked onto single days. All of that was "valid".
 *
 * These tests assert the measurable QUALITY invariants that the soft
 * scoring now guarantees, without demanding one exact arrangement:
 *
 *   1. every section's week uses every configured teaching period
 *      (afternoons included — the root-cause symptom),
 *   2. period loads stay within a documented balance bound,
 *   3. day loads stay within a documented balance bound and no working day
 *      is left empty,
 *   4. no section-day contains an isolated single-period gap,
 *   5. independent validation still passes with zero errors — proving the
 *      soft preferences never override a hard constraint,
 *   6. every LAB session carries a real laboratory room,
 *   7. publication preserves the room and faculty relationships of every
 *      entry,
 *   8. generation remains deterministic.
 *
 * The tests run only against an in-memory disposable database seeded from
 * the demo fixture — never against any file-backed database.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import Database from 'better-sqlite3'
import { schema } from '@/db/schema'
import { buildDemoFixture, DEMO_YEAR_ID } from '@/db/demoFixture'
import {
  generateTimetable,
  validateDraftTimetable,
  publishDraftTimetable,
} from '@/services/timetableGenerator'

let testDb: Database.Database | null = null

vi.mock('@/db/database', () => ({
  getDatabase: () => testDb,
  closeDatabase: () => undefined,
}))

interface EntryRow {
  day_of_week: string
  time_slot_id: string
  section_id: string
  subject_id: string
  class_type: string
  span: number
}

describe('timetable quality (demo fixture, real generator)', () => {
  let generationId = ''
  const ordinalOf = new Map<string, number>()
  let periodCount = 0
  let entries: EntryRow[] = []
  const sectionNames = new Map<string, string>()

  beforeAll(() => {
    testDb = new Database(':memory:')
    testDb.exec(schema)
    buildDemoFixture(testDb)

    // Teaching-period ordinals (break excluded): 09:00 → 1 … 15:00 → 6.
    const ordinals = testDb
      .prepare(
        `SELECT id, (SELECT COUNT(*) FROM time_slots t2
                       WHERE t2.is_break = 0 AND t2."order" <= t1."order") AS ord
           FROM time_slots t1 WHERE t1.is_break = 0 ORDER BY t1."order"`
      )
      .all() as Array<{ id: string; ord: number }>
    ordinals.forEach((o) => ordinalOf.set(o.id, o.ord))
    periodCount = ordinals.length

    const gen = generateTimetable(DEMO_YEAR_ID)
    generationId = gen.generationId
    expect(gen.status).toBe('COMPLETED')
    expect(gen.statistics.uncovered).toBe(0)

    entries = testDb
      .prepare(
        `SELECT day_of_week, time_slot_id, section_id, subject_id, class_type, span
           FROM draft_timetable_entries WHERE generation_id = ?`
      )
      .all(generationId) as EntryRow[]
    for (const s of testDb.prepare('SELECT id, name FROM sections').all() as Array<{
      id: string
      name: string
    }>) {
      sectionNames.set(s.id, s.name)
    }
  })

  afterAll(() => {
    testDb?.close()
    testDb = null
  })

  /** Span-aware per-period occupancy of one section: ordinal -> period count. */
  function periodLoads(sectionId: string): number[] {
    const loads = new Array(periodCount).fill(0)
    for (const e of entries.filter((x) => x.section_id === sectionId)) {
      const ord = ordinalOf.get(e.time_slot_id)
      expect(ord, `slot ${e.time_slot_id} must be a teaching period`).toBeDefined()
      for (let i = 0; i < e.span; i++) loads[ord! - 1 + i] += 1
    }
    return loads
  }

  /** Sessions of one section per working day. */
  function dayLoads(sectionId: string): Record<string, number> {
    const byDay: Record<string, number> = {}
    for (const e of entries.filter((x) => x.section_id === sectionId)) {
      byDay[e.day_of_week] = (byDay[e.day_of_week] ?? 0) + 1
    }
    return byDay
  }

  const workingDays = ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY']

  it('uses every configured teaching period for every section — afternoons are not left empty', () => {
    for (const [id, name] of sectionNames) {
      const loads = periodLoads(id)
      expect(loads).toHaveLength(periodCount)
      loads.forEach((n, idx) => {
        expect(n, `${name}: teaching period ${idx + 1} must carry at least one session`).toBeGreaterThan(0)
      })
      // Explicit root-cause guard: the two periods after the 13:00–14:00
      // break must both be used (the old scheduler left both at zero).
      const afternoon = loads.slice(4).reduce((a, b) => a + b, 0)
      expect(afternoon, `${name}: sessions after the lunch break`).toBeGreaterThanOrEqual(2)
    }
  })

  it('keeps period loads balanced — no period carries more than ceil(average) + 1', () => {
    for (const [id, name] of sectionNames) {
      const loads = periodLoads(id)
      const total = loads.reduce((a, b) => a + b, 0)
      const bound = Math.ceil(total / periodCount) + 1
      expect(Math.max(...loads), `${name}: busiest period load`).toBeLessThanOrEqual(bound)
    }
  })

  it('keeps day loads balanced — every working day is used, none exceeds ceil(average) + 1', () => {
    for (const [id, name] of sectionNames) {
      const loads = dayLoads(id)
      const sessions = Object.values(loads).reduce((a, b) => a + b, 0)
      const bound = Math.ceil(sessions / workingDays.length) + 1
      for (const day of workingDays) {
        const n = loads[day] ?? 0
        expect(n, `${name}: ${day} must not be empty`).toBeGreaterThan(0)
        expect(n, `${name}: ${day} session count`).toBeLessThanOrEqual(bound)
      }
    }
  })

  it('has no isolated single-period gap inside any section-day', () => {
    // The lunch break separates two contiguous blocks; a free period with
    // classes on BOTH sides inside the same block is the "isolated gap".
    const blocks = [
      [0, 1, 2, 3],
      [4, 5],
    ]
    const gaps: string[] = []
    for (const [id, name] of sectionNames) {
      for (const day of workingDays) {
        const occupied = new Set<number>()
        for (const e of entries.filter((x) => x.section_id === id && x.day_of_week === day)) {
          const ord = ordinalOf.get(e.time_slot_id)!
          for (let i = 0; i < e.span; i++) occupied.add(ord - 1 + i)
        }
        for (const block of blocks) {
          for (const t of block) {
            if (occupied.has(t)) continue
            const after = block.includes(t - 1) && occupied.has(t - 1)
            const before = block.includes(t + 1) && occupied.has(t + 1)
            if (after && before) gaps.push(`${name} ${day} period ${t + 1}`)
          }
        }
      }
    }
    expect(gaps).toEqual([])
  })

  it('passes independent validation with zero errors — soft preferences never beat a hard constraint', () => {
    const v = validateDraftTimetable(generationId)
    expect(v.errors).toEqual([])
    expect(v.valid).toBe(true)
    expect(v.scheduledSessions).toBe(v.requiredSessions)
  })

  it('assigns a real laboratory room to every LAB session', () => {
    const labs = entries.filter((e) => e.class_type === 'LAB')
    expect(labs.length).toBe(16) // 8 lab subjects × 2 sections
    const labNoRoom = (
      testDb!
        .prepare(
          `SELECT COUNT(*) AS c FROM draft_timetable_entries d
            WHERE d.generation_id = ? AND d.class_type = 'LAB'
              AND NOT EXISTS (SELECT 1 FROM draft_timetable_entry_rooms r WHERE r.entry_id = d.id)`
        )
        .get(generationId) as { c: number }
    ).c
    expect(labNoRoom).toBe(0)
    const labWrongRoom = (
      testDb!
        .prepare(
          `SELECT COUNT(*) AS c FROM draft_timetable_entries d
             JOIN draft_timetable_entry_rooms r ON r.entry_id = d.id
             JOIN rooms rm ON rm.id = r.room_id
            WHERE d.generation_id = ? AND d.class_type = 'LAB' AND rm.type <> 'LAB'`
        )
        .get(generationId) as { c: number }
    ).c
    expect(labWrongRoom).toBe(0)
  })

  it('keeps faculty day loads level — no teacher exceeds four sessions on one day', () => {
    const rows = testDb!
      .prepare(
        `SELECT f.name, d.day_of_week, COUNT(*) AS n
           FROM draft_timetable_entries d
           JOIN draft_timetable_entry_faculty ef ON ef.entry_id = d.id
           JOIN faculty f ON f.id = ef.faculty_id
          WHERE d.generation_id = ?
          GROUP BY f.id, d.day_of_week`
      )
      .all(generationId) as Array<{ name: string; day_of_week: string; n: number }>
    expect(rows.length).toBeGreaterThan(0)
    for (const r of rows) {
      expect(r.n, `${r.name} on ${r.day_of_week}`).toBeLessThanOrEqual(4)
    }
  })

  it('publication preserves the room and faculty relationships of every entry', () => {
    const draftRoomRows = (
      testDb!.prepare('SELECT COUNT(*) AS c FROM draft_timetable_entry_rooms').get() as { c: number }
    ).c
    const draftFacultyRows = (
      testDb!.prepare('SELECT COUNT(*) AS c FROM draft_timetable_entry_faculty').get() as { c: number }
    ).c
    expect(draftRoomRows).toBeGreaterThan(0)

    const pub = publishDraftTimetable(generationId)
    expect(pub.publishedEntries).toBe(124)

    const pubRoomRows = (
      testDb!.prepare('SELECT COUNT(*) AS c FROM timetable_entry_rooms').get() as { c: number }
    ).c
    const pubFacultyRows = (
      testDb!.prepare('SELECT COUNT(*) AS c FROM timetable_entry_faculty').get() as { c: number }
    ).c
    expect(pubRoomRows).toBe(draftRoomRows)
    expect(pubFacultyRows).toBe(draftFacultyRows)

    // Every published LAB still has a real lab room (no lost join record).
    const labNoRoom = (
      testDb!
        .prepare(
          `SELECT COUNT(*) AS c FROM timetable_entries e
            WHERE e.class_type = 'LAB'
              AND NOT EXISTS (SELECT 1 FROM timetable_entry_rooms r WHERE r.entry_id = e.id)`
        )
        .get() as { c: number }
    ).c
    expect(labNoRoom).toBe(0)
  })

  it('is deterministic — a fresh fixture regenerates the identical timetable', () => {
    const snapshotSql = `SELECT day_of_week, time_slot_id, section_id, subject_id
               FROM draft_timetable_entries ORDER BY day_of_week, time_slot_id, section_id, subject_id`
    const key = (rows: Array<Record<string, string>>) =>
      JSON.stringify(rows.map((e) => `${e.day_of_week}|${e.time_slot_id}|${e.section_id}|${e.subject_id}`))

    const before = key(testDb!.prepare(snapshotSql).all() as Array<Record<string, string>>)

    // Regenerate on a pristine copy of the fixture (repositories read the
    // mocked database binding at call time, so swap it for the fresh one).
    const fresh = new Database(':memory:')
    const saved = testDb
    try {
      fresh.exec(schema)
      buildDemoFixture(fresh)
      testDb = fresh
      const gen2 = generateTimetable(DEMO_YEAR_ID)
      expect(gen2.status).toBe('COMPLETED')
      const after = key(fresh.prepare(snapshotSql).all() as Array<Record<string, string>>)
      expect(after).toBe(before)
    } finally {
      testDb = saved
      fresh.close()
    }
  })
})
