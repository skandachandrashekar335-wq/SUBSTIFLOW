/**
 * Keeps `better-sqlite3` compiled for the right ABI *and* the right platform.
 *
 * The same dependency has to serve three situations:
 *   - Node / host          → Vitest (unit tests)
 *   - Electron / host      → the desktop app and `scripts/cli.js`
 *   - Electron / win32-x64 → what gets packed into the Windows installer
 *
 * Only one native binary can exist at a time, so each entry point declares the
 * target it needs and a stamp records what is currently in place. Switching is
 * a no-op when the stamp already matches.
 *
 * Cross-building the Windows binary from macOS/Linux is possible because
 * better-sqlite3 publishes prebuilt artifacts for every supported Electron ABI.
 *
 *   node scripts/ensure-abi.js node
 *   node scripts/ensure-abi.js electron
 *   node scripts/ensure-abi.js win32
 */
const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')

const root = path.join(__dirname, '..')
const stampFile = path.join(root, 'node_modules', '.substiflow-abi-stamp')
const nativeModuleDir = path.join(root, 'node_modules', 'better-sqlite3')
const target = process.argv[2]

const VALID = ['node', 'electron', 'win32']
if (!VALID.includes(target)) {
  console.error(`usage: node scripts/ensure-abi.js <${VALID.join('|')}>`)
  process.exit(2)
}

function run(cmd, args, opts = {}) {
  return spawnSync(cmd, args, {
    stdio: 'inherit',
    cwd: root,
    shell: process.platform === 'win32',
    ...opts,
  })
}

function electronVersion() {
  return require(path.join(root, 'node_modules', 'electron', 'package.json')).version
}

function desiredStamp() {
  if (target === 'node') return `node@${process.version}:${process.platform}-${process.arch}`
  const version = electronVersion()
  if (target === 'win32') return `electron@${version}:win32-x64`
  return `electron@${version}:${process.platform}-${process.arch}`
}

const wanted = desiredStamp()
const current = fs.existsSync(stampFile) ? fs.readFileSync(stampFile, 'utf-8').trim() : ''
if (current === wanted) {
  process.exit(0)
}

console.log(`[ensure-abi] preparing better-sqlite3 for ${wanted} (was: ${current || 'unknown'})`)

let ok = false
let hint = ''

if (target === 'win32') {
  // Download the published win32-x64 prebuild for our Electron ABI.
  const prebuild = path.join(root, 'node_modules', '.bin', 'prebuild-install')
  const result = run(
    prebuild,
    ['--runtime=electron', `--target=${electronVersion()}`, '--arch=x64', '--platform=win32'],
    { cwd: nativeModuleDir },
  )
  ok = result.status === 0
  hint =
    '  cd node_modules/better-sqlite3 && npx prebuild-install ' +
    '--runtime=electron --target=<electron version> --arch=x64 --platform=win32'
} else if (target === 'node') {
  // `npm rebuild` runs the package's own install script, which prefers the
  // published host prebuild and only compiles as a fallback.
  ok = run('npm', ['rebuild', 'better-sqlite3']).status === 0
  hint = '  npm rebuild better-sqlite3'
} else {
  ok = run('npx', ['electron-rebuild', '-f', '-w', 'better-sqlite3']).status === 0
  hint = '  npx electron-rebuild -f -w better-sqlite3'
}

if (!ok) {
  console.error('[ensure-abi] failed to prepare better-sqlite3.')
  console.error(hint)
  process.exit(1)
}

fs.writeFileSync(stampFile, wanted)
console.log(`[ensure-abi] ready: ${wanted}`)
