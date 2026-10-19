/**
 * Launches the REAL SubstiFlow app (built renderer + main process) against
 * the isolated demo database:
 *
 *   npm run demo:launch
 *
 * The app is started with
 *   SUBSTIFLOW_DATA_DIR=<repo>/.substiflow-demo   (its own database + profile)
 *   SUBSTIFLOW_DEMO=1                             (turns on the DEMO DATA banner)
 *   NODE_ENV=production                           (serves the built renderer)
 * so it can never read or write the production profile in
 * ~/Library/Application Support/SubstiFlow. An ambient SUBSTIFLOW_DATA_DIR is
 * overridden and reported.
 *
 * The npm pre-hook (ensure-abi electron) guarantees the native module ABI;
 * after the app exits the node ABI is restored so `npm test` keeps working.
 */
const path = require('path')
const fs = require('fs')
const { spawn, execSync } = require('child_process')

const ROOT = path.resolve(__dirname, '..', '..')
const forceBuild = process.argv.includes('--build')

function buildIfMissing() {
  const mainBuilt = fs.existsSync(path.join(ROOT, 'dist', 'main', 'electron', 'main.js'))
  const rendererBuilt = fs.existsSync(path.join(ROOT, 'dist', 'renderer', 'index.html'))
  if (forceBuild || !mainBuilt || !rendererBuilt) {
    if (!forceBuild) {
      console.log('demo: build output missing — running npm run build first (use --build to force a rebuild).')
    }
    execSync('npm run build', { cwd: ROOT, stdio: 'inherit' })
  }
}

buildIfMissing()

const { resolveDemoPaths, assertSafeDemoPaths } = require(path.join(
  ROOT,
  'dist',
  'main',
  'src',
  'db',
  'demoPaths'
))
const paths = resolveDemoPaths(ROOT)
assertSafeDemoPaths(paths)

if (!fs.existsSync(paths.dbPath)) {
  console.error(
    `demo: no demo database at ${paths.dbPath}.\nRun: npm run demo:setup`
  )
  process.exit(1)
}

if (process.env.SUBSTIFLOW_DATA_DIR) {
  const ambient = path.resolve(process.env.SUBSTIFLOW_DATA_DIR)
  if (ambient !== paths.demoDir) {
    console.warn(`demo: ignoring ambient SUBSTIFLOW_DATA_DIR=${ambient} — launching with ${paths.demoDir}.`)
  }
}

const electronBin = require('electron')
const env = {
  ...process.env,
  NODE_ENV: 'production',
  SUBSTIFLOW_DATA_DIR: paths.demoDir,
  SUBSTIFLOW_DEMO: '1',
}
delete env.VITE_DEV_SERVER_URL

console.log('DEMO DATA — launching the real app against the isolated demo database')
console.log(`  demo data dir : ${paths.demoDir}`)
console.log(`  demo database : ${paths.dbPath}`)

const child = spawn(electronBin, ['.'], { cwd: ROOT, env, stdio: 'inherit' })
const pidFile = path.join(paths.demoDir, 'app.pid')
try {
  fs.writeFileSync(pidFile, String(child.pid))
} catch {
  /* the pidfile is best-effort; the app lock is the authoritative guard */
}

child.on('exit', (code, signal) => {
  try {
    if (fs.existsSync(pidFile)) fs.unlinkSync(pidFile)
  } catch {
    /* ignore */
  }
  // Restore the node ABI (same convention as the e2e harness) so a following
  // `npm test` does not have to rebuild first.
  try {
    execSync('node scripts/ensure-abi.js node', { cwd: ROOT, stdio: 'inherit' })
  } catch {
    /* ABI restore is best-effort; pretest would fix it anyway */
  }
  console.log(
    `demo: app exited (${signal ? `signal ${signal}` : `code ${code}`}). Demo data kept at ${paths.demoDir} (npm run demo:reset / demo:remove to reset or remove it).`
  )
  process.exit(code == null ? 0 : code)
})
