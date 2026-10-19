/**
 * Demo maintenance tasks — always run through npm so the ABI, the build and
 * the isolation guards are guaranteed:
 *
 *   npm run demo:setup    (re)create the isolated demo database + fixture
 *   npm run demo:reset    alias of setup (wipes only the demo directory)
 *   npm run demo:status   print resolved paths + seeded counts (read-only)
 *   npm run demo:remove   close-guarded removal of ONLY the demo directory
 *
 * Safety model (mirrors scripts/cli.js, but pinned to the demo directory):
 *   - SUBSTIFLOW_DATA_DIR is FORCED to the canonical `.substiflow-demo/`
 *     directory inside the repository; an ambient value pointing elsewhere is
 *     ignored with a loud warning — there is no fallback to the production
 *     profile.
 *   - Every mutating task runs assertSafeDemoPaths / assertRemovableDemoDir
 *     (refuses non-canonical paths, symlinks, unmarked directories and
 *     anything inside the production data directory) BEFORE touching disk.
 *   - Mutating tasks take the same per-data-directory single-instance lock as
 *     the app, so they refuse to run while the demo app is open. Only the
 *     `.substiflow-demo/` directory is ever deleted — never anything else.
 */
const path = require('path')
const fs = require('fs')
const { app } = require('electron')

const ROOT = path.resolve(__dirname, '..', '..')
const DIST_DEMO_PATHS = path.join(ROOT, 'dist', 'main', 'src', 'db', 'demoPaths')
const DIST_DEMO_FIXTURE = path.join(ROOT, 'dist', 'main', 'src', 'db', 'demoFixture')

if (!fs.existsSync(`${DIST_DEMO_PATHS}.js`)) {
  process.stderr.write(
    'demo: compiled demo modules are missing. Run this through npm (npm run demo:setup) so the build step runs first.\n'
  )
  app.exit(1)
  throw new Error('demo modules not built') // keeps synchronous control flow honest
}

const {
  resolveDemoPaths,
  assertSafeDemoPaths,
  assertRemovableDemoDir,
  writeDemoMarker,
  DEMO_MARKER_FILE,
} = require(DIST_DEMO_PATHS)
const { applyDemoSchema, DEMO_EXPECTED_COUNTS } = require(DIST_DEMO_FIXTURE)
const Database = require('better-sqlite3')

const paths = resolveDemoPaths(ROOT)
const task = process.argv[2]

// The demo tooling never inherits a data directory from the shell: whatever
// SUBSTIFLOW_DATA_DIR says, the demo works on the demo directory only.
if (process.env.SUBSTIFLOW_DATA_DIR) {
  const ambient = path.resolve(process.env.SUBSTIFLOW_DATA_DIR)
  if (ambient !== paths.demoDir) {
    console.warn(
      `demo: ignoring ambient SUBSTIFLOW_DATA_DIR=${ambient} — the demo uses ${paths.demoDir} exclusively.`
    )
  }
}
process.env.SUBSTIFLOW_DATA_DIR = paths.demoDir

// Same profile name as the app so the single-instance lock is scoped to this
// data directory exactly like the app's own lock.
app.setName('SubstiFlow')
app.setPath('userData', paths.demoDir)

assertSafeDemoPaths(paths)

// Claim the directory for the demo tooling BEFORE Electron creates its
// profile inside it (`app.setPath('userData', …)` would otherwise leave an
// unmarked directory behind that later resets refuse to touch). A marker is
// written only when the directory is absent or empty; a non-empty unmarked
// directory was not created by the demo tooling and is never deleted here.
if (!fs.existsSync(paths.markerPath)) {
  if (fs.existsSync(paths.demoDir) && fs.readdirSync(paths.demoDir).length > 0) {
    process.stderr.write(
      [
        `Refusing: ${paths.demoDir} exists but was not created by the demo tooling (no ${DEMO_MARKER_FILE} marker).`,
        'If this is a leftover you are sure about, delete it manually and re-run:',
        `  rm -rf '${paths.demoDir}'`,
      ].join('\n') + '\n'
    )
    app.exit(1)
    throw new Error('unmarked demo directory')
  }
  fs.mkdirSync(paths.demoDir, { recursive: true, mode: 0o700 })
  writeDemoMarker(paths, { note: 'claimed by the demo CLI before first setup' })
}

const MUTATING = new Set(['setup', 'reset', 'remove'])
if (!task) {
  process.stderr.write('usage: electron scripts/demo/cli.js <setup|reset|status|remove>\n')
  app.exit(1)
} else if (MUTATING.has(task) && !app.requestSingleInstanceLock()) {
  process.stderr.write(
    [
      `demo: the demo app (or another demo task) is using ${paths.demoDir}.`,
      'Close the demo app first, then re-run this command.',
    ].join('\n') + '\n'
  )
  app.exit(1)
}

function fail(err) {
  process.stderr.write(`${err && err.stack ? err.stack : err}\n`)
  app.exit(1)
}

function removeDemoDir() {
  assertRemovableDemoDir(paths)
  fs.rmSync(paths.demoDir, { recursive: true, force: true })
}

// Set only after removeDemoDir() has validated the marker and deleted the
// directory in THIS process — the late cleanup passes below delete only what
// the Electron runtime recreated during startup/shutdown (profile and lock
// files), never a directory that failed validation.
let removalValidated = false
function sweepValidatedRemoval() {
  if (!removalValidated) return
  try {
    if (fs.existsSync(paths.demoDir)) fs.rmSync(paths.demoDir, { recursive: true, force: true })
  } catch {
    /* best-effort: ownership of this directory was already validated */
  }
}
app.on('quit', sweepValidatedRemoval)
// Electron's profile teardown can recreate an empty shell after 'quit' —
// this node-level exit hook is the last code that runs, so repeat there too.
process.on('exit', sweepValidatedRemoval)

function setup() {
  if (fs.existsSync(paths.demoDir)) {
    console.log(`demo: resetting existing demo directory ${paths.demoDir}`)
    removeDemoDir()
  }
  fs.mkdirSync(path.dirname(paths.dbPath), { recursive: true, mode: 0o700 })

  const db = new Database(paths.dbPath)
  try {
    db.pragma('foreign_keys = ON')
    applyDemoSchema(db)
    const counts = buildFixture(db)
    writeDemoMarker(paths, { schema_version: 8, counts })
    return counts
  } finally {
    db.close()
  }
}

function buildFixture(db) {
  // Required here (not at top level) so schema application happens first.
  const { buildDemoFixture } = require(DIST_DEMO_FIXTURE)
  const isConflict = process.argv.includes('--variant=conflict') || process.env.SUBSTIFLOW_DEMO_VARIANT === 'conflict'
  return buildDemoFixture(db, { variant: isConflict ? 'conflict' : 'balanced' })
}

function printCounts(counts) {
  const rows = Object.keys(DEMO_EXPECTED_COUNTS)
  for (const key of rows) {
    const expected = DEMO_EXPECTED_COUNTS[key]
    const actual = counts ? counts[key] : undefined
    const flag = counts && actual !== expected ? `  <-- MISMATCH (expected ${expected})` : ''
    console.log(`    ${key.padEnd(22)}${String(actual ?? '-').padStart(4)}${flag}`)
  }
}

function status() {
  console.log('SubstiFlow demo environment')
  console.log(`  demo data dir : ${paths.demoDir}`)
  console.log(`  demo database : ${paths.dbPath}`)
  console.log(`  marker file   : ${paths.markerPath}`)
  console.log(`  dir exists    : ${fs.existsSync(paths.demoDir) ? 'yes' : 'no — run npm run demo:setup'}`)
  console.log(`  marker exists : ${fs.existsSync(paths.markerPath) ? 'yes' : 'no'}`)
  if (!fs.existsSync(paths.dbPath)) {
    console.log('  The demo database has not been created yet (npm run demo:setup).')
    return 1
  }
  const db = new Database(paths.dbPath, { readonly: true })
  try {
    const count = (t) => db.prepare(`SELECT COUNT(*) AS c FROM ${t}`).get().c
    const counts = {
      academicYears: count('academic_years'),
      departments: count('departments'),
      sections: count('sections'),
      subjects: count('subjects'),
      faculty: count('faculty'),
      teachingFaculty: db.prepare(`SELECT COUNT(*) AS c FROM faculty WHERE staff_type = 'TEACHING'`).get().c,
      nonTeachingFaculty: db.prepare(`SELECT COUNT(*) AS c FROM faculty WHERE staff_type = 'NON_TEACHING'`).get().c,
      rooms: count('rooms'),
      classrooms: db.prepare(`SELECT COUNT(*) AS c FROM rooms WHERE type = 'CLASSROOM'`).get().c,
      labs: db.prepare(`SELECT COUNT(*) AS c FROM rooms WHERE type = 'LAB'`).get().c,
      timeSlots: count('time_slots'),
      settings: count('application_settings'),
      requirements: count('subject_requirements'),
      allocations: count('teaching_allocations'),
      qualifications: count('faculty_subjects'),
      sectionAssignments: count('faculty_sections'),
    }
    const schema = db.prepare('SELECT MAX(version) AS v FROM schema_version').get()
    console.log(`  schema version: ${schema && schema.v != null ? schema.v : 'unknown'}`)
    console.log('  seeded records:')
    printCounts(counts)
    const mismatch = Object.keys(DEMO_EXPECTED_COUNTS).some(
      (k) => DEMO_EXPECTED_COUNTS[k] !== counts[k]
    )
    console.log(`  fixture matches expected counts: ${mismatch ? 'NO' : 'yes'}`)
    console.log(`  published timetable entries     : ${count('timetable_entries')}`)
    console.log(`  generation runs                 : ${count('timetable_generations')}`)
    console.log(`  substitution runs               : ${count('substitution_runs')}`)
    console.log(`  attendance rows                 : ${count('attendance')}`)
    return mismatch ? 1 : 0
  } finally {
    db.close()
  }
}

app.whenReady().then(() => {
  try {
    if (task === 'setup' || task === 'reset') {
      console.log(`DEMO DATA — building the isolated demo database`)
      console.log(`  resolved demo database path: ${paths.dbPath}`)
      const counts = setup()
      console.log('  seeded records:')
      printCounts(counts)
      console.log(`demo: ready. Launch with: npm run demo:launch`)
      app.quit()
    } else if (task === 'status') {
      const code = status()
      app.exit(code)
    } else if (task === 'remove') {
      removeDemoDir()
      removalValidated = true
      console.log(`demo: removed ${paths.demoDir} (only the demo directory is ever deleted).`)
      app.quit()
    } else {
      process.stderr.write(`demo: unknown task "${task}".\n`)
      app.exit(1)
    }
  } catch (err) {
    fail(err)
  }
})
