/**
 * SubstiFlow sample data seeder (BCA demo dataset).
 * Run with: npm run db:seed
 *
 * Uses the same storage location as the app, or SUBSTIFLOW_DATA_DIR when set.
 */
const path = require('path')
const os = require('os')
const fs = require('fs')
const crypto = require('crypto')
const Database = require('better-sqlite3')

function defaultDataDir() {
  const home = os.homedir()
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'substiflow')
  }
  if (process.platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', 'substiflow')
  }
  return path.join(process.env.XDG_DATA_HOME || path.join(home, '.local', 'share'), 'substiflow')
}

const dataDir = process.env.SUBSTIFLOW_DATA_DIR || defaultDataDir()
const dbDir = path.join(dataDir, 'database')
fs.mkdirSync(dbDir, { recursive: true })
const dbPath = path.join(dbDir, 'substiflow.db')

const schema = fs.readFileSync(path.join(__dirname, '..', 'src', 'db', 'schema.sql'), 'utf-8')

const db = new Database(dbPath)
db.pragma('journal_mode = WAL')
db.pragma('foreign_keys = ON')

console.log('Seeding database at:', dbPath)

// Make sure the schema exists (idempotent).
if (
  !db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='schema_version'`)
    .get()
) {
  db.exec(`CREATE TABLE schema_version (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (datetime('now')))`)
  db.exec(schema)
  db.prepare('INSERT INTO schema_version (version) VALUES (1)').run()
}

// --- Departments ------------------------------------------------------------
const deptBCA = { id: 'dept-bca', name: 'BCA', code: 'BCA' }
const deptMCA = { id: 'dept-mca', name: 'MCA', code: 'MCA' }
const insertDept = db.prepare(
  'INSERT OR IGNORE INTO departments (id, name, code) VALUES (?, ?, ?)'
)
insertDept.run(deptBCA.id, deptBCA.name, deptBCA.code)
insertDept.run(deptMCA.id, deptMCA.name, deptMCA.code)

// --- Academic year ----------------------------------------------------------
const yearId = 'year-2024-2025'
// Only seed an active year when the database has none: never de-activate or
// compete with a year the coordinator already configured.
db.prepare(
  `INSERT OR IGNORE INTO academic_years (id, name, start_date, end_date, is_active)
   SELECT ?, ?, ?, ?, 1
   WHERE NOT EXISTS (SELECT 1 FROM academic_years WHERE is_active = 1)`
).run(yearId, '2024-2025', '2024-06-01', '2025-05-31')

// --- Time slots (09:00-16:00, break 13:00-14:00) ----------------------------
const slots = [
  ['slot-1', '09:00-10:00', '09:00', '10:00', 1, 0],
  ['slot-2', '10:00-11:00', '10:00', '11:00', 2, 0],
  ['slot-3', '11:00-12:00', '11:00', '12:00', 3, 0],
  ['slot-4', '12:00-13:00', '12:00', '13:00', 4, 0],
  ['break', '13:00-14:00', '13:00', '14:00', 5, 1],
  ['slot-5', '14:00-15:00', '14:00', '15:00', 6, 0],
  ['slot-6', '15:00-16:00', '15:00', '16:00', 7, 0],
]
const insertSlot = db.prepare(
  'INSERT OR IGNORE INTO time_slots (id, name, start_time, end_time, "order", is_break) VALUES (?, ?, ?, ?, ?, ?)'
)
for (const s of slots) insertSlot.run(...s)

// --- Faculty ----------------------------------------------------------------
const faculty = [
  ['fac-ranjini', 'Mrs. Ranjini', 'EMP001'],
  ['fac-keerthi', 'Mrs. Keerthi', 'EMP002'],
  ['fac-usha', 'Mrs. Usha', 'EMP003'],
  ['fac-kohila', 'Mrs. Kohila', 'EMP004'],
  ['fac-kunkumashri', 'Mrs. Kunkumashri', 'EMP005'],
  ['fac-geetha', 'Dr. Geetha Lakshmi', 'EMP006'],
  ['fac-sheethal', 'Mr. Sheethal', 'EMP007'],
]
const insertFaculty = db.prepare(
  'INSERT OR IGNORE INTO faculty (id, name, employee_id, department_id, is_active, max_daily_substitutions, priority) VALUES (?, ?, ?, ?, 1, 2, 0)'
)
for (const [id, name, employeeId] of faculty) {
  insertFaculty.run(id, name, employeeId, deptBCA.id)
}

// --- Subjects ---------------------------------------------------------------
const subjects = [
  ['sub-ai', 'Artificial Intelligence', 'BCA-301', 'LECTURE'],
  ['sub-ps', 'Probability & Statistics', 'BCA-302', 'LECTURE'],
  ['sub-dbms', 'Database Management System', 'BCA-303', 'LECTURE'],
  ['sub-english', 'General English', 'BCA-101', 'LECTURE'],
  ['sub-constitution', 'Indian Constitution', 'BCA-102', 'LECTURE'],
  ['sub-ailab', 'AI Lab', 'BCA-301L', 'LAB'],
  ['sub-dbmsslab', 'DBMS Lab', 'BCA-303L', 'LAB'],
  ['sub-web', 'Feature Engineering / Web Programming', 'BCA-304', 'LECTURE'],
]
const insertSubject = db.prepare(
  'INSERT OR IGNORE INTO subjects (id, name, code, department_id, default_class_type) VALUES (?, ?, ?, ?, ?)'
)
for (const [id, name, code, type] of subjects) {
  insertSubject.run(id, name, code, deptBCA.id, type)
}

// --- Sections ---------------------------------------------------------------
const sections = [
  ['sec-i-bca-a', 'I BCA-A', 1],
  ['sec-i-bca-b', 'I BCA-B', 1],
  ['sec-ii-bca-a', 'II BCA-A', 3],
  ['sec-ii-bca-b', 'II BCA-B', 3],
  ['sec-iii-bca-a', 'III BCA-A', 5],
  ['sec-iii-bca-b', 'III BCA-B', 5],
]
const insertSection = db.prepare(
  'INSERT OR IGNORE INTO sections (id, name, semester, department_id, academic_year_id) VALUES (?, ?, ?, ?, ?)'
)
for (const [id, name, semester] of sections) {
  insertSection.run(id, name, semester, deptBCA.id, yearId)
}

// --- Rooms ------------------------------------------------------------------
const rooms = [
  ['room-208', 'Room 208', 60, 'CLASSROOM'],
  ['room-209', 'Room 209', 60, 'CLASSROOM'],
  ['room-210', 'Room 210', 60, 'CLASSROOM'],
  ['room-lab1', 'Lab 1', 40, 'LAB'],
]
const insertRoom = db.prepare('INSERT OR IGNORE INTO rooms (id, name, capacity, type) VALUES (?, ?, ?, ?)')
for (const r of rooms) insertRoom.run(...r)

// --- Qualifications ---------------------------------------------------------
const facultySubjects = [
  ['fac-ranjini', 'sub-ps', 5],
  ['fac-ranjini', 'sub-dbms', 4],
  ['fac-usha', 'sub-english', 5],
  ['fac-kohila', 'sub-dbms', 5],
  ['fac-geetha', 'sub-ai', 5],
  ['fac-sheethal', 'sub-ai', 4],
  ['fac-sheethal', 'sub-web', 4],
  ['fac-keerthi', 'sub-constitution', 5],
  ['fac-keerthi', 'sub-english', 4],
  ['fac-kunkumashri', 'sub-english', 5],
]
const insertFS = db.prepare(
  'INSERT OR IGNORE INTO faculty_subjects (faculty_id, subject_id, proficiency) VALUES (?, ?, ?)'
)
for (const row of facultySubjects) insertFS.run(...row)

// --- Normal section assignments --------------------------------------------
const facultySections = [
  ['fac-usha', 'sec-iii-bca-b'],
  ['fac-ranjini', 'sec-iii-bca-b'],
  ['fac-ranjini', 'sec-iii-bca-a'],
  ['fac-kohila', 'sec-iii-bca-b'],
  ['fac-kohila', 'sec-iii-bca-a'],
  ['fac-geetha', 'sec-iii-bca-b'],
  ['fac-keerthi', 'sec-i-bca-a'],
  ['fac-kunkumashri', 'sec-ii-bca-a'],
  ['fac-sheethal', 'sec-ii-bca-a'],
]
const insertFSec = db.prepare(
  'INSERT OR IGNORE INTO faculty_sections (faculty_id, section_id) VALUES (?, ?)'
)
for (const row of facultySections) insertFSec.run(...row)

// --- Master timetable (Wednesday sample) ------------------------------------
const timetableEntries = [
  // slot-1 09:00-10:00
  ['tt-wed-1', 'slot-1', 'sec-iii-bca-b', 'sub-ai', 'fac-geetha', 'room-208'],
  ['tt-wed-2', 'slot-1', 'sec-iii-bca-a', 'sub-web', 'fac-sheethal', 'room-209'],
  ['tt-wed-3', 'slot-1', 'sec-i-bca-a', 'sub-constitution', 'fac-keerthi', 'room-210'],
  ['tt-wed-4', 'slot-1', 'sec-ii-bca-a', 'sub-english', 'fac-kunkumashri', 'room-lab1'],
  // slot-2 10:00-11:00
  ['tt-wed-5', 'slot-2', 'sec-iii-bca-b', 'sub-dbms', 'fac-kohila', 'room-208'],
  ['tt-wed-6', 'slot-2', 'sec-iii-bca-a', 'sub-ps', 'fac-ranjini', 'room-209'],
  ['tt-wed-7', 'slot-2', 'sec-i-bca-a', 'sub-english', 'fac-usha', 'room-210'],
  ['tt-wed-8', 'slot-2', 'sec-ii-bca-a', 'sub-ai', 'fac-sheethal', 'room-lab1'],
  // slot-3 11:00-12:00
  ['tt-wed-9', 'slot-3', 'sec-iii-bca-b', 'sub-english', 'fac-usha', 'room-208'],
  ['tt-wed-10', 'slot-3', 'sec-iii-bca-a', 'sub-dbms', 'fac-kohila', 'room-209'],
  ['tt-wed-11', 'slot-3', 'sec-i-bca-a', 'sub-constitution', 'fac-keerthi', 'room-210'],
  ['tt-wed-12', 'slot-3', 'sec-ii-bca-a', 'sub-english', 'fac-kunkumashri', 'room-lab1'],
  // slot-4 12:00-13:00
  ['tt-wed-13', 'slot-4', 'sec-iii-bca-b', 'sub-ps', 'fac-ranjini', 'room-208'],
  ['tt-wed-14', 'slot-4', 'sec-iii-bca-a', 'sub-ai', 'fac-geetha', 'room-209'],
  ['tt-wed-15', 'slot-4', 'sec-i-bca-a', 'sub-english', 'fac-kunkumashri', 'room-210'],
  ['tt-wed-16', 'slot-4', 'sec-ii-bca-a', 'sub-web', 'fac-sheethal', 'room-lab1'],
  // slot-6 15:00-16:00
  ['tt-wed-17', 'slot-6', 'sec-iii-bca-b', 'sub-english', 'fac-usha', 'room-208'],
]
const insertTT = db.prepare(
  'INSERT OR IGNORE INTO timetable_entries (id, academic_year_id, day_of_week, time_slot_id, section_id, subject_id, faculty_id, room_id, class_type) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
)
for (const [id, slot, section, subject, fac, room] of timetableEntries) {
  const type = subject.includes('lab') ? 'LAB' : 'LECTURE'
  insertTT.run(id, yearId, 'WEDNESDAY', slot, section, subject, fac, room, type)
}

// --- Application settings ---------------------------------------------------
const settings = [
  ['setup_complete', 'true', 'First-run setup completion flag'],
  ['institution_name', 'Sample BCA College', 'Institution name'],
  ['institution_address', '123 College Road, City', 'Institution address'],
  ['working_hours_start', '09:00', 'Working hours start'],
  ['working_hours_end', '16:00', 'Working hours end'],
  ['break_start', '13:00', 'Break start'],
  ['break_end', '14:00', 'Break end'],
  ['max_daily_substitutions', '2', 'Max daily substitutions per faculty'],
]
const insertSetting = db.prepare(
  // OR IGNORE: settings already configured by the user (institution name,
  // weights, limits, setup flag) are never overwritten by seeding.
  `INSERT OR IGNORE INTO application_settings (id, key, value, description, created_at, updated_at) VALUES (?, ?, ?, ?, datetime('now'), datetime('now'))`
)
for (const [key, value, description] of settings) {
  insertSetting.run(crypto.randomUUID(), key, value, description)
}

console.log('')
console.log('Sample data seeded successfully!')
console.log(`  - ${faculty.length} faculty members`)
console.log(`  - ${subjects.length} subjects`)
console.log(`  - ${sections.length} sections`)
console.log(`  - ${rooms.length} rooms`)
console.log(`  - ${timetableEntries.length} timetable entries (Wednesday sample)`)
console.log('')
console.log('Try it: mark Mrs. Ranjini absent on Wednesday and generate the plan.')
console.log('Expected substitute for III BCA-B 12:00-13:00 P&S: Mrs. Usha.')

db.close()
