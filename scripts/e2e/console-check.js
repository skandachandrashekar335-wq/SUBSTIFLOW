#!/usr/bin/env node
/**
 * Dev-console regression check for the Dashboard "duplicate React keys"
 * report (legacy `audit_log` rows written by an old build have a NULL id, and
 * the Recent Activity list keys on `audit_log.id`).
 *
 * React's key warnings only exist in DEVELOPMENT builds — the production
 * renderer bundle strips them — so `npm run e2e` can never observe them. This
 * script therefore reproduces the exact `npm run dev` environment (Vite dev
 * server + Electron with NODE_ENV=development) against an isolated database:
 *
 *   1. run the first-run wizard (real UI, fresh QA database),
 *   2. inject three legacy audit rows WITHOUT an id (the reported data shape),
 *   3. open the Dashboard and capture everything React logs,
 *   4. report any key-related warnings.
 *
 * Exit codes: 0 = no key warnings, 1 = key warning(s) captured,
 *             2 = could not run (e.g. port 5173 already in use).
 *
 * Usage: node scripts/e2e/console-check.js
 */
const { spawn, execSync } = require('child_process')
const http = require('http')
const net = require('net')
const os = require('os')
const path = require('path')
const { _electron } = require('playwright')

const ROOT = path.resolve(__dirname, '..', '..')
const PORT = 5173 // main.ts only allows the default dev origin in dev mode
const DEV_URL = `http://localhost:${PORT}`
const DATA_DIR = path.join(os.tmpdir(), `substiflow-console-${Date.now()}`)

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function sh(cmd) {
  try {
    execSync(cmd, { cwd: ROOT, stdio: ['ignore', 'inherit', 'inherit'] })
    return true
  } catch (e) {
    return false
  }
}

function portFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer()
    srv.once('error', () => resolve(false))
    srv.once('listening', () => srv.close(() => resolve(true)))
    srv.listen(port, '127.0.0.1')
  })
}

function serverUp(url, timeoutMs) {
  const start = Date.now()
  return new Promise((resolve) => {
    const attempt = () => {
      const req = http.get(url, (res) => {
        res.resume()
        resolve(true)
      })
      req.on('error', () => {
        if (Date.now() - start > timeoutMs) resolve(false)
        else setTimeout(attempt, 400)
      })
      req.setTimeout(2000, () => {
        req.destroy()
        if (Date.now() - start > timeoutMs) resolve(false)
        else setTimeout(attempt, 400)
      })
    }
    attempt()
  })
}

/**
 * The app's renderer window. In dev mode a detached DevTools window opens
 * alongside the main window and `firstWindow()` may return either one, so
 * poll every window until one has an http(s) URL (the renderer).
 */
async function pickAppWindow(app, timeoutMs = 30000) {
  const start = Date.now()
  for (;;) {
    for (const win of app.windows()) {
      const url = win.url()
      if (url.startsWith('http://') || url.startsWith('https://')) return win
    }
    if (Date.now() - start > timeoutMs) {
      throw new Error(`no app renderer window appeared within ${timeoutMs}ms`)
    }
    await sleep(300)
  }
}

async function main() {
  console.log('SubstiFlow dev-console check (Dashboard duplicate React keys)')

  if (!(await portFree(PORT))) {
    console.error(`Port ${PORT} is busy — stop any running dev server and retry.`)
    process.exit(2)
  }

  // Electron's ABI + compiled main/preload (the renderer comes from Vite dev).
  sh('node scripts/ensure-abi.js electron')
  execSync('npm run build:electron', { cwd: ROOT, stdio: 'inherit' })

  console.log(`Starting Vite dev server on ${DEV_URL} ...`)
  const vite = spawn('node', ['node_modules/vite/bin/vite.js', '--port', String(PORT), '--strictPort'], {
    cwd: ROOT,
    stdio: ['ignore', 'inherit', 'inherit'],
    env: process.env,
  })
  let app = null
  let exitCode = 1
  const consoleLines = []
  const pageErrors = []
  try {
    if (!(await serverUp(DEV_URL, 30000))) throw new Error('Vite dev server did not come up')

    app = await _electron.launch({
      args: ['.'],
      cwd: ROOT,
      executablePath: require('electron'),
      env: {
        ...process.env,
        NODE_ENV: 'development',
        VITE_DEV_SERVER_URL: DEV_URL,
        SUBSTIFLOW_DATA_DIR: DATA_DIR,
      },
    })
    // Main-process diagnostics: migration failures, load failures and
    // renderer crashes all surface here — the page console alone cannot
    // explain a window that closes itself.
    const proc = app.process()
    proc.stdout.on('data', (d) => console.log(`[main] ${String(d).trimEnd().slice(0, 400)}`))
    proc.stderr.on('data', (d) => console.log(`[main:err] ${String(d).trimEnd().slice(0, 400)}`))
    proc.on('exit', (code, signal) => console.log(`[main] exited code=${code} signal=${signal}`))
    // In dev mode main.ts opens a DETACHED DevTools window, which can win the
    // firstWindow() race — pick the window that is actually the app renderer.
    const page = await pickAppWindow(app)
    page.on('close', () => console.log('[main] app window closed'))
    await page.waitForLoadState('domcontentloaded')

    page.on('console', (msg) => consoleLines.push(msg.text()))
    page.on('pageerror', (err) => pageErrors.push(String(err)))
    page.on('dialog', async (d) => {
      try {
        await d.dismiss()
      } catch (e) {
        /* already gone */
      }
    })

    // --- First-run wizard (identical steps to the e2e journeys) ---
    // 60s: the FIRST Vite dev boot must pre-bundle dependencies (cold .vite
    // cache), which can take a while — the renderer is blank until then.
    await page.getByRole('button', { name: 'Next' }).waitFor({ timeout: 60000 })
    await page.getByRole('button', { name: 'Next' }).click() // welcome
    await page.getByLabel('Institution Name').fill('Console QA College')
    await page.getByLabel('Address').fill('1 Test Lane')
    await page.getByRole('button', { name: 'Next' }).click()
    await page.getByLabel('Year Name').fill('2026-2027')
    await page.getByLabel('Start Date').fill('2026-06-01')
    await page.getByLabel('End Date').fill('2027-05-31')
    await page.getByRole('button', { name: 'Next' }).click()
    await page.getByLabel('Start Time').waitFor()
    await page.getByRole('button', { name: 'Next' }).click()
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
    await page.getByRole('link', { name: 'Dashboard', exact: true }).waitFor({ timeout: 20000 })
    console.log('  wizard completed (isolated QA database)')

    // --- Inject legacy audit rows exactly as the old build wrote them: no id ---
    const nowIso = new Date().toISOString()
    for (let i = 0; i < 3; i++) {
      const result = await page.evaluate(
        ({ statement, params }) => window.electron.db.runSync(statement, params),
        {
          statement: `INSERT INTO audit_log (action, entity_type, detail, created_at, updated_at)
                      VALUES ('timetable.deleted', 'timetable_entry', 'Legacy audit row', ?, ?)`,
          params: [nowIso, nowIso],
        }
      )
      if (result && result.error) throw new Error(`inject failed: ${result.error}`)
    }
    const nulls = await page.evaluate(
      () => window.electron.db.allSync('SELECT COUNT(*) AS c FROM audit_log WHERE id IS NULL', []).data
    )
    console.log(`  injected legacy rows: ${nulls[0].c} with NULL id`)

    // --- Dashboard: this is where the duplicate-key warnings appeared ---
    // Navigate AWAY first: after the wizard the app already sits on the
    // Dashboard (mounted before the injection), and React Router does not
    // remount on a same-route click — so without this hop the Recent
    // Activity list would never refetch the injected rows.
    await page.getByRole('link', { name: 'Reports', exact: true }).click()
    await page.getByRole('link', { name: 'Dashboard', exact: true }).click()
    await page
      .locator('div[title="Legacy audit row"]')
      .first()
      .waitFor({ timeout: 15000 })
    const rendered = await page.locator('div[title="Legacy audit row"]').count()
    console.log(`  Dashboard rendered ${rendered} legacy row(s)`)
    await sleep(1500) // flush any buffered console output

    const keyWarnings = consoleLines.filter(
      (line) => /\bkey\b/i.test(line) && /(same|duplicate|unique|missing)/i.test(line)
    )
    console.log(`\n  console messages captured: ${consoleLines.length}`)
    if (keyWarnings.length > 0) {
      console.log(`  KEY WARNINGS CAPTURED (${keyWarnings.length}):`)
      for (const w of keyWarnings) console.log(`    ${w}`)
      console.log('\nRESULT: FAIL — React still reports key problems on the Dashboard')
      exitCode = 1
    } else {
      console.log('  no React key warnings on the Dashboard')
      console.log('\nRESULT: PASS — duplicate-key warnings are gone')
      exitCode = 0
    }
    if (pageErrors.length > 0) {
      console.log(`  page errors: ${pageErrors.length}`)
      for (const e of pageErrors) console.log(`    ${e}`)
      exitCode = 1
    }
  } catch (error) {
    console.error('console-check failed:', error && error.message ? error.message : error)
    if (consoleLines.length > 0) {
      console.log('  console output (last 30 lines):')
      for (const line of consoleLines.slice(-30)) console.log(`    ${String(line).slice(0, 300)}`)
    }
    if (pageErrors.length > 0) {
      console.log('  page errors:')
      for (const e of pageErrors) console.log(`    ${String(e).slice(0, 500)}`)
    }
    exitCode = 1
  } finally {
    try {
      if (app) await app.close()
    } catch (e) {
      /* already closed */
    }
    vite.kill('SIGTERM')
    sh('node scripts/ensure-abi.js node')
  }
  process.exit(exitCode)
}

main().catch((error) => {
  console.error('console-check crashed:', error)
  process.exit(1)
})
