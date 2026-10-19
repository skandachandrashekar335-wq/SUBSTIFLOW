/**
 * demo:verify — automated walkthrough of the REAL demo workflow against the
 * ISOLATED demo database (never production). Launches the built app through
 * Playwright (Electron), drives the actual UI, and checks results
 * independently through the app's own preload SQL bridge:
 *
 *   1. DEMO DATA banner + demo isolation visible in the UI
 *   2. Timetable Generation: real solver → draft → Validate → Publish
 *   3. Substitution scenario A: one teacher absent → plan covers the classes
 *      (substitutes independently verified eligible/available/within limits)
 *      → Approve → revised timetable
 *   4. Substitution scenario B: whole teaching staff absent → every class is
 *      reported uncovered (never silently assigned) → "Approve Anyway"
 *      confirmation naming the uncovered classes
 *   5. Attendance restored to PRESENT for everyone afterwards
 *
 * Run with: npm run demo:verify   (after npm run demo:setup)
 * This is a workflow verification, not part of `npm test`.
 */
const path = require('path')
const fs = require('fs')
const os = require('os')
const { execSync } = require('child_process')
const { _electron } = require('playwright')

const ROOT = path.resolve(__dirname, '..', '..')
const DIST_DEMO_PATHS = path.join(ROOT, 'dist', 'main', 'src', 'db', 'demoPaths')
if (!fs.existsSync(`${DIST_DEMO_PATHS}.js`)) {
  console.error('demo:verify: compiled demo modules missing — run through npm (npm run demo:verify).')
  process.exit(1)
}
const { resolveDemoPaths } = require(DIST_DEMO_PATHS)
const paths = resolveDemoPaths(ROOT)

if (!fs.existsSync(paths.dbPath)) {
  console.error(`demo:verify: no demo database at ${paths.dbPath}.\nRun: npm run demo:setup`)
  process.exit(1)
}
if (
  !fs.existsSync(path.join(ROOT, 'dist', 'main', 'electron', 'main.js')) ||
  !fs.existsSync(path.join(ROOT, 'dist', 'renderer', 'index.html'))
) {
  console.error('demo:verify: build output missing — run: npm run build')
  process.exit(1)
}

const SHOTS = path.join(os.tmpdir(), 'substiflow-demo-verify')
fs.mkdirSync(SHOTS, { recursive: true })

let app = null
let page = null
let checks = 0
const failures = []
const pageErrors = []
let dialogAnswer = 'dismiss'

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

async function waitText(text, opts = {}) {
  await page
    .getByText(text, { exact: opts.exact === true })
    .first()
    .waitFor({ state: 'visible', timeout: opts.timeout || 15000 })
}

async function gotoSidebar(name) {
  await page.getByRole('link', { name, exact: true }).click()
  await page.waitForTimeout(400)
}

async function shot(name) {
  if (!page) return
  const file = path.join(SHOTS, `${name}.png`)
  // Full-page capture: the grids sit below the fold, and the evidence must
  // show the complete timetable, not just the header.
  await page.screenshot({ path: file, fullPage: true }).catch(() => {})
  console.log(`  [shot] ${file}`)
}

async function withAcceptedDialogs(fn, settleMs = 500) {
  const previous = dialogAnswer
  dialogAnswer = 'accept'
  try {
    return await fn()
  } finally {
    await sleep(settleMs)
    dialogAnswer = previous
  }
}

const DAY_TO_JS = { SUNDAY: 0, MONDAY: 1, TUESDAY: 2, WEDNESDAY: 3, THURSDAY: 4, FRIDAY: 5, SATURDAY: 6 }
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

function attachPageHandlers(target) {
  target.on('console', (msg) => {
    if (msg.type() === 'error') console.log(`  [console.error] ${msg.text()}`)
  })
  target.on('pageerror', (err) => {
    pageErrors.push(String(err))
    console.error('  [pageerror]', String(err))
  })
  target.on('dialog', async (dialog) => {
    console.log(`  [js-dialog:${dialog.type()}] ${dialog.message()}`)
    try {
      if (dialogAnswer === 'accept') await dialog.accept()
      else await dialog.dismiss()
    } catch {
      /* the dialog may already be gone */
    }
  })
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Toggle a faculty member on the Attendance page until the DB agrees. */
async function setFacultyAbsent(name, date, wantAbsent) {
  const row = page.getByRole('button', { name: new RegExp(`${escapeRe(name)}\\b`) })
  await row.waitFor({ timeout: 15000 })
  for (let i = 0; i < 4; i += 1) {
    const rows = await sql(
      'SELECT status FROM attendance WHERE date = ? AND faculty_id = (SELECT id FROM faculty WHERE name = ?)',
      [date, name]
    )
    const current = rows && rows[0] ? rows[0].status : 'PRESENT'
    if ((current === 'ABSENT') === wantAbsent) return
    await row.click()
    await sleep(300)
  }
  throw new Error(`could not set ${name} to ${wantAbsent ? 'ABSENT' : 'PRESENT'} on ${date}`)
}

async function main() {
  console.log(`demo:verify — driving the real app against ${paths.dbPath}`)
  app = await _electron.launch({
    args: ['.'],
    cwd: ROOT,
    executablePath: require('electron'),
    env: {
      ...process.env,
      NODE_ENV: 'production',
      SUBSTIFLOW_DATA_DIR: paths.demoDir,
      SUBSTIFLOW_DEMO: '1',
    },
  })
  page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  attachPageHandlers(page)

  // --- 1. Demo banner + isolation ------------------------------------------
  await waitText('DEMO DATA', { timeout: 30000 })
  pass('DEMO DATA banner is visible in the app')
  const info = await page.evaluate(() => window.electron.app.getInfo())
  await check(
    info && info.isDemo === true && String(info.dbPath).includes('.substiflow-demo'),
    'app:info reports demo mode with the isolated database path',
    JSON.stringify(info)
  )
  const pill = page.locator('aside').getByText('Demo Data', { exact: true })
  await check(await pill.isVisible().catch(() => false), 'sidebar shows the DEMO DATA badge')
  await shot('01-demo-banner')

  // --- 2. Generation → validation → publish --------------------------------
  await gotoSidebar('Timetable Generation')
  await page.getByRole('button', { name: 'Generate Timetable' }).click()
  await waitText('Draft generated:', { timeout: 90000 })
  pass('real solver produced a draft from the demo fixture')
  await waitText('COMPLETED')
  await page.getByText('Draft Grid', { exact: true }).click()
  await waitText('Monday')
  await waitText('Demo Faculty')
  pass('draft grid shows the demo faculty')
  await shot('02-draft-grid')

  // --- 2b. Rendering + distribution quality of the real draft -------------
  // (a) One clear time label per period: default periods are NAMED after
  //     their own range, so rendering name + startTime–endTime printed the
  //     same label twice in one cell.
  const labelCounts = await page.evaluate(() => {
    const cells = Array.from(
      document.querySelectorAll('[data-testid="draft-grid-scroll"] td.sticky')
    )
    return cells.map((td) => {
      const text = td.textContent || ''
      const m = text.match(/\d{2}:\d{2}/)
      return m ? text.split(m[0]).length - 1 : 0
    })
  })
  await check(
    labelCounts.length > 0 && labelCounts.every((n) => n === 1),
    `every period cell shows exactly one time label (${labelCounts.length} cells)`,
    JSON.stringify(labelCounts)
  )
  // (b) No misleading "Room —" anywhere: lectures are room-independent in
  //     this app and must say so plainly; labs always carry a real room.
  const roomDash = await page.evaluate(
    () => (document.body.innerText.match(/Room —/g) || []).length
  )
  await check(roomDash === 0, 'no entry renders the broken-looking "Room —" label')
  // (c) Distribution: every section touches every teaching period — the
  //     old scheduler crammed all sessions into 09:00–13:00.
  const usage = await sql(
    `SELECT d.section_id AS sid, sec.name AS sname, d.time_slot_id AS tsid, d.span AS span,
            ts."order" AS ord, ts.is_break AS is_break
       FROM draft_timetable_entries d
       JOIN sections sec ON sec.id = d.section_id
       JOIN time_slots ts ON ts.id = d.time_slot_id
      WHERE d.generation_id = (SELECT id FROM timetable_generations ORDER BY created_at DESC LIMIT 1)`
  )
  const teachingOrders = [...new Set(usage.filter((r) => !r.is_break).map((r) => r.ord))].sort(
    (a, b) => a - b
  )
  const bySection = {}
  for (const r of usage) {
    bySection[r.sid] = bySection[r.sid] || { name: r.sname, orders: new Set() }
    for (let i = 0; i < r.span; i++) bySection[r.sid].orders.add(r.ord + i)
  }
  const underused = Object.values(bySection)
    .filter((s) => teachingOrders.some((o) => !s.orders.has(o)))
    .map((s) => s.name)
  await check(
    Object.keys(bySection).length > 0 && underused.length === 0,
    `every section uses every teaching period (afternoon included): ${Object.keys(bySection).length} sections × ${teachingOrders.length} periods`,
    `sections with unused periods: ${JSON.stringify(underused)}`
  )
  const labCount = usage.filter((r) => r.span > 1).length
  const continuations = await page.evaluate(
    () => (document.body.innerText.match(/continues/g) || []).length
  )
  await check(
    labCount >= 4 && continuations >= labCount,
    `${labCount} multi-period labs render as one card each with continuation marks (${continuations})`
  )
  // (d) Horizontal reachability + no page-wide overflow (default window).
  async function gridLayoutMetrics(selector) {
    return page.evaluate((sel) => {
      const el = document.querySelector(sel)
      if (!el) return { missing: true }
      el.scrollLeft = el.scrollWidth
      const ths = Array.from(el.querySelectorAll('thead th'))
      const last = ths[ths.length - 1]
      const box = el.getBoundingClientRect()
      const rect = last ? last.getBoundingClientRect() : null
      const doc = document.documentElement
      return {
        scrollable: el.scrollWidth > el.clientWidth,
        reachedEnd: Math.abs(el.scrollLeft + el.clientWidth - el.scrollWidth) <= 2,
        lastHeaderText: last ? last.textContent : null,
        lastHeaderVisible: rect ? rect.right <= box.right + 1 && rect.left >= box.left - 1 : false,
        pageOverflow: doc.scrollWidth > doc.clientWidth + 1,
      }
    }, selector)
  }
  const layout = await gridLayoutMetrics('[data-testid="draft-grid-scroll"]')
  await check(
    !layout.missing && layout.lastHeaderVisible && !layout.pageOverflow,
    `rightmost section "${layout.lastHeaderText}" reachable in the scroll container; no page-wide overflow`,
    JSON.stringify(layout)
  )
  await shot('02b-draft-grid-rightmost-section')
  // (e) Narrow window: same guarantees, text still readable.
  const origSize = await app.evaluate(({ BrowserWindow }) => {
    const [w, h] = BrowserWindow.getAllWindows()[0].getSize()
    return { w, h }
  })
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].setSize(860, 720)
  })
  await page.waitForTimeout(500)
  const narrow = await gridLayoutMetrics('[data-testid="draft-grid-scroll"]')
  await check(
    !narrow.missing && narrow.lastHeaderVisible && !narrow.pageOverflow,
    'narrow window (860×720): every section still reachable, no page-wide overflow',
    JSON.stringify(narrow)
  )
  await shot('02c-draft-grid-narrow-window')
  await app.evaluate(({ BrowserWindow }, size) => {
    BrowserWindow.getAllWindows()[0].setSize(size.w, size.h)
  }, origSize)
  await page.waitForTimeout(300)

  await page.getByRole('button', { name: 'Validate Draft' }).click()
  await waitText('Validation passed')
  pass('independent draft validation passed')
  await shot('02d-validation-results')
  await page.getByRole('button', { name: 'Publish', exact: true }).click()
  await waitText('Publish this draft as the master timetable?')
  await page.getByRole('dialog').getByRole('button', { name: 'Publish', exact: true }).click()
  await waitText('session(s) to the master timetable', { timeout: 30000 })
  const masterCount = (await sql('SELECT COUNT(*) AS c FROM timetable_entries'))[0].c
  const masterOccupiedPeriods = (await sql('SELECT COALESCE(SUM(span), 0) AS c FROM timetable_entries'))[0].c
  await check(masterCount === 124, `publish wrote ${masterCount} timetable sessions (expected 124)`)
  await check(
    masterOccupiedPeriods === 140,
    `published timetable occupies ${masterOccupiedPeriods} periods across spans (expected 140)`,
    'A two-period lab is one session but contributes two occupied periods.'
  )
  const teamRows = await sql(
    `SELECT te.id FROM timetable_entries te
       JOIN subjects s ON s.id = te.subject_id
      WHERE s.code = '24BCA51'
        AND (SELECT COUNT(*) FROM timetable_entry_faculty f WHERE f.entry_id = te.id) = 2`
  )
  await check(teamRows.length >= 2, `TEAM teaching visible: ${teamRows.length} ML & NN sessions list both teachers`)
  await gotoSidebar('Master Timetable')
  await waitText('Master Timetable')
  await page.locator('div[title="DMS"]').first().waitFor({ timeout: 15000 })
  pass('master timetable page renders the published demo entries')
  await shot('03-master-timetable')

  // Master grid: same horizontal guarantees + representative section week.
  const master = await page.evaluate(() => {
    const grid = document.querySelector('[data-testid="master-grid"]')
    const scroller = grid ? grid.closest('.overflow-auto') : null
    if (!scroller) return { missing: true }
    scroller.scrollLeft = scroller.scrollWidth
    const doc = document.documentElement
    return {
      scrollable: scroller.scrollWidth > scroller.clientWidth,
      reachedEnd:
        Math.abs(scroller.scrollLeft + scroller.clientWidth - scroller.scrollWidth) <= 2,
      pageOverflow: doc.scrollWidth > doc.clientWidth + 1,
    }
  })
  await check(
    !master.missing && !master.pageOverflow && (!master.scrollable || master.reachedEnd),
    'master timetable: grid reaches its right edge (or fits), no page-wide overflow',
    JSON.stringify(master)
  )
  await shot('03c-master-timetable-rightmost')
  const firstSection = (await sql('SELECT id FROM sections ORDER BY semester, name LIMIT 1'))[0]
  if (firstSection) {
    await page.locator('[data-testid="filter-section"]').selectOption(firstSection.id)
    await page.waitForTimeout(500)
    await shot('03b-representative-section-week')
    pass('section filter renders a representative section weekly schedule')
    // Reset to "All Sections" — index 0 is the disabled placeholder, which
    // shares the empty value but cannot be selected.
    await page.locator('[data-testid="filter-section"]').selectOption({ index: 1 })
    await page.waitForTimeout(300)
  }

  // --- 3. Scenario A: one teacher absent → covered plan → approve ----------
  const pick = (
    await sql(
      `SELECT te.day_of_week AS dow, tef.faculty_id AS fid, f.name AS fname, COUNT(*) AS c
         FROM timetable_entries te
         JOIN timetable_entry_faculty tef ON tef.entry_id = te.id
         JOIN faculty f ON f.id = tef.faculty_id
        WHERE f.staff_type = 'TEACHING'
          AND (SELECT COUNT(*) FROM timetable_entry_faculty x WHERE x.entry_id = te.id) = 1
        GROUP BY te.day_of_week, tef.faculty_id
        ORDER BY c DESC, f.name
        LIMIT 1`
    )
  )[0]
  if (!pick) throw new Error('no sole-teacher published entries found — cannot run scenario A')
  const date = nextDateForWeekday(pick.dow)
  console.log(`  scenario date: ${date} (${pick.dow}), absent teacher: ${pick.fname} (${pick.c} classes)`)

  await gotoSidebar("Today's Attendance")
  await page.locator('input[type="date"]').fill(date)
  await setFacultyAbsent(pick.fname, date, true)
  pass(`${pick.fname} marked ABSENT through the attendance page for ${date}`)

  await gotoSidebar('Substitution Planner')
  await page.locator('input[type="date"]').fill(date)
  await withAcceptedDialogs(() => page.getByRole('button', { name: 'Generate Plan' }).click())
  await page.getByTestId('lifecycle-status').waitFor({ timeout: 15000 })
  await waitText('Affected Classes')
  const assignments = await sql(
    `SELECT a.substitute_faculty_id AS sub, a.original_entry_id AS entry,
            o.day_of_week AS dow, o.time_slot_id AS slot
       FROM substitution_assignments a
       JOIN substitution_runs r ON r.id = a.run_id
       JOIN timetable_entries o ON o.id = a.original_entry_id
      WHERE r.date = ? AND a.substitute_faculty_id IS NOT NULL`,
    [date]
  )
  await check(assignments.length >= 1, `scenario A: plan covers ${assignments.length} class(es)`)

  // Independent eligibility verification (not reusing engine code):
  let eligible = true
  for (const a of assignments) {
    const staff = (await sql('SELECT staff_type FROM faculty WHERE id = ?', [a.sub]))[0]
    if (!staff || staff.staff_type !== 'TEACHING') {
      eligible = false
      fail(`substitute ${a.sub} is not TEACHING staff`)
      continue
    }
    const absent = (
      await sql(
        "SELECT COUNT(*) AS c FROM attendance WHERE date = ? AND faculty_id = ? AND status = 'ABSENT'",
        [date, a.sub]
      )
    )[0].c
    const busy = (
      await sql(
        `SELECT COUNT(*) AS c FROM timetable_entries te
           JOIN timetable_entry_faculty tef ON tef.entry_id = te.id
          WHERE tef.faculty_id = ? AND te.day_of_week = ? AND te.time_slot_id = ? AND te.id <> ?`,
        [a.sub, a.dow, a.slot, a.entry]
      )
    )[0].c
    const capped = await sql(
      `SELECT (SELECT a2.substitute_faculty_id FROM substitution_assignments a2
                 JOIN substitution_runs r2 ON r2.id = a2.run_id
                WHERE r2.date = ? AND a2.substitute_faculty_id = ?) AS sub,
              (SELECT max_daily_substitutions FROM faculty WHERE id = ?) AS fac_cap`,
      [date, a.sub, a.sub]
    )
    const dailyCount = (
      await sql(
        `SELECT COUNT(*) AS c FROM substitution_assignments a2
           JOIN substitution_runs r2 ON r2.id = a2.run_id
          WHERE r2.date = ? AND a2.substitute_faculty_id = ?`,
        [date, a.sub]
      )
    )[0].c
    const facCap = capped && capped[0] && capped[0].fac_cap != null ? capped[0].fac_cap : 2
    if (absent > 0 || busy > 0 || dailyCount > Math.min(facCap, 2)) {
      eligible = false
      fail(
        `substitute eligibility violated for ${a.sub}`,
        `absent=${absent} busy=${busy} daily=${dailyCount} cap=${facCap}`
      )
    }
  }
  if (eligible) pass('every substitute is teaching staff, present, free at the slot and within the daily cap')
  await shot('04-plan-covered')

  await page.getByRole('button', { name: 'Approve Plan' }).click()
  await waitText('APPROVED')
  const runA = (await sql('SELECT status FROM substitution_runs WHERE date = ?', [date]))[0]
  await check(runA && runA.status === 'APPROVED', 'scenario A run is APPROVED')
  await page.getByText('Open Full Timetable').click()
  await waitText('Revised Timetable')
  pass('revised timetable page renders the approved substitutions')
  await shot('05-revised-timetable')

  // --- 4. Scenario B: nobody available → uncovered, never silently assigned -
  await gotoSidebar("Today's Attendance")
  await page.locator('input[type="date"]').fill(date)
  const teaching = await sql("SELECT name FROM faculty WHERE staff_type = 'TEACHING' ORDER BY employee_id")
  for (const f of teaching) await setFacultyAbsent(f.name, date, true)
  pass(`scenario B: all ${teaching.length} teaching staff marked ABSENT for ${date}`)

  await gotoSidebar('Substitution Planner')
  await page.locator('input[type="date"]').fill(date)
  await withAcceptedDialogs(() => page.getByRole('button', { name: 'Generate Plan' }).click())
  await page.getByTestId('lifecycle-status').waitFor({ timeout: 15000 })
  await waitText('Approve Anyway', { timeout: 20000 })
  const coveredB = (
    await sql(
      `SELECT COUNT(*) AS c FROM substitution_assignments a
         JOIN substitution_runs r ON r.id = a.run_id
        WHERE r.date = ? AND a.substitute_faculty_id IS NOT NULL`,
      [date]
    )
  )[0].c
  const uncoveredB = (
    await sql(
      `SELECT COUNT(*) AS c FROM substitution_assignments a
         JOIN substitution_runs r ON r.id = a.run_id
        WHERE r.date = ? AND a.substitute_faculty_id IS NULL`,
      [date]
    )
  )[0].c
  await check(coveredB === 0, `scenario B: no class silently assigned (covered=${coveredB})`)
  await check(uncoveredB > 0, `scenario B: ${uncoveredB} class(es) reported as uncovered`)
  await shot('06-plan-uncovered')

  let confirmMessage = null
  const recordDialog = (d) => {
    confirmMessage = d.message()
  }
  page.on('dialog', recordDialog)
  await withAcceptedDialogs(() => page.getByRole('button', { name: /Approve Anyway/ }).click())
  page.off('dialog', recordDialog)
  await waitText('APPROVED', { timeout: 15000 })
  await check(
    !!confirmMessage && /uncovered/i.test(confirmMessage),
    'approving with uncovered classes requires a confirmation naming them',
    JSON.stringify(confirmMessage)
  )
  const runB = (await sql('SELECT status FROM substitution_runs WHERE date = ?', [date]))[0]
  await check(runB && runB.status === 'APPROVED', 'scenario B run is APPROVED after confirming')

  // --- 5. Restore attendance to PRESENT ------------------------------------
  await gotoSidebar("Today's Attendance")
  await page.locator('input[type="date"]').fill(date)
  for (const f of teaching) await setFacultyAbsent(f.name, date, false)
  const stillAbsent = (
    await sql("SELECT COUNT(*) AS c FROM attendance WHERE date = ? AND status = 'ABSENT'", [date])
  )[0].c
  await check(stillAbsent === 0, 'attendance restored to PRESENT for everyone')
  console.log(
    `  note: the published timetable is kept; the ${date} substitution run remains as the scenario-B artifact (npm run demo:reset starts over).`
  )
}

main()
  .then(async () => {
    if (app) await app.close().catch(() => {})
    try {
      execSync('node scripts/ensure-abi.js node', { cwd: ROOT, stdio: 'inherit' })
    } catch {
      /* best-effort ABI restore */
    }
    console.log(`\ndemo:verify: ${checks} passed, ${failures.length} failed${pageErrors.length ? `, ${pageErrors.length} page error(s)` : ''}`)
    process.exit(failures.length > 0 || pageErrors.length > 0 ? 1 : 0)
  })
  .catch(async (err) => {
    console.error('demo:verify failed:', err && err.stack ? err.stack : err)
    if (app) await app.close().catch(() => {})
    process.exit(1)
  })
