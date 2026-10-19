/**
 * demo:audit — read-only audit of the isolated demo timetable.
 *
 * Opens ONLY the resolved demo database (never production), never writes, and
 * prints a full report:
 *   - per-section and per-subject required / scheduled sessions and occupied periods
 *   - sessions per day per section, sessions per period across sections
 *   - faculty workload by day and week, room utilisation
 *   - blank slot accounting (breaks, no-requirement blanks, unexplained blanks)
 *   - entries with missing/invalid rooms, hard-constraint violations
 *
 * Usage: node scripts/demo/audit.js [--json] [--out <file>]
 */
const path = require('path')
const fs = require('fs')

const ROOT = path.resolve(__dirname, '..', '..')
const DIST_DEMO_PATHS = path.join(ROOT, 'dist', 'main', 'src', 'db', 'demoPaths')
if (!fs.existsSync(`${DIST_DEMO_PATHS}.js`)) {
  console.error('audit: compiled demo modules missing — run `npm run build:electron` first.')
  process.exit(1)
}
const { resolveDemoPaths, assertSafeDemoPaths } = require(DIST_DEMO_PATHS)
const paths = resolveDemoPaths(ROOT)
assertSafeDemoPaths(paths) // refuses anything that is not the isolated demo dir

if (!fs.existsSync(paths.dbPath)) {
  console.error(`audit: no demo database at ${paths.dbPath}. Run: npm run demo:setup`)
  process.exit(1)
}

const Database = require('better-sqlite3')
const db = new Database(paths.dbPath, { readonly: true })
const q = (sql, ...p) => db.prepare(sql).all(...p)
const one = (sql, ...p) => db.prepare(sql).get(...p)

const args = process.argv.slice(2)
const asJson = args.includes('--json')
const outIdx = args.indexOf('--out')
const outFile = outIdx >= 0 ? args[outIdx + 1] : null

const DAY_ORDER = ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY', 'SUNDAY']
const R = {} // report

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
R.database = paths.dbPath
R.academicYears = q('SELECT id, name, is_active FROM academic_years')
R.workingDays = (one(`SELECT value FROM application_settings WHERE key = 'working_days'`) || {}).value
R.workingHours = {
  start: (one(`SELECT value FROM application_settings WHERE key = 'working_hours_start'`) || {}).value,
  end: (one(`SELECT value FROM application_settings WHERE key = 'working_hours_end'`) || {}).value,
  breakStart: (one(`SELECT value FROM application_settings WHERE key = 'break_start'`) || {}).value,
  breakEnd: (one(`SELECT value FROM application_settings WHERE key = 'break_end'`) || {}).value,
}
R.timeSlots = q('SELECT id, name, start_time, end_time, "order", is_break FROM time_slots ORDER BY "order"')
R.sections = q('SELECT id, name, semester FROM sections ORDER BY semester, name')
R.subjects = q('SELECT id, name, code, default_class_type FROM subjects ORDER BY code')
R.faculty = q('SELECT id, name, employee_id, staff_type, max_daily_substitutions FROM faculty ORDER BY employee_id')
R.rooms = q('SELECT id, name, type, capacity FROM rooms ORDER BY name')

// ---------------------------------------------------------------------------
// Requirements / allocations consistency
// ---------------------------------------------------------------------------
R.requirements = q(
  `SELECT r.id, r.section_id, sec.name AS section, r.subject_id, sub.name AS subject, sub.code,
          r.class_type, r.required_sessions_per_week AS sessions, r.span, r.teaching_arrangement
     FROM subject_requirements r
     JOIN sections sec ON sec.id = r.section_id
     JOIN subjects sub ON sub.id = r.subject_id
    ORDER BY sec.semester, sec.name, sub.code`
)
R.allocations = q(
  `SELECT a.id, a.section_id, sec.name AS section, a.subject_id, sub.name AS subject,
          a.faculty_id, f.name AS faculty, f.staff_type, a.class_type,
          a.required_sessions_per_week AS sessions
     FROM teaching_allocations a
     JOIN sections sec ON sec.id = a.section_id
     JOIN subjects sub ON sub.id = a.subject_id
     JOIN faculty f ON f.id = a.faculty_id
    ORDER BY sec.name, sub.code, f.name`
)

const facultyById = new Map(R.faculty.map((f) => [f.id, f]))
const teachingSlotsOrdered = R.timeSlots.filter((t) => !t.is_break).sort((a, b) => Number(a.order) - Number(b.order))

function effectiveArrangement(requirement, eligibleFacultyCount) {
  if (requirement.teaching_arrangement === 'TEAM') return 'TEAM'
  if (requirement.teaching_arrangement === 'ALTERNATE') return 'ALTERNATE'
  return requirement.class_type === 'LAB' && eligibleFacultyCount > 1 ? 'TEAM' : 'ALTERNATE'
}

function occupiedPeriodKeys(entry) {
  const startIndex = teachingSlotsOrdered.findIndex((t) => Number(t.order) === Number(entry.slot_order))
  if (startIndex < 0) return [`${entry.day_of_week}#${entry.slot_order}`]
  return teachingSlotsOrdered
    .slice(startIndex, startIndex + Math.max(1, Number(entry.span) || 1))
    .map((t) => `${entry.day_of_week}#${t.order}`)
}

// Requirements with no allocation (blocking input error)
R.requirementsWithoutAllocation = R.requirements.filter(
  (r) => !R.allocations.some((a) => a.section_id === r.section_id && a.subject_id === r.subject_id && a.class_type === r.class_type && a.staff_type === 'TEACHING')
)
// Allocations with no requirement (allocation-side extra demand)
R.allocationsWithoutRequirement = R.allocations.filter(
  (a) => !R.requirements.some((r) => r.section_id === a.section_id && r.subject_id === a.subject_id && r.class_type === a.class_type)
)
// Non-teaching allocations (must be zero)
R.nonTeachingAllocations = R.allocations.filter((a) => a.staff_type !== 'TEACHING')
// Subjects with no qualified teaching faculty
R.subjectsWithoutQualifiedFaculty = R.requirements.filter((r) => {
  const hasQual = q(
    `SELECT 1 FROM faculty_subjects fs JOIN faculty f ON f.id = fs.faculty_id
      WHERE fs.subject_id = ? AND f.staff_type = 'TEACHING' AND f.is_active = 1 LIMIT 1`,
    r.subject_id
  ).length
  const hasAlloc = R.allocations.some(
    (a) => a.section_id === r.section_id && a.subject_id === r.subject_id && a.faculty_id && a.staff_type === 'TEACHING'
  )
  return !hasQual && !hasAlloc
})
// Duplicate seed detection
R.duplicates = {
  requirements: q('SELECT section_id, subject_id, class_type, COUNT(*) n FROM subject_requirements GROUP BY 1,2,3 HAVING n > 1'),
  allocations: q('SELECT section_id, subject_id, faculty_id, class_type, COUNT(*) n FROM teaching_allocations GROUP BY 1,2,3,4 HAVING n > 1'),
  subjects: q('SELECT code, COUNT(*) n FROM subjects GROUP BY code HAVING n > 1'),
}
// Weekly demand vs week capacity
const workingDays = (R.workingDays || 'MONDAY,TUESDAY,WEDNESDAY,THURSDAY,FRIDAY').split(',').length
const teachingSlots = R.timeSlots.filter((t) => !t.is_break).length
R.weekCapacity = {
  workingDays,
  teachingSlots,
  occupiedPeriodsPerSection: workingDays * teachingSlots,
}
R.demandVsCapacity = R.sections.map((sec) => {
  const rows = R.requirements.filter((r) => r.section_id === sec.id)
  const sessions = rows.reduce((s, r) => s + r.sessions, 0)
  const occupiedPeriods = rows.reduce((s, r) => s + r.sessions * r.span, 0)
  const capacityOccupiedPeriods = workingDays * teachingSlots
  return { section: sec.name, sessions, occupiedPeriods, capacityOccupiedPeriods, overCapacity: occupiedPeriods > capacityOccupiedPeriods }
})
R.teachingAllocationWorkload = (() => {
  const byFaculty = {}
  for (const a of R.allocations) {
    if (a.staff_type !== 'TEACHING') continue
    byFaculty[a.faculty] = (byFaculty[a.faculty] || 0) + a.sessions
  }
  return Object.entries(byFaculty).map(([faculty, sessionsPerWeek]) => ({ faculty, sessionsPerWeek, sections: R.allocations.filter((a) => a.faculty === faculty).length }))
})()

// ---------------------------------------------------------------------------
// Draft + published entries
// ---------------------------------------------------------------------------
R.generations = q('SELECT id, status, created_at, completed_at, diagnostics_summary FROM timetable_generations ORDER BY created_at')
const latest = R.generations.length ? R.generations[R.generations.length - 1] : null
R.latestGeneration = latest
R.diagnostics = latest
  ? q('SELECT severity, code, message FROM generation_diagnostics WHERE generation_id = ? ORDER BY severity, code', latest.id)
  : []

const DRAFT = `
  SELECT d.id, d.generation_id, d.day_of_week, d.time_slot_id, d.section_id, d.subject_id,
         d.class_type, d.span, ts."order" AS slot_order, ts.is_break,
         sub.name AS subject, sub.code, sec.name AS section
    FROM draft_timetable_entries d
    JOIN time_slots ts ON ts.id = d.time_slot_id
    JOIN subjects sub ON sub.id = d.subject_id
    JOIN sections sec ON sec.id = d.section_id`
R.draftEntries = q(DRAFT)
R.publishedEntries = q(`
  SELECT e.id, e.day_of_week, e.time_slot_id, e.section_id, e.subject_id, e.class_type, e.span,
         ts."order" AS slot_order, ts.is_break, sub.name AS subject, sub.code, sec.name AS section
    FROM timetable_entries e
    JOIN time_slots ts ON ts.id = e.time_slot_id
    JOIN subjects sub ON sub.id = e.subject_id
    JOIN sections sec ON sec.id = e.section_id`)

function entryFaculty(table, idCol) {
  const rows = q(
    `SELECT f.${idCol} AS entry_id, fa.id AS faculty_id, fa.name, fa.staff_type
       FROM ${table === 'draft' ? 'draft_timetable_entry_faculty' : 'timetable_entry_faculty'} f
       JOIN faculty fa ON fa.id = f.faculty_id`
  )
  const map = {}
  for (const r of rows) (map[r.entry_id] = map[r.entry_id] || []).push(r)
  return map
}
function entryRooms(table, idCol) {
  const rows = q(
    `SELECT er.${idCol} AS entry_id, r.id, r.name, r.type, r.capacity
       FROM ${table === 'draft' ? 'draft_timetable_entry_rooms' : 'timetable_entry_rooms'} er
       JOIN rooms r ON r.id = er.room_id`
  )
  const map = {}
  for (const r of rows) (map[r.entry_id] = map[r.entry_id] || []).push(r)
  return map
}
const draftFac = entryFaculty('draft', 'entry_id')
const pubFac = entryFaculty('published', 'entry_id')
const draftRooms = entryRooms('draft', 'entry_id')
const pubRooms = entryRooms('published', 'entry_id')

R.entryFacultyCounts = {
  draftEntriesWithoutFaculty: R.draftEntries.filter((e) => !(draftFac[e.id] || []).length).length,
  publishedEntriesWithoutFaculty: R.publishedEntries.filter((e) => !(pubFac[e.id] || []).length).length,
}

// ---------------------------------------------------------------------------
// Coverage: required vs scheduled per section and subject requirement.
// A session is one timetable activity row. An occupied period is one hourly
// grid cell touched by that activity, including every cell in a multi-period span.
// ---------------------------------------------------------------------------
function coverage(entries, facMap, roomMap) {
  return R.sections.map((sec) => {
    const reqs = R.requirements.filter((r) => r.section_id === sec.id)
    const requiredSessions = reqs.reduce((s, r) => s + r.sessions, 0)
    const mine = entries.filter((e) => e.section_id === sec.id)
    const requirements = reqs.map((r) => {
      const got = mine.filter((e) => e.subject_id === r.subject_id && e.class_type === r.class_type)
      const eligible = R.allocations
        .filter((a) => a.section_id === r.section_id && a.subject_id === r.subject_id && a.class_type === r.class_type)
        .map((a) => facultyById.get(a.faculty_id))
        .filter((f) => f && f.staff_type === 'TEACHING')
        .filter((f, i, all) => all.findIndex((x) => x.id === f.id) === i)
      const scheduledPeriods = got.reduce((s, e) => s + Number(e.span || 1), 0)
      const requiredPeriods = r.sessions * r.span
      return {
        section: r.section,
        subject: r.subject,
        code: r.code,
        classType: r.class_type,
        requiredSessions: r.sessions,
        requiredOccupiedPeriods: requiredPeriods,
        eligibleFaculty: eligible.map((f) => f.name),
        arrangement: effectiveArrangement(r, eligible.length),
        span: r.span,
        scheduledSessions: got.length,
        scheduledOccupiedPeriods: scheduledPeriods,
        missing: Math.max(0, r.sessions - got.length),
        missingOccupiedPeriods: Math.max(0, requiredPeriods - scheduledPeriods),
      }
    })
    const requiredPeriods = requirements.reduce((s, r) => s + r.requiredOccupiedPeriods, 0)
    const scheduledSessions = requirements.reduce((s, r) => s + r.scheduledSessions, 0)
    const scheduledPeriods = requirements.reduce((s, r) => s + r.scheduledOccupiedPeriods, 0)
    const missingSessions = requirements.reduce((s, r) => s + r.missing, 0)
    const missingOccupiedPeriods = requirements.reduce((s, r) => s + r.missingOccupiedPeriods, 0)
    const missingDetail = requirements
      .filter((r) => r.missing || r.missingOccupiedPeriods)
      .map((r) => `${r.subject} (${r.classType}): ${r.scheduledSessions}/${r.requiredSessions} sessions, ${r.scheduledOccupiedPeriods}/${r.requiredOccupiedPeriods} occupied periods`)
    // Occupied periods = distinct (day, slot) cells touched, including spans.
    const occupied = new Set(mine.flatMap(occupiedPeriodKeys))
    const totalPeriodCells = workingDays * teachingSlots
    const sessionsByDay = {}
    for (const d of DAY_ORDER) sessionsByDay[d] = 0
    for (const e of mine) sessionsByDay[e.day_of_week] = (sessionsByDay[e.day_of_week] || 0) + 1
    const roomsMissing = mine.filter((e) => !(roomMap[e.id] || []).length)
    return {
      section: sec.name,
      requiredSessions,
      scheduledSessions,
      scheduledPeriods,
      requiredPeriods,
      missingSessions,
      missingOccupiedPeriods,
      missingDetail,
      occupiedPeriods: occupied.size,
      emptyPeriods: totalPeriodCells - occupied.size,
      sessionsByDay,
      entriesWithoutRooms: roomsMissing.length,
      entriesWithoutFaculty: mine.filter((e) => !(facMap[e.id] || []).length).length,
      requirements,
    }
  })
}
R.draftCoverage = coverage(R.draftEntries, draftFac, draftRooms)
R.publishedCoverage = coverage(R.publishedEntries, pubFac, pubRooms)
R.requirementCoverage = (R.publishedEntries.length ? R.publishedCoverage : R.draftCoverage).flatMap((s) => s.requirements)

// ---------------------------------------------------------------------------
// Distribution: sessions per period across all sections (published view preferred)
// ---------------------------------------------------------------------------
const viewEntries = R.publishedEntries.length ? R.publishedEntries : R.draftEntries
const viewFac = R.publishedEntries.length ? pubFac : draftFac
const viewRooms = R.publishedEntries.length ? pubRooms : draftRooms
R.view = R.publishedEntries.length ? 'published' : 'draft'
R.viewCoverage = R.publishedEntries.length ? R.publishedCoverage : R.draftCoverage

R.sessionsPerPeriod = R.timeSlots.map((t) => ({
  period: t.name,
  isBreak: !!t.is_break,
  sessions: viewEntries.filter((e) => e.time_slot_id === t.id).length,
}))
R.sessionsPerDay = DAY_ORDER.map((d) => ({
  day: d,
  sessions: viewEntries.filter((e) => e.day_of_week === d).length,
}))
R.sessionsPerDaySection = R.sections.map((sec) => ({
  section: sec.name,
  byDay: Object.fromEntries(
    DAY_ORDER.map((d) => [d, viewEntries.filter((e) => e.section_id === sec.id && e.day_of_week === d).length])
  ),
}))

// ---------------------------------------------------------------------------
// Faculty workload (published view)
// ---------------------------------------------------------------------------
R.facultyWorkload = R.faculty.map((f) => {
  const mine = viewEntries.filter((e) => (viewFac[e.id] || []).some((x) => x.faculty_id === f.id))
  const byDay = Object.fromEntries(DAY_ORDER.map((d) => [d, mine.filter((e) => e.day_of_week === d).length]))
  return { faculty: f.name, staffType: f.staff_type, week: mine.length, byDay }
})

// ---------------------------------------------------------------------------
// Room utilisation + missing rooms
// ---------------------------------------------------------------------------
R.roomUtilisation = R.rooms.map((rm) => ({
  room: rm.name,
  type: rm.type,
  usedBy: viewEntries.filter((e) => (viewRooms[e.id] || []).some((x) => x.id === rm.id)).length,
}))
// Room rules in this app: LAB activities must have a lab room; LECTURE may be roomless.
R.labEntriesMissingRoom = viewEntries.filter(
  (e) => e.class_type === 'LAB' && !(viewRooms[e.id] || []).length
)
R.entriesWithInvalidRoom = viewEntries.filter((e) =>
  (viewRooms[e.id] || []).some((r) => (e.class_type === 'LAB' ? r.type !== 'LAB' : false))
)
R.lectureEntriesWithRoom = viewEntries.filter(
  (e) => e.class_type === 'LECTURE' && (viewRooms[e.id] || []).length
).length
R.lectureEntriesWithoutRoom = viewEntries.filter(
  (e) => e.class_type === 'LECTURE' && !(viewRooms[e.id] || []).length
).length

// ---------------------------------------------------------------------------
// Hard-constraint violations on the published/draft view
// ---------------------------------------------------------------------------
function conflictsFor(entries, assignFn, label) {
  const map = {}
  const out = []
  for (const e of entries) {
    const slotOrders = occupiedPeriodKeys(e).map((key) => Number(key.split('#')[1]))
    for (const owner of assignFn(e)) {
      const key = `${owner}#${e.day_of_week}`
      map[key] = map[key] || []
      for (const slotOrder of slotOrders) map[key][slotOrder] = (map[key][slotOrder] || []).concat(e.id)
    }
  }
  for (const [key, slots] of Object.entries(map)) {
    for (let i = 0; i < slots.length; i++) {
      if ((slots[i] || []).length > 1) {
        out.push({ label, key, slot: i, entries: slots[i] })
        // skip ahead to avoid duplicate reports for the same run
        while (i + 1 < slots.length && (slots[i + 1] || []).length > 1) i++
      }
    }
  }
  return out
}
const facultyOwners = (e) => (viewFac[e.id] || []).map((f) => f.faculty_id)
const sectionOwner = (e) => [e.section_id]
const roomOwners = (e) => (viewRooms[e.id] || []).map((r) => r.id)
R.violations = {
  faculty: conflictsFor(viewEntries, facultyOwners, 'faculty'),
  section: conflictsFor(viewEntries, sectionOwner, 'section'),
  room: conflictsFor(viewEntries, roomOwners, 'room'),
}
R.violationCount = Object.values(R.violations).reduce((s, v) => s + v.length, 0)

// Slots: occupied vs break vs legitimate blanks
const breakSlots = new Set(viewEntries.filter((e) => e.is_break).map((e) => `${e.day_of_week}#${e.slot_order}`))
R.blankAccounting = {
  totalGridCells: workingDays * teachingSlots * R.sections.length,
  occupiedCells: (() => {
    const cells = new Set()
    for (const e of viewEntries) {
      for (const key of occupiedPeriodKeys(e)) cells.add(`${e.section_id}#${key}`)
    }
    return cells.size
  })(),
  breakRowsIgnored: R.timeSlots.filter((t) => t.is_break).length,
  entriesOnBreak: breakSlots.size,
}
R.blankAccounting.blankCells =
  R.blankAccounting.totalGridCells - R.blankAccounting.occupiedCells

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------
function pad(s, n) {
  s = String(s)
  return s.length >= n ? s.slice(0, n) : s + ' '.repeat(n - s.length)
}
function render() {
  const L = []
  const line = (s = '') => L.push(s)
  line('='.repeat(100))
  line('SUBSTIFLOW DEMO TIMETABLE AUDIT (read-only)')
  line(`database : ${R.database}`)
  line(`view     : ${R.view} entries (${R.view === 'published' ? R.publishedEntries.length : R.draftEntries.length})`)
  line(`capacity : ${R.weekCapacity.workingDays} working days x ${R.weekCapacity.teachingSlots} teaching periods = ${R.weekCapacity.occupiedPeriodsPerSection} occupied periods/section`)
  line(`config   : ${R.workingDays} ${R.workingHours.start}-${R.workingHours.end}, break ${R.workingHours.breakStart}-${R.workingHours.breakEnd}`)
  line('='.repeat(100))
  line()
  line('--- SECTION COVERAGE (sessions vs occupied periods) ---')
  line(pad('Section', 12) + pad('Req sess', 9) + pad('Sch sess', 9) + pad('Missing', 9) + pad('Req occ', 9) + pad('Sch occ', 9) + pad('Empty', 8))
  for (const c of R.viewCoverage) {
    line(
      pad(c.section, 12) + pad(c.requiredSessions, 9) + pad(c.scheduledSessions, 9) +
      pad(c.missingSessions, 9) + pad(c.requiredPeriods, 9) + pad(c.occupiedPeriods, 9) + pad(c.emptyPeriods, 8)
    )
    if (c.missingDetail.length) line('           missing: ' + c.missingDetail.join('; '))
  }
  line()
  line('--- SUBJECT REQUIREMENT COVERAGE (one row per section/subject requirement) ---')
  line('section | subject (code) | type | req sessions | req occupied periods | eligible faculty | arrangement | span | scheduled sessions | scheduled occupied periods | missing (sessions; occupied periods)')
  for (const r of R.requirementCoverage) {
    line(`${r.section} | ${r.subject} (${r.code}) | ${r.classType} | ${r.requiredSessions} | ${r.requiredOccupiedPeriods} | ${r.eligibleFaculty.join(', ') || '-'} | ${r.arrangement} | ${r.span} | ${r.scheduledSessions} | ${r.scheduledOccupiedPeriods} | ${r.missing} sessions; ${r.missingOccupiedPeriods} occupied periods`)
  }
  line()
  line('--- SESSIONS PER DAY BY SECTION ---')
  for (const s of R.sessionsPerDaySection) {
    line(pad(s.section, 12) + DAY_ORDER.map((d) => pad(d.slice(0, 3), 6)).join(''))
    line(pad('', 12) + DAY_ORDER.map((d) => pad(s.byDay[d], 6)).join(''))
  }
  line()
  line('--- SESSIONS PER PERIOD (all sections) ---')
  for (const p of R.sessionsPerPeriod) line(pad(p.period, 14) + (p.isBreak ? '(break) ' : '        ') + p.sessions)
  line()
  line('--- SESSIONS PER DAY (all sections) ---')
  for (const d of R.sessionsPerDay) line(pad(d.day, 12) + d.sessions)
  line()
  line('--- FACULTY WORKLOAD (week / by day) ---')
  for (const f of R.facultyWorkload) {
    if (f.staffType !== 'TEACHING') { line(pad(f.faculty, 18) + 'NON-TEACHING  week=' + f.week); continue }
    line(pad(f.faculty, 18) + 'week=' + pad(f.week, 4) + DAY_ORDER.map((d) => pad(f.byDay[d], 4)).join(''))
  }
  line()
  line('--- ROOMS ---')
  for (const r of R.roomUtilisation) line(pad(r.room, 16) + pad(r.type, 12) + 'used=' + r.usedBy)
  line(`lab entries missing a lab room : ${R.labEntriesMissingRoom.length}`)
  line(`entries with wrong-type room   : ${R.entriesWithInvalidRoom.length}`)
  line(`lecture entries with a room    : ${R.lectureEntriesWithRoom}`)
  line(`lecture entries without a room : ${R.lectureEntriesWithoutRoom}  (allowed: lectures are room-independent in this app)`)
  line(`entries without faculty        : draft=${R.entryFacultyCounts.draftEntriesWithoutFaculty} published=${R.entryFacultyCounts.publishedEntriesWithoutFaculty}`)
  line()
  line('--- BLANK ACCOUNTING ---')
  line(`grid cells (days x slots x sections): ${R.blankAccounting.totalGridCells}`)
  line(`occupied cells (distinct section/period): ${R.blankAccounting.occupiedCells}`)
  line(`blank cells                         : ${R.blankAccounting.blankCells}`)
  line(`break slots per day (excluded)      : ${R.blankAccounting.breakRowsIgnored}`)
  line(`entries placed on break slots       : ${R.blankAccounting.entriesOnBreak}`)
  line()
  line('--- CONSISTENCY ---')
  line(`requirements without allocation    : ${R.requirementsWithoutAllocation.length}`)
  line(`allocations without requirement    : ${R.allocationsWithoutRequirement.length}`)
  line(`non-teaching allocations           : ${R.nonTeachingAllocations.length}`)
  line(`subjects w/o qualified faculty     : ${R.subjectsWithoutQualifiedFaculty.length}`)
  line(`duplicate requirements/allocations : ${R.duplicates.requirements.length} / ${R.duplicates.allocations.length}`)
  line(`over-capacity sections             : ${R.demandVsCapacity.filter((d) => d.overCapacity).length}`)
  R.demandVsCapacity.forEach((d) => line(`   ${pad(d.section, 12)} demand ${d.occupiedPeriods} occupied periods / capacity ${d.capacityOccupiedPeriods}${d.overCapacity ? '  OVER CAPACITY' : ''}`))
  line(`weekly faculty allocation load     : ${R.teachingAllocationWorkload.map((w) => `${w.faculty}=${w.sessionsPerWeek}`).join(', ')}`)
  line()
  line('--- GENERATION ---')
  line(`generations: ${R.generations.length}`)
  for (const g of R.generations) line(`   ${g.id} status=${g.status} at ${g.created_at}`)
  line(`diagnostics: ${R.diagnostics.length}`)
  for (const d of R.diagnostics.slice(0, 20)) line(`   [${d.severity}] ${d.code}: ${d.message}`)
  line()
  line('--- HARD-CONSTRAINT VIOLATIONS ---')
  line(`faculty conflicts: ${R.violations.faculty.length}`)
  R.violations.faculty.slice(0, 10).forEach((v) => line(`   ${v.key} slot ${v.slot}: ${v.entries}`))
  line(`section conflicts: ${R.violations.section.length}`)
  R.violations.section.slice(0, 10).forEach((v) => line(`   ${v.key} slot ${v.slot}: ${v.entries}`))
  line(`room conflicts   : ${R.violations.room.length}`)
  R.violations.room.slice(0, 10).forEach((v) => line(`   ${v.key} slot ${v.slot}: ${v.entries}`))
  line(`TOTAL VIOLATIONS : ${R.violationCount}`)
  line()
  line('--- ENTRIES (view) ---')
  for (const sec of R.sections) {
    const mine = viewEntries.filter((e) => e.section_id === sec.id)
      .sort((a, b) => DAY_ORDER.indexOf(a.day_of_week) - DAY_ORDER.indexOf(b.day_of_week) || a.slot_order - b.slot_order)
    line(`[${sec.name}] ${mine.length} entries`)
    for (const e of mine) {
      const fac = (viewFac[e.id] || []).map((f) => f.name).join('+') || 'NO FACULTY'
      const rm = (viewRooms[e.id] || []).map((r) => r.name).join('+') || '-'
      line(`   ${pad(e.day_of_week.slice(0, 3), 4)} ${pad(e.subject, 10)} ${pad(e.class_type, 8)} span=${e.span} ${pad(fac, 30)} room=${rm}`)
    }
  }
  return L.join('\n')
}

const report = render()
if (asJson) {
  const json = JSON.stringify(R, null, 2)
  if (outFile) fs.writeFileSync(outFile, json)
  else console.log(json)
} else {
  if (outFile) fs.writeFileSync(outFile, report)
  console.log(report)
}
db.close()
