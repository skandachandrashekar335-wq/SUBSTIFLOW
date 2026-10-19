/**
 * Demo-environment path resolution and safety guards.
 *
 * The demo NEVER touches the production profile: every demo command resolves
 * one canonical location (`.substiflow-demo/` inside the repository root) and
 * this module is the single place that computes and validates it. It contains
 * no Electron imports so it can be
 *   - required by the CLI scripts (compiled to `dist/main/src/db/demoPaths.js`),
 *   - imported directly by the vitest suite (`@/db/demoPaths`),
 * meaning scripts and tests share exactly one definition of "where the demo
 * database lives" and cannot drift apart.
 *
 * Every destructive demo operation (setup reset, remove) must call
 * `assertSafeDemoPaths` BEFORE touching the filesystem, and `demo:remove`
 * must additionally call `assertRemovableDemoDir`, which only accepts a
 * directory carrying the marker file written by `demo:setup`.
 */
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

/** Directory name of the isolated demo data dir (inside the repository root). */
export const DEMO_DIR_NAME = '.substiflow-demo'

/** Marker file proving a directory was created by `demo:setup`. */
export const DEMO_MARKER_FILE = '.substiflow-demo-root'

export interface DemoPaths {
  /** Absolute repository root the demo is anchored to. */
  rootDir: string
  /** Absolute demo data directory (this value goes into SUBSTIFLOW_DATA_DIR). */
  demoDir: string
  /** Absolute path of the demo SQLite database inside the demo directory. */
  dbPath: string
  /** Absolute path of the setup marker file inside the demo directory. */
  markerPath: string
}

/** Resolve the canonical demo paths for a repository root. Pure function. */
export function resolveDemoPaths(rootDir: string): DemoPaths {
  const root = path.resolve(rootDir)
  const demoDir = path.join(root, DEMO_DIR_NAME)
  return {
    rootDir: root,
    demoDir,
    dbPath: path.join(demoDir, 'database', 'substiflow.db'),
    markerPath: path.join(demoDir, DEMO_MARKER_FILE),
  }
}

/**
 * The data directory the ordinary (production) app profile uses on this
 * platform. Mirrors Electron's userData resolution for the app name
 * "SubstiFlow": macOS `~/Library/Application Support/SubstiFlow`, Windows
 * `%APPDATA%\SubstiFlow`, Linux `$XDG_CONFIG_HOME/SubstiFlow`.
 * This path — and anything containing it — is never a valid demo location.
 */
export function productionDataDir(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  home: string = os.homedir()
): string {
  if (platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', 'SubstiFlow')
  }
  if (platform === 'win32') {
    const appData = env.APPDATA
    if (appData && appData.length > 0) return path.join(appData, 'SubstiFlow')
    return path.join(home, 'AppData', 'Roaming', 'SubstiFlow')
  }
  const xdg = env.XDG_CONFIG_HOME
  return path.join(xdg && xdg.length > 0 ? xdg : path.join(home, '.config'), 'SubstiFlow')
}

/** True when `child` is `parent` itself or lives inside it. Pure function. */
export function isInside(child: string, parent: string): boolean {
  const rel = path.relative(path.resolve(parent), path.resolve(child))
  if (rel === '') return true
  if (rel === '..' || rel.startsWith(`..${path.sep}`)) return false
  return !path.isAbsolute(rel)
}

/**
 * Refuse to run unless `paths` is the canonical, isolated demo location.
 * Throws (never warns) so a misconfigured invocation aborts before any write.
 */
export function assertSafeDemoPaths(
  paths: DemoPaths,
  opts: { productionDataDir?: string } = {}
): void {
  const prod = path.resolve(opts.productionDataDir ?? productionDataDir())
  const canonical = path.join(path.resolve(paths.rootDir), DEMO_DIR_NAME)
  if (path.resolve(paths.demoDir) !== canonical) {
    throw new Error(
      `Refusing to operate: demo directory ${paths.demoDir} is not the canonical location ${canonical}.`
    )
  }
  if (isInside(paths.dbPath, prod) || isInside(paths.demoDir, prod)) {
    throw new Error(
      [
        `Refusing to operate: ${paths.demoDir} resolves inside the production data directory ${prod}.`,
        'The demo must never read or write the production database.',
      ].join('\n')
    )
  }
  if (isInside(prod, paths.demoDir)) {
    throw new Error(
      `Refusing to operate: the production data directory ${prod} is inside the demo directory ${paths.demoDir}.`
    )
  }
}

/**
 * Guard for deletion: only a directory created by `demo:setup` (marker file
 * present), at the canonical path, and not a symlink may be removed.
 */
export function assertRemovableDemoDir(
  paths: DemoPaths,
  opts: { productionDataDir?: string } = {}
): void {
  assertSafeDemoPaths(paths, opts)
  if (!fs.existsSync(paths.demoDir)) {
    throw new Error(`Demo directory ${paths.demoDir} does not exist — nothing to remove.`)
  }
  const stat = fs.lstatSync(paths.demoDir)
  if (stat.isSymbolicLink()) {
    throw new Error(
      `Refusing to remove ${paths.demoDir}: it is a symlink, not a directory created by demo:setup.`
    )
  }
  if (!stat.isDirectory()) {
    throw new Error(`Refusing to remove ${paths.demoDir}: not a directory.`)
  }
  if (!fs.existsSync(paths.markerPath)) {
    throw new Error(
      [
        `Refusing to remove ${paths.demoDir}: marker file ${DEMO_MARKER_FILE} is missing,`,
        'so this directory was not created by demo:setup.',
      ].join('\n')
    )
  }
}

/** Write the marker file that authorises later resets/removals. */
export function writeDemoMarker(paths: DemoPaths, extra: Record<string, unknown> = {}): void {
  const payload = {
    created_at: new Date().toISOString(),
    root: paths.rootDir,
    db: paths.dbPath,
    note: 'Created by SubstiFlow demo:setup. Safe to delete with npm run demo:remove.',
    ...extra,
  }
  fs.writeFileSync(paths.markerPath, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 })
}
