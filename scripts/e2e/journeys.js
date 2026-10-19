#!/usr/bin/env node
/**
 * End-to-end journeys that drive the REAL packaged SubstiFlow app (Electron +
 * renderer + SQLite) — no mocks, no dev server, no fixture of production data.
 *
 * Journeys:
 *   A. First-run setup wizard → Subject Requirements + Teaching Allocations
 *      (real CRUD) → Generate (real solver) → review draft grid → Validate
 *      → Publish → Master Timetable shows the entries.
 *   F. Manual-testing fixes: Add Subject shows an honest empty department
 *      select (no phantom selection) and persists what it claims; a
 *      non-teaching staff member is created through the Faculty page and is
 *      never offered in Teaching Allocations nor chosen as a substitute;
 *      a teaching-team requirement is configured end to end and the solver
 *      puts every allocated teacher on every session (validated); teaching
 *      allocation edit and delete work through the real UI (native confirm
 *      accepted, then the row is re-created for later journeys).
 *   B. Impossible requirement (40 periods into 36 available) → FAILED run with
 *      administrator-readable diagnostics; the published timetable is untouched.
 *   C. Attendance absence → Substitution Planner generates and approves a plan;
 *      approving AGAIN while classes are still uncovered is only possible
 *      through a confirmation that names the uncovered count.
 *   H. Windows smoke-checklist arrangements: an explicitly configured
 *      multi-teacher TEAM lab and an ALTERNATE requirement sharing one
 *      subject, placed by the real solver, independently validated, and
 *      published — the master timetable carries the span-2 TEAM lab with
 *      both teachers.
 *   D. Relaunch → automatic daily backup snapshot exists; Backup page renders.
 *   E. Every sidebar page renders without hitting the error boundary.
 *   G1. Legacy audit rows with a NULL id (written by an old build) render in
 *       the Dashboard's Recent Activity; the schema stamp is then rewound to
 *       simulate a pre-v7 database.
 *   G2. Relaunch → migration 7 backfills every NULL audit id (unique keys),
 *       nothing is lost, and the Dashboard still renders the same rows.
 *
 * Offline check: every page load is watched; any http(s) request that is not
 * pointed at a local development server fails the run — core functionality
 * must not need an internet connection.
 *
 * Data safety: the app runs with SUBSTIFLOW_DATA_DIR pointing at a fresh
 * directory under the OS temp dir, so an isolated QA database is created and
 * the production database is never opened. SQL assertions go through the app's
 * own IPC bridge (`window.electron.db`), i.e. exactly the data path the app
 * uses.
 *
 * Usage:
 *   npm run build && node scripts/e2e/journeys.js      (or: npm run e2e)
 *
 * The `playwright` package must be present in node_modules (it is used
 * optionally; the Vitest suite in `npm test` never depends on it). Native
 * save/open dialogs (backup export/import) cannot be automated through
 * Playwright and are covered by unit tests instead (backupValidation.test.ts).
 */

const path = require('path')
const fs = require('fs')
const os = require('os')
const { execSync, spawnSync } = require('child_process')
const { _electron } = require('playwright')

const ROOT = path.resolve(__dirname, '..', '..')
const QA_ROOT = path.join(os.tmpdir(), `substiflow-e2e-${Date.now()}`)
const DATA_DIR = path.join(QA_ROOT, 'data')
const SHOTS = path.join(QA_ROOT, 'screenshots')

/** Live references, rebound whenever the app is (re)launched. */
let app = null
let page = null

let checks = 0
const failures = []
const pageErrors = []
/** Any http(s) request the app made that was not aimed at localhost. */
const externalRequests = []

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function pass(msg) {
  checks += 1
  console.log(`  [PASS] ${msg}`)
}

function fail(msg, detail) {
  failures.push(detail ? `${msg} — ${detail}` : msg)
  console.error(`  [FAIL] ${msg}${detail ? ` — ${detail}` : ''}`)
}

async function check(condition, msg, detail) {
  if (condition) pass(msg)
  else fail(msg, detail)
}

/** Run a shell command, tolerating "nothing matched" exits (e.g. pkill). */
function sh(cmd) {
  try {
    execSync(cmd, { cwd: ROOT, stdio: ['ignore', 'inherit', 'inherit'] })
    return true
  } catch (e) {
    return false
  }
}

/**
 * Kill stale Electron processes started from THIS checkout — never other
 * applications on the machine. `pkill` does not exist on Windows, so the
 * win32 path asks PowerShell for processes whose executable lives under this
 * checkout's electron dist folder and stops only those (argv-array spawn, so
 * cmd.exe quoting rules never come into play).
 */
function killStaleElectron() {
  if (process.platform === 'win32') {
    const like = `${ROOT}\\node_modules\\electron\\dist\\*`.replace(/'/g, "''")
    const script =
      `Get-CimInstance Win32_Process -Filter "Name = 'electron.exe'" ` +
      `| Where-Object { $_.ExecutablePath -like '${like}' } ` +
      `| ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`
    try {
      const result = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
        stdio: 'ignore',
      })
      return result.status === 0
    } catch (e) {
      return false
    }
  }
  return sh(`pkill -f "${ROOT}/node_modules/electron/dist"`)
}

async function waitText(text, opts = {}) {
  await page
    .getByText(text, { exact: opts.exact === true })
    .first()
    .waitFor({ state: 'visible', timeout: opts.timeout || 15000 })
}

async function shot(name) {
  if (!page) return
  try {
    fs.mkdirSync(SHOTS, { recursive: true })
    const file = path.join(SHOTS, `${name}.png`)
    await page.screenshot({ path: file, fullPage: true })
    console.log(`  [shot] ${file}`)
  } catch (e) {
    /* screenshots are best-effort */
  }
}

/** Run SQL through the app's own preload bridge and return the rows. */
async function sql(statement, params = []) {
  return page.evaluate(
    ({ statement: stmt, params: args }) => {
      const result = window.electron.db.allSync(stmt, args)
      if (result && result.error) throw new Error(result.error)
      return result ? result.data : null
    },
    { statement, params }
  )
}

/** Execute a WRITE through the app's own preload bridge (db.runSync). */
async function execSql(statement, params = []) {
  return page.evaluate(
    ({ statement: stmt, params: args }) => {
      const result = window.electron.db.runSync(stmt, args)
      if (result && result.error) throw new Error(result.error)
      return result
    },
    { statement, params }
  )
}

/**
 * How the harness answers native alert()/confirm() dialogs: `dismiss` by
 * default (so a stray confirmation can never silently pass a journey), and
 * `accept` only inside `withAcceptedDialogs` — used around steps that MUST
 * confirm an intentional override (e.g. approving a plan with uncovered
 * classes, or deleting a teaching allocation).
 */
let dialogAnswer = 'dismiss'

async function withAcceptedDialogs(fn, settleMs = 500) {
  const previous = dialogAnswer
  dialogAnswer = 'accept'
  try {
    return await fn()
  } finally {
    await sleep(settleMs) // let any in-flight dialog finish before restoring
    dialogAnswer = previous
  }
}

function attachPageHandlers(target) {
  target.on('pageerror', (err) => {
    pageErrors.push(String(err))
    console.error('  [pageerror]', String(err))
  })
  // Surface renderer console errors (services log raw SQLite failures before
  // rethrowing friendly messages) — when a journey fails, the underlying
  // cause is printed next to it instead of only as UI text.
  target.on('console', (msg) => {
    if (msg.type() === 'error') console.log(`  [console.error] ${msg.text()}`)
  })
  // Offline-first: core functionality must never reach the internet. Flag any
  // http(s) request that is not aimed at a local development server.
  target.on('request', (req) => {
    const url = req.url()
    if (/^https?:/i.test(url) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/i.test(url)) {
      externalRequests.push(url)
      console.error(`  [offline-violation] ${url}`)
    }
  })
  // If an alert()/confirm() ever reaches Playwright, answer it according to
  // `dialogAnswer` (default: dismiss) so a native dialog can never silently
  // hang a journey — and never accidentally confirms anything.
  target.on('dialog', async (dialog) => {
    console.log(`  [js-dialog:${dialog.type()}] ${dialog.message()}`)
    try {
      if (dialogAnswer === 'accept') await dialog.accept()
      else await dialog.dismiss()
    } catch (e) {
      /* already gone */
    }
  })
}

async function launchApp() {
  const launched = await _electron.launch({
    args: ['.'],
    cwd: ROOT,
    executablePath: require('electron'),
    env: { ...process.env, NODE_ENV: 'production', SUBSTIFLOW_DATA_DIR: DATA_DIR },
  })
  const firstPage = await launched.firstWindow()
  await firstPage.waitForLoadState('domcontentloaded')
  attachPageHandlers(firstPage)
  return { launched, firstPage }
}

async function gotoSidebar(name) {
  await page.getByRole('link', { name, exact: true }).click()
  await page.waitForTimeout(400)
}

/** Assert the weekly counter in the "Allocations by Section & Subject" header. */
async function expectCounter(text, label) {
  const counter = page.getByTestId('weekly-session-counter')
  await counter.waitFor({ timeout: 5000 })
  const visible = (await counter.innerText().catch(() => '')).replace(/\s+/g, ' ')
  check(visible.includes(text), label, JSON.stringify(visible))
}

async function waitFor(predicate, timeoutMs, everyMs = 500) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return true
    await sleep(everyMs)
  }
  return false
}

const DAY_TO_JS = {
  SUNDAY: 0,
  MONDAY: 1,
  TUESDAY: 2,
  WEDNESDAY: 3,
  THURSDAY: 4,
  FRIDAY: 5,
  SATURDAY: 6,
}

function nextDateForWeekday(dayName) {
  const target = DAY_TO_JS[String(dayName).toUpperCase()]
  const d = new Date()
  d.setHours(12, 0, 0, 0)
  for (let i = 0; i < 8; i += 1) {
    if (d.getDay() === target) {
      const pad = (n) => String(n).padStart(2, '0')
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
    }
    d.setDate(d.getDate() + 1)
  }
  throw new Error(`cannot derive a date for ${dayName}`)
}

/* ------------------------------------------------------------------ *
 * Journey A — setup wizard → requirements/allocations → generate →
 * validate → publish → master timetable
 * ------------------------------------------------------------------ */
async function journeyA() {
  console.log('\n=== Journey A: first-run setup → generation → publish ===')

  // --- First-run wizard (creates institution/year/department/faculty/subject
  // ---/section/room through the real UI) ---
  await page.getByRole('button', { name: 'Next' }).waitFor()
  pass('first-run wizard shown on a fresh database')

  await page.getByRole('button', { name: 'Next' }).click() // welcome

  await page.getByLabel('Institution Name').fill('E2E QA College')
  await page.getByLabel('Address').fill('1 Test Lane')
  await page.getByRole('button', { name: 'Next' }).click()

  await page.getByLabel('Year Name').fill('2026-2027')
  await page.getByLabel('Start Date').fill('2026-06-01')
  await page.getByLabel('End Date').fill('2027-05-31')
  await page.getByRole('button', { name: 'Next' }).click()

  await page.getByLabel('Start Time').waitFor() // working-hours step
  await page.getByRole('button', { name: 'Next' }).click() // keep defaults

  await page.getByLabel('Department Name').fill('Computer Science')
  await page.getByLabel('Department Code').fill('BCA')
  await page.getByRole('button', { name: 'Next' }).click()

  await page.getByLabel('Faculty Name').fill('Dr. Asha')
  await page.getByRole('button', { name: 'Next' }).click()

  await page.getByLabel('Subject Name').fill('Computer Science')
  await page.getByLabel('Subject Code').fill('CS101')
  await page.getByRole('button', { name: 'Next' }).click()

  await page.getByLabel('Section Name').fill('III BCA-A')
  await page.getByLabel('Semester').fill('5')
  await page.getByRole('button', { name: 'Next' }).click()

  await page.getByLabel('Room Name').fill('Room 101')
  await page.getByRole('button', { name: 'Next' }).click()

  await page.getByRole('button', { name: 'Finish' }).click()
  await page
    .getByRole('link', { name: 'Timetable Generation', exact: true })
    .waitFor({ timeout: 20000 })
  pass('wizard completed; app layout rendered')

  // --- Second faculty via real CRUD (needed later for substitution cover) ---
  await gotoSidebar('Faculty')
  await page.getByRole('button', { name: 'Add Faculty' }).click()
  let dlg = page.getByRole('dialog')
  await dlg.waitFor()
  await dlg.getByLabel('Name').fill('Dr. Binu')
  // This select has no placeholder — the wizard-created department is the only
  // option, so select it by label rather than by index.
  await dlg.getByLabel('Department').selectOption({ label: 'Computer Science' })
  await dlg.getByRole('button', { name: 'Create' }).click()
  await dlg.waitFor({ state: 'detached' })
  await waitText('Dr. Binu')
  pass('second faculty created through the UI')

  // --- Subject Requirement: 2×/week, 1 period ---
  await gotoSidebar('Subject Requirements')
  await page.getByRole('button', { name: 'Add Requirement' }).click()
  dlg = page.getByRole('dialog')
  await dlg.waitFor()
  await dlg.locator('select').nth(0).selectOption({ index: 1 }) // section
  await dlg.locator('select').nth(1).selectOption({ index: 1 }) // subject
  await dlg.locator('select').nth(2).selectOption('LECTURE')
  await dlg.locator('input[type="number"]').nth(0).fill('2') // sessions/week
  await dlg.locator('input[type="number"]').nth(1).fill('1') // span
  await dlg.getByRole('button', { name: 'Create' }).click()
  await dlg.waitFor({ state: 'detached' })
  await waitText('2 / week')
  const reqRows = await sql('SELECT COUNT(*) AS c FROM subject_requirements')
  check(reqRows[0].c === 1, 'subject requirement saved (1 row)')
  pass('requirement visible in the table with weekly count and span')

  // --- Teaching Allocation: Dr. Asha covers the requirement ---
  await gotoSidebar('Teaching Allocations')
  await expectCounter('0 / 36', 'weekly counter starts at 0 / 36 with nothing allocated')
  await expectCounter('36 remaining', 'full weekly capacity remaining before the first allocation')
  await page.getByRole('button', { name: 'Add Allocation' }).click()
  dlg = page.getByRole('dialog')
  await dlg.waitFor()
  await dlg.locator('select').nth(0).selectOption({ index: 1 }) // faculty
  await dlg.locator('select').nth(1).selectOption({ index: 1 }) // section
  await dlg.locator('select').nth(2).selectOption({ index: 1 }) // subject
  await dlg.locator('select').nth(3).selectOption('LECTURE')
  await dlg.locator('input[type="number"]').nth(0).fill('2') // sessions/week
  await dlg.getByRole('button', { name: 'Create' }).click()
  await dlg.waitFor({ state: 'detached' })
  const allocRows = await sql('SELECT COUNT(*) AS c FROM teaching_allocations')
  check(allocRows[0].c === 1, 'teaching allocation saved (1 row)')
  pass('allocation visible in the table')
  await expectCounter('2 / 36', 'weekly counter follows the first allocation (2 sessions)')
  // Single-teacher row: a group ("delete all") button would duplicate the
  // teacher's own delete — exactly one trash must render.
  const soloDeletes = await page.locator('tbody tr').first().locator('button[title^="Delete"]').count()
  check(soloDeletes === 1, 'single-faculty row shows exactly ONE delete button', `${soloDeletes} delete button(s)`)

  // --- Real generation ---
  await gotoSidebar('Timetable Generation')
  await page.getByRole('button', { name: 'Generate Timetable' }).click()
  await waitText('Draft generated:', { timeout: 60000 })
  pass('real solver produced a draft (no mock data)')
  await waitText('COMPLETED') // run status badge
  pass('run status is COMPLETED')

  // --- Review the draft grid ---
  // Target the semantic tab rather than its text node. This avoids a
  // platform-dependent Playwright hit target when the tab label is nested in
  // the tablist alongside the active overview panel.
  await page.getByRole('tab', { name: 'Draft Grid', exact: true }).click({ force: true })
  const draftGrid = page.getByTestId('draft-grid-scroll')
  await draftGrid.waitFor({ state: 'visible', timeout: 15000 })
  // The deterministic solver may choose any configured working day; assert
  // the day header shape rather than assuming Monday is selected first on
  // every platform/runtime.
  const draftContentReady = await waitFor(async () => {
    const text = (await draftGrid.innerText()).replace(/\s+/g, ' ')
    return (
      /Monday|Tuesday|Wednesday|Thursday|Friday|Saturday/.test(text) &&
      /Dr\. Asha/.test(text) &&
      /Room 101/.test(text) &&
      /Lecture/i.test(text) &&
      /1 period/.test(text)
    )
  }, 15000, 250)
  if (!draftContentReady) {
    throw new Error(`draft grid content did not become ready: ${JSON.stringify((await draftGrid.innerText()).slice(0, 500))}`)
  }
  pass('draft grid shows day/subject/faculty/room/type/duration')

  // --- Independent validation ---
  await page.getByRole('button', { name: 'Validate Draft' }).click()
  await waitText('Validation passed')
  await waitText('Validation: passed')
  pass('independent validation pass succeeded')

  // --- Publish ---
  await page.getByRole('button', { name: 'Publish', exact: true }).click()
  await waitText('Publish this draft as the master timetable?')
  dlg = page.getByRole('dialog')
  await dlg.getByRole('button', { name: 'Publish', exact: true }).click()
  await waitText('session(s) to the master timetable', { timeout: 30000 })
  pass('publish confirmed and completed')

  const masterCount = (await sql('SELECT COUNT(*) AS c FROM timetable_entries'))[0].c
  check(masterCount >= 2, `master timetable has ${masterCount} published entries`)
  const draftStatuses = await sql('SELECT DISTINCT status FROM draft_timetable_entries')
  check(
    draftStatuses.length === 1 && draftStatuses[0].status === 'PUBLISHED',
    'draft rows marked PUBLISHED (history preserved, not deleted)'
  )
  const auditRows = await sql(
    "SELECT detail FROM audit_log WHERE action = 'timetable.updated'"
  )
  check(
    auditRows.length === 1 && /Published generation/.test(auditRows[0].detail),
    'publish wrote a timetable.updated audit entry'
  )

  // --- Master timetable page shows the published data ---
  await gotoSidebar('Master Timetable')
  await waitText('Master Timetable')
  // Entry cards carry the subject name in their title attribute; the filter
  // dropdowns also mention the subject but are not visible elements.
  await page.locator('div[title="Computer Science"]').first().waitFor({ timeout: 15000 })
  pass('master timetable page renders the published entries')
}

/* ------------------------------------------------------------------ *
 * Journey F — manual-testing fixes:
 *   1. Add Subject: the department select must never LOOK selected while
 *      the form state is empty (the reported bug: it showed the first
 *      department while Create insisted "Department is required").
 *   3. Staff type: a non-teaching person created through the real UI is
 *      never offered in Teaching Allocations nor chosen as a substitute.
 *   4/5. A teaching arrangement (TEAM) configured on the requirement makes
 *      the solver put EVERY allocated teacher on EVERY session, and the
 *      draft validates against it.
 *   6. Subject creation persists to the database (isolated QA database).
 * ------------------------------------------------------------------ */
async function journeyF() {
  console.log('\n=== Journey F: manual-testing fixes (subject select, staff type, TEAM) ===')

  // --- Issue 1: Add Subject — honest empty state on the department select ---
  await gotoSidebar('Subjects')
  await page.getByRole('button', { name: 'Add Subject' }).click()
  let dlg = page.getByRole('dialog')
  await dlg.waitFor()
  const deptState = await dlg.getByLabel('Department').evaluate((el) => ({
    value: el.value,
    shown: el.selectedOptions[0] ? el.selectedOptions[0].textContent : null,
  }))
  check(
    deptState.value === '' && deptState.shown === 'Select department',
    'department select shows an honest empty state before any choice',
    `shown: "${deptState.shown}", stored: "${deptState.value}"`
  )

  await dlg.getByLabel('Subject Name').fill('Software Engineering')
  await dlg.getByLabel('Code').fill('SE101')

  // Submitting with nothing chosen is refused — and the message matches what
  // the dropdown shows (nothing selected), so state and display can never lie.
  let alertMessage = null
  const onDialog = (d) => {
    alertMessage = d.message()
  }
  page.on('dialog', onDialog)
  await dlg.getByRole('button', { name: 'Create' }).click()
  await page.waitForTimeout(700)
  page.off('dialog', onDialog)
  check(
    alertMessage === 'Department is required',
    'submitting without a department is refused with the matching message',
    `alert: ${JSON.stringify(alertMessage)}`
  )

  await dlg.getByLabel('Department').selectOption({ label: 'Computer Science' })
  await dlg.getByRole('button', { name: 'Create' }).click()
  await dlg.waitFor({ state: 'detached' })
  await waitText('Software Engineering')
  const subjectRows = await sql(
    `SELECT s.name, s.code, d.name AS department
       FROM subjects s JOIN departments d ON d.id = s.department_id
      WHERE s.code = 'SE101'`
  )
  check(
    subjectRows.length === 1 &&
      subjectRows[0].name === 'Software Engineering' &&
      subjectRows[0].department === 'Computer Science',
    'subject persisted with its department (database row verified)'
  )

  // --- Issue 3: staff type — a non-teaching person through the real UI ---
  await gotoSidebar('Faculty')
  await page.getByRole('button', { name: 'Add Faculty' }).click()
  dlg = page.getByRole('dialog')
  await dlg.waitFor()
  await dlg.getByLabel('Name').fill('Office Incharge')
  await dlg.getByLabel('Department').selectOption({ label: 'Computer Science' })
  await dlg.getByLabel('Staff Type').selectOption('NON_TEACHING')
  await dlg.getByRole('button', { name: 'Create' }).click()
  await dlg.waitFor({ state: 'detached' })
  await waitText('Office Incharge')
  await waitText('Non-teaching') // list badge
  const office = (await sql("SELECT id, staff_type FROM faculty WHERE name = 'Office Incharge'"))[0]
  check(!!office && office.staff_type === 'NON_TEACHING', 'staff type persisted (NON_TEACHING)')

  await gotoSidebar('Teaching Allocations')
  await page.getByRole('button', { name: 'Add Allocation' }).click()
  dlg = page.getByRole('dialog')
  await dlg.waitFor()
  const officeOptions = await dlg
    .locator('select')
    .nth(0)
    .locator('option', { hasText: 'Office Incharge' })
    .count()
  check(officeOptions === 0, 'allocation dialog never offers non-teaching staff')
  await dlg.getByRole('button', { name: 'Cancel' }).click()
  await dlg.waitFor({ state: 'detached' })

  // --- Issues 4 + 5: configurable teaching arrangement end to end ---
  await gotoSidebar('Subject Requirements')
  await page.locator('button[title="Edit requirement"]').click()
  dlg = page.getByRole('dialog')
  await dlg.waitFor()
  // Class Type / Sessions per Week / Span sit in one 3-column row; a wrapping
  // label used to push the middle input out of line with its neighbours.
  const [classTypeBox, sessionsBox, spanBox] = await Promise.all([
    dlg.locator('select').nth(2).boundingBox(),
    dlg.locator('input[type="number"]').nth(0).boundingBox(),
    dlg.locator('input[type="number"]').nth(1).boundingBox()
  ])
  check(
    !!classTypeBox && !!sessionsBox && !!spanBox &&
      Math.abs(classTypeBox.y - sessionsBox.y) <= 1 &&
      Math.abs(classTypeBox.y - spanBox.y) <= 1,
    'Class Type / Sessions / Span controls sit on ONE line in the requirement dialog',
    `y: classType=${classTypeBox && classTypeBox.y} sessions=${sessionsBox && sessionsBox.y} span=${spanBox && spanBox.y}`
  )
  await dlg.locator('select').nth(3).selectOption('TEAM') // teaching arrangement
  await dlg.getByRole('button', { name: 'Update' }).click()
  await dlg.waitFor({ state: 'detached' })
  const reqRow = (await sql('SELECT teaching_arrangement FROM subject_requirements'))[0]
  check(
    !!reqRow && reqRow.teaching_arrangement === 'TEAM',
    'teaching arrangement TEAM persisted on the requirement'
  )

  // A second teacher joins the activity.
  const binu = (await sql("SELECT id FROM faculty WHERE name = 'Dr. Binu'"))[0]
  await gotoSidebar('Teaching Allocations')
  await page.getByRole('button', { name: 'Add Allocation' }).click()
  dlg = page.getByRole('dialog')
  await dlg.waitFor()
  await dlg.locator('select').nth(0).selectOption(binu.id)
  // Select by label, never by index: journey F created a second subject, so
  // index-based picks would silently land on the wrong subject.
  await dlg.locator('select').nth(1).selectOption({ label: 'III BCA-A (Sem 5)' })
  await dlg.locator('select').nth(2).selectOption({ label: 'Computer Science (CS101)' })
  await dlg.locator('select').nth(3).selectOption('LECTURE')
  await dlg.locator('input[type="number"]').nth(0).fill('1')
  await dlg.getByRole('button', { name: 'Create' }).click()
  await dlg.waitFor({ state: 'detached' })
  const allocCount = (await sql('SELECT COUNT(*) AS c FROM teaching_allocations'))[0].c
  check(allocCount === 2, `two teachers allocated for the activity (${allocCount} row(s))`)
  await expectCounter('3 / 36', 'weekly counter: Asha 2 + Binu 1 = 3 / 36 (each row counted once)')
  await expectCounter('33 remaining', 'weekly counter shows remaining capacity (33)')
  // Multi-teacher row: both per-teacher deletes AND the group delete belong.
  const multiDeletes = await page
    .locator('tr', { has: page.getByText(/Dr\. Binu \(\d+\)/) })
    .locator('button[title^="Delete"]')
    .count()
  check(multiDeletes === 3, 'multi-faculty row keeps both teacher deletes plus the group delete', `${multiDeletes} delete button(s)`)

  // The real solver must place BOTH teachers on EVERY session (TEAM).
  await gotoSidebar('Timetable Generation')
  await page.getByRole('button', { name: 'Generate Timetable' }).click()
  await waitText('Draft generated:', { timeout: 60000 })
  await waitText('COMPLETED')
  pass('generation completed with the TEAM arrangement configured')

  const generation = (await sql('SELECT id FROM timetable_generations ORDER BY rowid DESC LIMIT 1'))[0]
  const perEntry = await sql(
    `SELECT tef.entry_id AS id, COUNT(*) AS c
       FROM draft_timetable_entry_faculty tef
       JOIN draft_timetable_entries e ON e.id = tef.entry_id
      WHERE e.generation_id = ?
      GROUP BY tef.entry_id`,
    [generation.id]
  )
  check(perEntry.length === 2, `draft contains ${perEntry.length} session(s) for the requirement`)
  check(
    perEntry.length === 2 && perEntry.every((r) => r.c === 2),
    'TEAM arrangement: every session carries BOTH allocated teachers',
    JSON.stringify(perEntry)
  )

  await page.getByRole('button', { name: 'Validate Draft' }).click()
  await waitText('Validation passed', { timeout: 30000 })
  await waitText('Validation: passed')
  pass('TEAM draft passes independent validation (arrangement enforced)')

  // --- Allocation CRUD through the real UI (edit/delete used to be dead
  // --- buttons that silently did nothing) ---
  await gotoSidebar('Teaching Allocations')
  const binuRows = await sql(
    `SELECT ta.id, ta.required_sessions_per_week AS sessions, ta.section_id AS sectionId,
            ta.subject_id AS subjectId, ta.class_type AS classType
       FROM teaching_allocations ta
       JOIN faculty f ON f.id = ta.faculty_id
      WHERE f.name = 'Dr. Binu'`
  )
  check(binuRows.length === 1, 'found exactly one Dr. Binu allocation to exercise', `${binuRows.length} row(s)`)
  if (binuRows.length === 1) {
    const target = binuRows[0]

    // --- Action-icon geometry in the running app (invisible-icon regression) ---
    // The Actions column once rendered 14px icons crushed to a ~4px sliver by
    // a losing `p-0` override; assert the user-visible sizes directly.
    const editAction = page.locator(`button[title="Edit Dr. Binu's allocation"]`)
    const editBox = await editAction.boundingBox()
    check(
      !!editBox && editBox.width >= 32 && editBox.height >= 32,
      'edit action is a comfortable hit target (≥32×32px)',
      editBox ? `${editBox.width}×${editBox.height}px` : 'no box'
    )
    const editIcon = await editAction.locator('svg').first().boundingBox()
    check(
      !!editIcon && editIcon.width >= 16 && editIcon.height >= 16,
      'edit pencil icon renders ≥16px (visible, not crushed)',
      editIcon ? `${editIcon.width}×${editIcon.height}px` : 'no box'
    )
    const delIcon = await page
      .locator(`button[title="Delete Dr. Binu's allocation"] svg`)
      .first()
      .boundingBox()
    check(
      !!delIcon && delIcon.width >= 16 && delIcon.height >= 16,
      'delete trash icon renders ≥16px',
      delIcon ? `${delIcon.width}×${delIcon.height}px` : 'no box'
    )

    // --- Faculty cell is plain table text, not a grey pill bubble ---
    // (regression: a rounded-full badge shrank to the column minimum and
    // wrapped the teacher's name across lines INSIDE the bubble.)
    const facultyLine = page.getByText(/Dr\. Binu \(\d+\)/).first()
    const facultyStyle = await facultyLine.evaluate((el) => {
      const cs = getComputedStyle(el)
      return { bg: cs.backgroundColor, radius: cs.borderRadius, text: el.textContent.trim() }
    })
    check(
      facultyStyle.bg === 'rgba(0, 0, 0, 0)',
      'faculty renders as plain table text (no grey bubble background)',
      facultyStyle.bg
    )
    check(
      facultyStyle.radius === '0px',
      'no rounded badge around the faculty name',
      facultyStyle.radius
    )
    check(
      facultyStyle.text === 'Dr. Binu (1)',
      'faculty name and session count render unabbreviated on the cell',
      JSON.stringify(facultyStyle.text)
    )
    const facultyBox = await facultyLine.boundingBox()
    check(
      !!facultyBox && facultyBox.height < 32,
      'faculty name stays on a single line (no wrapping inside the cell)',
      facultyBox ? `${Math.round(facultyBox.width)}×${Math.round(facultyBox.height)}px` : 'no box'
    )

    // --- Every action icon sits on ONE row in the Actions column ---
    const actionTops = await editAction.evaluate((el) =>
      Array.from(el.closest('tr').querySelectorAll('td:last-child button')).map((b) =>
        Math.round(b.getBoundingClientRect().top)
      )
    )
    check(
      actionTops.length >= 3 && new Set(actionTops).size === 1,
      'edit/delete icons align horizontally on a single row (no wrapped buttons)',
      `${actionTops.length} button(s), tops=${actionTops.join(',')}`
    )

    // Edit: sessions/week 1 → 3, persisted; then restored.
    await editAction.click()
    dlg = page.getByRole('dialog')
    await dlg.waitFor()
    await dlg.locator('input[type="number"]').nth(0).fill(String(target.sessions + 2))
    await dlg.getByRole('button', { name: 'Update' }).click()
    await dlg.waitFor({ state: 'detached' })
    const edited = await sql(
      'SELECT required_sessions_per_week AS s FROM teaching_allocations WHERE id = ?',
      [target.id]
    )
    check(
      edited.length === 1 && edited[0].s === target.sessions + 2,
      `allocation edit persisted (sessions/week ${target.sessions} → ${edited[0] && edited[0].s})`
    )
    await expectCounter('5 / 36', 'weekly counter follows an edit (3 → 5 sessions)')

    await page.locator(`button[title="Edit Dr. Binu's allocation"]`).click()
    dlg = page.getByRole('dialog')
    await dlg.waitFor()
    await dlg.locator('input[type="number"]').nth(0).fill(String(target.sessions))
    await dlg.getByRole('button', { name: 'Update' }).click()
    await dlg.waitFor({ state: 'detached' })
    const restored = await sql('SELECT required_sessions_per_week AS s FROM teaching_allocations WHERE id = ?', [
      target.id,
    ])
    check(restored[0] && restored[0].s === target.sessions, 'allocation edit restored to its original value')
    await expectCounter('3 / 36', 'weekly counter follows the restored edit (back to 3)')

    // The counter reflects persisted data, not component state: full reload.
    await page.reload()
    await page.getByRole('link', { name: 'Teaching Allocations', exact: true }).waitFor({ timeout: 15000 })
    await gotoSidebar('Teaching Allocations')
    await expectCounter('3 / 36', 'weekly counter unchanged after a full reload')

    // Delete: the native confirm() must be ACCEPTED for the row to go.
    await withAcceptedDialogs(() =>
      page.locator(`button[title="Delete Dr. Binu's allocation"]`).click()
    )
    await page.waitForTimeout(600)
    const afterDelete = await sql('SELECT COUNT(*) AS c FROM teaching_allocations WHERE id = ?', [target.id])
    check(afterDelete[0].c === 0, 'allocation delete confirmed via native confirm() and persisted')
    await expectCounter('2 / 36', 'weekly counter follows a delete (3 → 2 sessions)')

    // Re-create exactly what was deleted so later journeys (H counts six
    // allocation rows) keep their baseline.
    const binu = (await sql("SELECT id FROM faculty WHERE name = 'Dr. Binu'"))[0]
    await page.getByRole('button', { name: 'Add Allocation' }).click()
    dlg = page.getByRole('dialog')
    await dlg.waitFor()
    await dlg.locator('select').nth(0).selectOption(binu.id)
    await dlg.locator('select').nth(1).selectOption(target.sectionId)
    await dlg.locator('select').nth(2).selectOption(target.subjectId)
    await dlg.locator('select').nth(3).selectOption(target.classType)
    await dlg.locator('input[type="number"]').nth(0).fill(String(target.sessions))
    await dlg.getByRole('button', { name: 'Create' }).click()
    await dlg.waitFor({ state: 'detached' })
    const backToTwo = (await sql('SELECT COUNT(*) AS c FROM teaching_allocations'))[0].c
    check(backToTwo === 2, `allocation re-created after delete (${backToTwo} row(s) total)`)
    await expectCounter('3 / 36', 'weekly counter follows re-creation (back to 3)')

    // --- Over capacity: the true total is shown and clearly flagged ---
    // The create/edit form caps ONE row at 10 sessions (native HTML
    // validation on `max="10"`), so 36+ is reached the way a coordinator
    // actually could: several max-size rows on the same subject.
    const cs101Over = (await sql("SELECT id FROM subjects WHERE code = 'CS101'"))[0]
    async function addOverRow(facultyName, classType, sessions) {
      const fid = (await sql('SELECT id FROM faculty WHERE name = ?', [facultyName]))[0].id
      await page.getByRole('button', { name: 'Add Allocation' }).click()
      const d = page.getByRole('dialog')
      await d.waitFor()
      await d.locator('select').nth(0).selectOption(fid)
      await d.locator('select').nth(1).selectOption(target.sectionId)
      await d.locator('select').nth(2).selectOption(cs101Over.id)
      await d.locator('select').nth(3).selectOption(classType)
      await d.locator('input[type="number"]').nth(0).fill(String(sessions))
      await d.getByRole('button', { name: 'Create' }).click()
      await d.waitFor({ state: 'detached' })
    }
    await addOverRow('Dr. Asha', 'TUTORIAL', 10)
    await addOverRow('Dr. Binu', 'TUTORIAL', 10)
    await expectCounter('23 / 36', 'two max-size rows bring the counter to 23 / 36')
    await addOverRow('Dr. Asha', 'LAB', 10)
    await addOverRow('Dr. Binu', 'LAB', 10)
    await expectCounter('43 / 36', 'over capacity: the true total is shown, never capped')
    await expectCounter('capacity exceeded', 'over capacity is clearly indicated in the header')

    // Remove both synthetic groups (accepted confirms) so journey H's
    // six-row baseline holds.
    for (const type of ['LAB', 'TUTORIAL']) {
      await withAcceptedDialogs(() =>
        page
          .locator('tr', { has: page.getByText(type, { exact: true }) })
          .locator('button[title="Delete all allocations for this Section+Subject+Type"]')
          .click()
      )
      await page.waitForTimeout(500)
    }
    await expectCounter('3 / 36', 'counter returns to 3 / 36 once the over-capacity rows are removed')
  }
}

/* ------------------------------------------------------------------ *
 * Journey H — Windows runtime smoke checklist items the other journeys
 * do not cover: a multi-teacher TEAM lab (span 2, both teachers on the
 * session) and an ALTERNATE requirement sharing the same subject (one
 * teacher per session, both teachers used), placed by the real solver
 * and independently validated. Runs AFTER journey B (which relies on
 * there being exactly one requirement while it edits it).
 * ------------------------------------------------------------------ */
async function journeyH() {
  console.log('\n=== Journey H: TEAM lab + ALTERNATE arrangement ===')

  const asha = (await sql("SELECT id FROM faculty WHERE name = 'Dr. Asha'"))[0]
  const binu = (await sql("SELECT id FROM faculty WHERE name = 'Dr. Binu'"))[0]
  if (!asha || !binu) {
    fail('journey H: expected Dr. Asha and Dr. Binu to exist (journeys A/F must run first)')
    return
  }

  /** Add a teaching allocation through the real dialog. */
  async function addAllocation(facultyId, subjectLabel, classType, sessions) {
    await page.getByRole('button', { name: 'Add Allocation' }).click()
    const d = page.getByRole('dialog')
    await d.waitFor()
    await d.locator('select').nth(0).selectOption(facultyId) // faculty (options carry a UUID)
    await d.locator('select').nth(1).selectOption({ label: 'III BCA-A (Sem 5)' })
    await d.locator('select').nth(2).selectOption({ label: subjectLabel })
    await d.locator('select').nth(3).selectOption(classType)
    await d.locator('input[type="number"]').nth(0).fill(String(sessions))
    await d.getByRole('button', { name: 'Create' }).click()
    await d.waitFor({ state: 'detached' })
  }

  // --- Requirement 1: Software Engineering LAB — TEAM, 1×/week, span 2 ---
  await gotoSidebar('Subject Requirements')
  await page.getByRole('button', { name: 'Add Requirement' }).click()
  let dlg = page.getByRole('dialog')
  await dlg.waitFor()
  await dlg.locator('select').nth(0).selectOption({ label: 'III BCA-A (Sem 5)' })
  await dlg.locator('select').nth(1).selectOption({ label: 'Software Engineering (SE101)' })
  await dlg.locator('select').nth(2).selectOption('LAB')
  await dlg.locator('select').nth(3).selectOption('TEAM')
  await dlg.locator('input[type="number"]').nth(0).fill('1') // sessions/week
  await dlg.locator('input[type="number"]').nth(1).fill('2') // span
  await dlg.getByRole('button', { name: 'Create' }).click()
  await dlg.waitFor({ state: 'detached' })

  // --- Requirement 2: Software Engineering LECTURE — ALTERNATE, 2×/week ---
  await page.getByRole('button', { name: 'Add Requirement' }).click()
  dlg = page.getByRole('dialog')
  await dlg.waitFor()
  await dlg.locator('select').nth(0).selectOption({ label: 'III BCA-A (Sem 5)' })
  await dlg.locator('select').nth(1).selectOption({ label: 'Software Engineering (SE101)' })
  await dlg.locator('select').nth(2).selectOption('LECTURE')
  await dlg.locator('select').nth(3).selectOption('ALTERNATE')
  await dlg.locator('input[type="number"]').nth(0).fill('2')
  await dlg.locator('input[type="number"]').nth(1).fill('1')
  await dlg.getByRole('button', { name: 'Create' }).click()
  await dlg.waitFor({ state: 'detached' })
  const reqCount = (await sql('SELECT COUNT(*) AS c FROM subject_requirements'))[0].c
  check(reqCount === 3, `three requirements configured (${reqCount} row(s))`)

  // --- Two teachers join both SE activities ---
  await gotoSidebar('Teaching Allocations')
  await addAllocation(asha.id, 'Software Engineering (SE101)', 'LAB', 1)
  await addAllocation(binu.id, 'Software Engineering (SE101)', 'LAB', 1)
  await addAllocation(asha.id, 'Software Engineering (SE101)', 'LECTURE', 1)
  await addAllocation(binu.id, 'Software Engineering (SE101)', 'LECTURE', 1)
  const allocCount = (await sql('SELECT COUNT(*) AS c FROM teaching_allocations'))[0].c
  check(allocCount === 6, `six allocation rows after the SE activities (${allocCount})`)
  await expectCounter('7 / 36', 'weekly counter totals 7 / 36 after all six allocations')
  await expectCounter('29 remaining', 'weekly counter shows 29 remaining (spec example: 7 / 36)')

  // --- Real generation ---
  await gotoSidebar('Timetable Generation')
  await page.getByRole('button', { name: 'Generate Timetable' }).click()
  await waitText('Draft generated:', { timeout: 60000 })
  await waitText('COMPLETED')
  pass('generation completed with the TEAM lab and ALTERNATE lecture configured')

  const generation = (await sql('SELECT id FROM timetable_generations ORDER BY rowid DESC LIMIT 1'))[0]
  const se = (await sql("SELECT id FROM subjects WHERE code = 'SE101'"))[0]

  // TEAM lab: one session, span 2, BOTH teachers on it.
  const labEntries = await sql(
    'SELECT id, span FROM draft_timetable_entries WHERE generation_id = ? AND subject_id = ? AND class_type = ?',
    [generation.id, se.id, 'LAB']
  )
  check(labEntries.length === 1, `TEAM lab placed as ${labEntries.length} session(s)`)
  if (labEntries.length === 1) {
    check(labEntries[0].span === 2, `lab session spans 2 consecutive periods (span=${labEntries[0].span})`)
    const teachers = await sql(
      'SELECT COUNT(*) AS c FROM draft_timetable_entry_faculty WHERE entry_id = ?',
      [labEntries[0].id]
    )
    check(teachers[0].c === 2, 'TEAM lab session carries BOTH allocated teachers', JSON.stringify(teachers))
  }

  // ALTERNATE lecture: two sessions, exactly one teacher each, both used.
  const lectureEntries = await sql(
    'SELECT id FROM draft_timetable_entries WHERE generation_id = ? AND subject_id = ? AND class_type = ?',
    [generation.id, se.id, 'LECTURE']
  )
  check(lectureEntries.length === 2, `ALTERNATE lecture placed as ${lectureEntries.length} session(s)`)
  if (lectureEntries.length === 2) {
    const teacherCounts = []
    for (const entry of lectureEntries) {
      const rows = await sql('SELECT faculty_id FROM draft_timetable_entry_faculty WHERE entry_id = ?', [entry.id])
      teacherCounts.push(rows.length)
    }
    check(
      teacherCounts.every((c) => c === 1),
      'ALTERNATE lecture: exactly ONE teacher per session',
      JSON.stringify(teacherCounts)
    )
    const used = await sql(
      `SELECT DISTINCT tef.faculty_id
         FROM draft_timetable_entry_faculty tef
         JOIN draft_timetable_entries e ON e.id = tef.entry_id
        WHERE e.generation_id = ? AND e.subject_id = ? AND e.class_type = 'LECTURE'`,
      [generation.id, se.id]
    )
    check(used.length === 2, `both allocated teachers share the lecture sessions (${used.length} distinct)`)
  }

  // The arrangements are visible to the administrator in the table.
  await gotoSidebar('Subject Requirements')
  await waitText('ALTERNATE')
  pass('requirement table shows the TEAM and ALTERNATE arrangements')

  // --- Independent validation ---
  await gotoSidebar('Timetable Generation')
  await page.getByRole('button', { name: 'Validate Draft' }).click()
  await waitText('Validation passed', { timeout: 30000 })
  await waitText('Validation: passed')
  pass('TEAM lab + ALTERNATE draft passes independent validation')

  // --- Publish: the multi-teacher, multi-span draft must land WHOLE ---
  await page.getByRole('button', { name: 'Publish', exact: true }).click()
  await waitText('Publish this draft as the master timetable?')
  const pubDlg = page.getByRole('dialog')
  await pubDlg.getByRole('button', { name: 'Publish', exact: true }).click()
  await waitText('session(s) to the master timetable', { timeout: 30000 })
  pass('TEAM lab + ALTERNATE draft published to the master timetable')

  const masterLab = await sql(
    `SELECT te.id, te.span,
            (SELECT COUNT(*) FROM timetable_entry_faculty tef WHERE tef.entry_id = te.id) AS teachers
       FROM timetable_entries te
      WHERE te.class_type = 'LAB' AND te.subject_id = ?`,
    [se.id]
  )
  check(
    masterLab.length === 1 && masterLab[0].span === 2 && masterLab[0].teachers === 2,
    'published master timetable carries the span-2 TEAM lab with BOTH teachers',
    JSON.stringify(masterLab)
  )
  const masterLectures = await sql(
    `SELECT te.id,
            (SELECT COUNT(*) FROM timetable_entry_faculty tef WHERE tef.entry_id = te.id) AS teachers
       FROM timetable_entries te
      WHERE te.class_type = 'LECTURE' AND te.subject_id = ?`,
    [se.id]
  )
  check(
    masterLectures.length === 2 && masterLectures.every((r) => r.teachers === 1),
    'published ALTERNATE lectures: two sessions, exactly one teacher each',
    JSON.stringify(masterLectures)
  )
  const latestGen = (await sql('SELECT id FROM timetable_generations ORDER BY rowid DESC LIMIT 1'))[0]
  const latestStatuses = await sql(
    'SELECT DISTINCT status FROM draft_timetable_entries WHERE generation_id = ?',
    [latestGen.id]
  )
  check(
    latestStatuses.length === 1 && latestStatuses[0].status === 'PUBLISHED',
    'every draft row of the published generation marked PUBLISHED (older superseded drafts stay as history)',
    JSON.stringify(latestStatuses)
  )
}

/* ------------------------------------------------------------------ *
 * Journey B — impossible requirement → FAILED with diagnostics,
 * published timetable untouched
 * ------------------------------------------------------------------ */
async function journeyB() {
  console.log('\n=== Journey B: impossible requirement → diagnostics ===')

  const beforeCount = (await sql('SELECT COUNT(*) AS c FROM timetable_entries'))[0].c

  // Break the requirement: 10 sessions × span 4 = 40 periods into 36 available.
  await gotoSidebar('Subject Requirements')
  await page.locator('button[title="Edit requirement"]').click()
  let dlg = page.getByRole('dialog')
  await dlg.waitFor()
  await dlg.locator('input[type="number"]').nth(0).fill('10')
  await dlg.locator('input[type="number"]').nth(1).fill('4')
  await dlg.getByRole('button', { name: 'Update' }).click()
  await dlg.waitFor({ state: 'detached' })
  await waitText('10 / week')
  pass('requirement edited to an impossible 40 periods/week')

  await gotoSidebar('Timetable Generation')
  await page.getByRole('button', { name: 'Generate Timetable' }).click()
  await waitText('FAILED', { timeout: 60000 })
  pass('generation failed honestly (no partial timetable as success)')

  // Administrator-readable diagnostics on screen.
  await waitText('SECTION_OVERLOADED')
  await waitText('Suggested action')
  await waitText('40 periods')
  pass('diagnostics tab shows code, reason and suggested action')

  // Persisted diagnostics (what the page renders comes from the DB).
  const generation = (await sql('SELECT id FROM timetable_generations ORDER BY rowid DESC LIMIT 1'))[0]
  const diags = await sql(
    'SELECT severity, code, message FROM generation_diagnostics WHERE generation_id = ?',
    [generation.id]
  )
  const overload = diags.find((d) => d.code === 'SECTION_OVERLOADED')
  check(!!overload, 'SECTION_OVERLOADED diagnostic persisted')
  check(
    !!overload && /40 periods/.test(overload.message) && /III BCA-A/.test(overload.message),
    'diagnostic names the section and the numbers'
  )
  check(
    diags.some((d) => d.code === 'FACULTY_OVERLOADED'),
    'FACULTY_OVERLOADED diagnostic persisted for the over-booked allocation'
  )

  const afterCount = (await sql('SELECT COUNT(*) AS c FROM timetable_entries'))[0].c
  check(
    afterCount === beforeCount,
    `published timetable untouched by the failed run (${afterCount} entries)`
  )

  // Restore the workable requirement for the remaining journeys.
  await gotoSidebar('Subject Requirements')
  await page.locator('button[title="Edit requirement"]').click()
  dlg = page.getByRole('dialog')
  await dlg.waitFor()
  await dlg.locator('input[type="number"]').nth(0).fill('2')
  await dlg.locator('input[type="number"]').nth(1).fill('1')
  await dlg.getByRole('button', { name: 'Update' }).click()
  await dlg.waitFor({ state: 'detached' })
  await waitText('2 / week')
  pass('requirement restored')
}

/* ------------------------------------------------------------------ *
 * Journey C — attendance absence → substitution plan → approve
 * ------------------------------------------------------------------ */
async function journeyC() {
  console.log('\n=== Journey C: attendance → substitution plan → approve ===')

  // Pick a weekday where the published timetable actually teaches Dr. Asha so
  // the run has real affected classes.
  const days = await sql(
    `SELECT DISTINCT te.day_of_week AS dow
       FROM timetable_entries te
       JOIN timetable_entry_faculty tef ON tef.entry_id = te.id
       JOIN faculty f ON f.id = tef.faculty_id
      WHERE f.name LIKE '%Asha%'
      ORDER BY te.day_of_week`
  )
  if (!days || days.length === 0) {
    fail('journey C: no published entries found for Dr. Asha')
    return
  }
  const date = nextDateForWeekday(days[0].dow)
  pass(`chosen substitution date ${date} (${days[0].dow}) has published classes`)

  // Mark Dr. Asha absent through the Attendance page.
  await gotoSidebar("Today's Attendance")
  await page.locator('input[type="date"]').fill(date)
  const ashaRow = page.getByRole('button', { name: /Dr\. Asha/ })
  await ashaRow.waitFor()
  await ashaRow.click()
  await ashaRow.locator('text=Absent').waitFor({ timeout: 10000 })
  pass('attendance toggled to ABSENT for Dr. Asha')

  // Generate and approve the plan.
  await gotoSidebar('Substitution Planner')
  await page.locator('input[type="date"]').fill(date)
  await page.getByRole('button', { name: 'Generate Plan' }).click()
  await page.getByTestId('lifecycle-status').waitFor({ timeout: 15000 })
  const runs = await sql('SELECT status FROM substitution_runs WHERE date = ?', [date])
  check(runs.length === 1, 'substitution run persisted for the date')
  await waitText('Affected Classes')
  const assignments = await sql(
    `SELECT COUNT(*) AS c
       FROM substitution_assignments a
       JOIN substitution_runs r ON r.id = a.run_id
      WHERE r.date = ?`,
    [date]
  )
  check(assignments[0].c >= 1, `plan covers the absence (${assignments[0].c} assignment(s))`)

  await page.getByRole('button', { name: 'Approve Plan' }).click()
  await waitText('APPROVED')
  const approved = await sql('SELECT status FROM substitution_runs WHERE date = ?', [date])
  check(approved[0].status === 'APPROVED', 'run status APPROVED in the database')

  // Issue 3: the non-teaching staff member (created in journey F) must never
  // be handed a class, however free they are.
  const office = await sql("SELECT id FROM faculty WHERE name = 'Office Incharge'")
  if (office.length === 1) {
    const officeAssignments = await sql(
      'SELECT COUNT(*) AS c FROM substitution_assignments WHERE substitute_faculty_id = ?',
      [office[0].id]
    )
    check(officeAssignments[0].c === 0, 'non-teaching staff never assigned as a substitute')
  } else {
    fail('journey C: Office Incharge missing — journey F must run before journey C')
  }

  // --- Approve WITH uncovered classes: allowed, but never silently ---
  // Product decision: a coordinator may have arranged the remaining covers
  // outside the app, so approval is possible — but the button must name the
  // uncovered count AND a native confirmation must stand in the way. (The
  // pre-fix UI hid the approve button whenever anything was uncovered,
  // leaving no way forward at all.)
  const capBefore = (await sql(
    "SELECT value FROM application_settings WHERE key = 'max_daily_substitutions'"
  ))[0]
  await execSql(
    `INSERT INTO application_settings (id, key, value, description, created_at, updated_at)
     VALUES (?, 'max_daily_substitutions', '0', 'Maximum daily substitutions per faculty', datetime('now'), datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = '0'`,
    [require('crypto').randomUUID()]
  )
  // Regenerating an APPROVED plan asks for confirmation first (it clears the
  // approval) — accept it, as a coordinator would.
  await withAcceptedDialogs(() => page.getByRole('button', { name: 'Generate Plan' }).click())
  await page.getByTestId('lifecycle-status').waitFor({ timeout: 15000 })
  await waitText('Approve Anyway', { timeout: 15000 })
  pass('approve button stays reachable with uncovered classes and names the count')

  let confirmMessage = null
  const recordConfirm = (d) => {
    confirmMessage = d.message()
  }
  page.on('dialog', recordConfirm)
  await withAcceptedDialogs(() =>
    page.getByRole('button', { name: /Approve Anyway/ }).click()
  )
  page.off('dialog', recordConfirm)
  await waitText('APPROVED', { timeout: 15000 })
  check(
    !!confirmMessage && /uncovered/i.test(confirmMessage),
    'approving with uncovered classes requires a confirmation naming them',
    `confirm: ${JSON.stringify(confirmMessage)}`
  )
  const reApproved = await sql('SELECT status FROM substitution_runs WHERE date = ?', [date])
  check(reApproved[0].status === 'APPROVED', 'run re-approved after confirming the uncovered classes')

  // Restore the institution-wide cap exactly as it was.
  await execSql(
    `INSERT INTO application_settings (id, key, value, description, created_at, updated_at)
     VALUES (?, 'max_daily_substitutions', ?, 'Maximum daily substitutions per faculty', datetime('now'), datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    [require('crypto').randomUUID(), capBefore ? capBefore.value : '2']
  )
  const capRestored = (await sql(
    "SELECT value FROM application_settings WHERE key = 'max_daily_substitutions'"
  ))[0]
  check(
    capRestored && capRestored.value === (capBefore ? capBefore.value : '2'),
    'daily-substitution cap restored after the scenario'
  )
}

/* ------------------------------------------------------------------ *
 * Journey D — relaunch → auto backup snapshot exists; backup page renders
 * ------------------------------------------------------------------ */
async function journeyD() {
  console.log('\n=== Journey D: relaunch → auto backup ===')

  const autoBackupDir = path.join(DATA_DIR, 'database', 'auto-backups')
  const found = await waitFor(() => {
    try {
      return fs.existsSync(autoBackupDir) && fs.readdirSync(autoBackupDir).some((f) => /^substiflow-\d{4}-\d{2}-\d{2}\.db$/.test(f))
    } catch (e) {
      return false
    }
  }, 20000)
  check(found, 'automatic daily backup snapshot created at startup')

  await gotoSidebar('Backup & Restore')
  await waitText('Export Backup')
  await waitText('Import Backup')
  await waitText('Auto Backup')
  pass('backup page renders (native save/open dialogs are not automatable here)')
}

/* ------------------------------------------------------------------ *
 * Journey E — every page renders
 * ------------------------------------------------------------------ */
async function journeyE() {
  console.log('\n=== Journey E: all pages render ===')
  const routes = [
    'Dashboard',
    "Today's Attendance",
    'Substitution Planner',
    'Master Timetable',
    'Teaching Allocations',
    'Subject Requirements',
    'Timetable Generation',
    'Faculty',
    'Subjects',
    'Classes',
    'Rooms',
    'Reports',
    'Settings',
    'Backup & Restore',
  ]
  for (const route of routes) {
    await gotoSidebar(route)
    const heading = (await page.locator('h1').first().textContent().catch(() => null)) || ''
    const crashed = await page
      .getByText('Something went wrong')
      .isVisible()
      .catch(() => false)
    await check(
      heading.trim().length > 0 && !crashed,
      `page "${route}" renders (h1: ${heading.trim() || '—'})`
    )
  }

  // The footer version must come from the main process (app.getVersion()):
  // a hardcoded literal silently drifts at the next release and misleads
  // every bug report.
  const expectedVersion = require(path.join(ROOT, 'package.json')).version
  const versionRe = new RegExp(`SubstiFlow v${expectedVersion.replace(/\./g, '\\.')}`)
  const versionText = (
    (await page
      .getByText(versionRe)
      .first()
      .textContent()
      .catch(() => null)) || ''
  ).trim()
  check(
    versionText === `SubstiFlow v${expectedVersion}`,
    'sidebar footer shows the main-process version (not a stale literal)',
    versionText || 'not found'
  )
}

/* ------------------------------------------------------------------ *
 * Journey G1 — legacy audit rows with a NULL id (the duplicate React
 * keys reported on the Dashboard) must still render, and the schema
 * stamp is rewound so the next launch behaves like a pre-v7 upgrade.
 * ------------------------------------------------------------------ */
async function journeyG1() {
  console.log('\n=== Journey G1: legacy NULL-id audit rows render ===')

  const nowIso = new Date().toISOString()
  for (let i = 0; i < 3; i++) {
    await execSql(
      `INSERT INTO audit_log (action, entity_type, detail, created_at, updated_at)
       VALUES ('timetable.deleted', 'timetable_entry', 'Legacy audit row (E2E)', ?, ?)`,
      [nowIso, nowIso]
    )
  }
  const nulls = (await sql('SELECT COUNT(*) AS c FROM audit_log WHERE id IS NULL'))[0].c
  check(nulls === 3, `3 legacy NULL-id audit rows present (${nulls} null id(s))`)

  await gotoSidebar('Dashboard')
  await page.locator('div[title="Legacy audit row (E2E)"]').first().waitFor({ timeout: 15000 })
  const rendered = await page.locator('div[title="Legacy audit row (E2E)"]').count()
  check(rendered === 3, `Recent Activity renders all 3 legacy rows (${rendered})`)

  // Rewind the stamp so the NEXT launch runs migration 7 against a database
  // that already contains legacy NULL-id rows — exactly the production
  // upgrade situation. (A real pre-v7 production database carries the stamp
  // of every migration that ever ran, so simulate that honestly: stamp 6,
  // not "no stamp at all" — an empty schema_version would replay migrations
  // 1..6 against an already-current schema.)
  await execSql('DELETE FROM schema_version')
  await execSql('INSERT INTO schema_version (version) VALUES (6)')
  const rewound = (await sql('SELECT MAX(version) v FROM schema_version'))[0].v
  check(rewound === 6, `schema stamp rewound to v${rewound} (simulated pre-v7 database)`)
}

/* ------------------------------------------------------------------ *
 * Journey G2 — after the relaunch, migration 7 must have backfilled
 * every legacy NULL audit id: unique React keys, nothing lost, and the
 * Dashboard still renders the same rows.
 * ------------------------------------------------------------------ */
async function journeyG2() {
  console.log('\n=== Journey G2: v7 backfill after relaunch ===')

  const nulls = (await sql('SELECT COUNT(*) AS c FROM audit_log WHERE id IS NULL'))[0].c
  check(nulls === 0, `migration 7 backfilled every legacy NULL audit id (${nulls} remaining)`)
  const duplicated = (await sql(
    `SELECT COUNT(*) AS c FROM (
       SELECT id FROM audit_log WHERE id IS NOT NULL GROUP BY id HAVING COUNT(*) > 1
     )`
  ))[0].c
  check(duplicated === 0, 'every audit id is unique — React keys cannot collide')
  const total = (await sql('SELECT COUNT(*) AS c FROM audit_log'))[0].c
  const distinctIds = (await sql('SELECT COUNT(DISTINCT id) AS c FROM audit_log'))[0].c
  check(total === distinctIds, `no audit row was lost during the backfill (${total} rows)`)
  const version = (await sql('SELECT MAX(version) v FROM schema_version'))[0].v
  check(version === 8, `schema stamped at v${version} after the upgrade`)

  await gotoSidebar('Dashboard')
  await page.locator('div[title="Legacy audit row (E2E)"]').first().waitFor({ timeout: 15000 })
  const rendered = await page.locator('div[title="Legacy audit row (E2E)"]').count()
  check(rendered === 3, 'backfilled rows still render in Recent Activity')
}

/* ------------------------------------------------------------------ *
 * Runner
 * ------------------------------------------------------------------ */
async function runJourney(name, fn) {
  try {
    await fn()
  } catch (error) {
    fail(`${name} aborted`, String(error && error.message ? error.message : error).split('\n')[0])
    await shot(name.replace(/[^a-z0-9]+/gi, '-').toLowerCase())
  }
}

async function main() {
  console.log('SubstiFlow E2E journeys')
  console.log('QA directory:', QA_ROOT)

  // Only ever kill OUR Electron (matched by its absolute binary path), never
  // other applications on the machine. Portable across macOS/Linux (pkill)
  // and Windows (PowerShell process query).
  killStaleElectron()
  sh('node scripts/ensure-abi.js electron')
  execSync('npm run build', { cwd: ROOT, stdio: 'inherit' })

  try {
    const first = await launchApp()
    app = first.launched
    page = first.firstPage

    await runJourney('Journey A (setup → generate → publish)', journeyA)
    await runJourney('Journey F (manual-testing fixes: subject, staff type, TEAM)', journeyF)
    await runJourney('Journey B (impossible requirement)', journeyB)
    await runJourney('Journey C (substitutions)', journeyC)
    await runJourney('Journey H (TEAM lab + ALTERNATE arrangement)', journeyH)

    await app.close()
    await sleep(1000)

    const second = await launchApp()
    app = second.launched
    page = second.firstPage

    await runJourney('Journey D (relaunch → auto backup)', journeyD)
    await runJourney('Journey E (all pages render)', journeyE)
    await runJourney('Journey G1 (legacy NULL-id audit rows render)', journeyG1)

    await app.close()
    await sleep(1000)

    const third = await launchApp()
    app = third.launched
    page = third.firstPage

    await runJourney('Journey G2 (v7 backfill after relaunch)', journeyG2)
  } finally {
    try {
      if (app) await app.close()
    } catch (e) {
      /* already closed */
    }
    sh('node scripts/ensure-abi.js node')
  }

  console.log('\n=== Offline verification ===')
  await check(
    externalRequests.length === 0,
    `no external network requests across every journey (${externalRequests.length} observed)`,
    externalRequests.slice(0, 5).join(', ')
  )

  console.log(`\n=== Summary: ${checks} checks passed, ${failures.length} failed ===`)
  for (const f of failures) console.error(`  FAILED: ${f}`)
  if (pageErrors.length > 0) {
    console.error(`\n${pageErrors.length} uncaught page error(s) observed:`)
    for (const e of pageErrors) console.error(`  ${e}`)
  }
  const fatal = failures.length > 0 || pageErrors.length > 0
  console.log(fatal ? '\nRESULT: FAIL' : '\nRESULT: PASS')
  process.exit(fatal ? 1 : 0)
}

main().catch((error) => {
  console.error('E2E runner crashed:', error)
  try {
    if (app) app.close()
  } catch (e) {
    /* ignore */
  }
  sh('node scripts/ensure-abi.js node')
  process.exit(1)
})
