/**
 * npm postinstall hook.
 *
 * 1. Makes sure the Electron runtime is fully downloaded.
 * 2. On macOS, applies an ad-hoc code signature — some macOS versions refuse to
 *    run (and then silently delete) app bundles whose signature is missing or
 *    invalid, which is what a freshly extracted Electron.app can look like.
 * 3. Rebuilds native modules (`better-sqlite3`) against Electron's headers so
 *    the ABI matches. Guarded by a stamp so it only runs when needed.
 *
 * Safe to run repeatedly; `npm run postinstall` re-applies everything.
 */
const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')

const root = path.join(__dirname, '..')
const electronDir = path.join(root, 'node_modules', 'electron')
const appBundle = path.join(electronDir, 'dist', 'Electron.app')
const macBinary = path.join(appBundle, 'Contents', 'MacOS', 'Electron')

function run(cmd, args) {
  return spawnSync(cmd, args, { stdio: 'inherit', cwd: root })
}

function electronVersion() {
  try {
    return require(path.join(electronDir, 'package.json')).version
  } catch {
    return null
  }
}

// 1. Runtime ---------------------------------------------------------------
if (fs.existsSync(path.join(electronDir, 'install.js'))) {
  if (!fs.existsSync(macBinary)) {
    console.log('[postinstall] downloading Electron runtime...')
    const result = run(process.execPath, [path.join(electronDir, 'install.js')])
    if (result.status !== 0) {
      console.warn('[postinstall] Electron download failed; run manually:')
      console.warn('  node node_modules/electron/install.js')
    }
  }

  // 2. Ad-hoc signature (macOS) ---------------------------------------------
  if (process.platform === 'darwin' && fs.existsSync(appBundle)) {
    console.log('[postinstall] applying ad-hoc signature to Electron.app...')
    const result = run('codesign', ['--force', '--deep', '--sign', '-', appBundle])
    if (result.status !== 0) {
      console.warn('[postinstall] codesign failed; run manually:')
      console.warn(`  codesign --force --deep --sign - "${appBundle}"`)
    }
  }
}

// 3. Native modules ---------------------------------------------------------
//    The app runs on Electron's ABI; tests switch back to Node on demand.
const version = electronVersion()
if (version && fs.existsSync(path.join(root, 'scripts', 'ensure-abi.js'))) {
  const result = run(process.execPath, [path.join(root, 'scripts', 'ensure-abi.js'), 'electron'])
  if (result.status !== 0) {
    console.warn('[postinstall] native rebuild failed; run manually:')
    console.warn('  node scripts/ensure-abi.js electron')
  }
}
