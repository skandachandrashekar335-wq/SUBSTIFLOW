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
  return spawnSync(process.platform === 'win32' ? `"${cmd}"` : cmd, args, {
    stdio: 'inherit',
    cwd: root,
    shell: process.platform === 'win32',
    ...opts,
  })
}

const nativeBinary = path.join(nativeModuleDir, 'build', 'Release', 'better_sqlite3.node')

/** Platform token of a stamp (`electron@31.7.7:win32-x64` → `win32`). */
function stampPlatform(stamp) {
  return stamp.split(':').pop().split('-')[0]
}

/**
 * The stamp on its own is content-blind: it records what was REQUESTED, not
 * what is ON DISK. A stale stamp (e.g. after `npm rebuild` re-extracted a
 * host build) would otherwise short-circuit straight into the Windows
 * installer and crash on first launch. Read the binary's magic bytes and
 * confirm they are actually the platform the stamp claims.
 */
function binaryMatchesPlatform(platform) {
  if (!fs.existsSync(nativeBinary)) return false
  const fd = fs.openSync(nativeBinary, 'r')
  try {
    const header = Buffer.alloc(4)
    fs.readSync(fd, header, 0, 4, 0)
    if (platform === 'win32') return header[0] === 0x4d && header[1] === 0x5a // "MZ" (PE)
    if (platform === 'linux') return header[0] === 0x7f && header[1] === 0x45 && header[2] === 0x4c && header[3] === 0x46 // ELF
    const magic = header.readUInt32LE(0) // Mach-O 32/64 LE/BE + universal fat
    return [0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe].includes(magic)
  } finally {
    fs.closeSync(fd)
  }
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
if (current === wanted && binaryMatchesPlatform(stampPlatform(wanted))) {
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
  // Prefer the published host prebuild so Windows CI does not need a native
  // compiler just to switch back from Electron's ABI for Vitest. Compile only
  // as a fallback. When called from an npm script, use npm's own execpath so a
  // local `.bin/npm` shim cannot shadow the Node-distributed npm installation.
  const prebuild = path.join(root, 'node_modules', '.bin', 'prebuild-install')
  const prebuildResult = run(
    prebuild,
    ['--runtime=node', `--arch=${process.arch}`, `--platform=${process.platform}`],
    { cwd: nativeModuleDir },
  )
  ok = prebuildResult.status === 0 && binaryMatchesPlatform(stampPlatform(wanted))
  if (!ok) {
    const npmExecPath = process.env.npm_execpath
    ok = npmExecPath
      ? run(process.execPath, [npmExecPath, 'rebuild', 'better-sqlite3']).status === 0
      : run('npm', ['rebuild', 'better-sqlite3']).status === 0
  }
  hint = '  npm rebuild better-sqlite3'
} else {
  // Prefer the published Electron prebuild. This avoids requiring a native
  // compiler on clean Windows runners where Visual Studio may be installed
  // under a newer major that node-gyp does not recognise. Keep
  // electron-rebuild as the fallback for a platform/ABI without a prebuild.
  const prebuild = path.join(root, 'node_modules', '.bin', 'prebuild-install')
  const prebuildResult = run(
    prebuild,
    [
      '--runtime=electron',
      `--target=${electronVersion()}`,
      `--arch=${process.arch}`,
      `--platform=${process.platform}`,
    ],
    { cwd: nativeModuleDir },
  )
  ok = prebuildResult.status === 0 && binaryMatchesPlatform(stampPlatform(wanted))
  if (!ok) {
    ok = run('npx', ['electron-rebuild', '-f', '-w', 'better-sqlite3']).status === 0
  }
  hint = '  npx electron-rebuild -f -w better-sqlite3'
}

// A zero exit code is not proof the right binary landed (a prebuild download
// can "succeed" without extracting). Never write a stamp the file on disk
// does not back.
if (ok && !binaryMatchesPlatform(stampPlatform(wanted))) {
  ok = false
}

if (!ok) {
  console.error('[ensure-abi] failed to prepare better-sqlite3.')
  console.error(hint)
  process.exit(1)
}

fs.writeFileSync(stampFile, wanted)
console.log(`[ensure-abi] ready: ${wanted}`)
