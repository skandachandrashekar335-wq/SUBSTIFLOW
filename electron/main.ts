import { app, BrowserWindow, ipcMain, dialog, shell, Menu } from 'electron'
import * as path from 'path'
import * as fs from 'fs'
import { pathToFileURL } from 'url'
import { createDatabase, openNodeDatabase, resolveDatabasePath, TARGET_SCHEMA_VERSION } from '../src/db/nodeDb'
import { validateBackupFile } from './backupValidation'
import type { SqlDatabase } from '../src/db/types'

const isDev = process.env.NODE_ENV === 'development' && !app.isPackaged

// Fixed storage folder shared with the maintenance CLI (`scripts/cli.js`).
app.setName('SubstiFlow')
let mainWindow: BrowserWindow | null = null
let db: SqlDatabase | null = null

/**
 * Two instances would each hold their own connection to the same file: both
 * would replay pending migrations (one dying half-way) and — far worse — the
 * backup-import flow closes the connection, deletes the WAL sidecars and
 * replaces the file, which the other instance would keep writing to through
 * its stale handle. One process per database, always.
 *
 * The lock is scoped per data directory: an explicit SUBSTIFLOW_DATA_DIR
 * override (e2e/QA runs, the maintenance CLI) moves the Electron profile
 * with it, so test and production instances can coexist while a second
 * instance on the SAME database is refused.
 */
const dataDirOverride = process.env.SUBSTIFLOW_DATA_DIR
if (dataDirOverride) {
  app.setPath('userData', dataDirOverride)
}
const gotSingleInstanceLock = app.requestSingleInstanceLock()
if (!gotSingleInstanceLock) {
  app.quit()
}

function ok(data: unknown): { data: unknown } {
  return { data }
}

function fail(error: unknown): { error: string } {
  return { error: error instanceof Error ? error.message : String(error) }
}

/**
 * Only the main window's renderer may call our IPC handlers — a defence in
 * depth against any other webContents (popups, print windows, devtools
 * extensions) reaching the database bridge.
 */
function isTrustedSender(event: { sender: unknown }): boolean {
  return Boolean(mainWindow && !mainWindow.isDestroyed() && event.sender === mainWindow.webContents)
}

/** External links: only harmless web schemes ever reach the OS handler. */
function openExternalSafely(url: string): void {
  try {
    const parsed = new URL(url)
    if (parsed.protocol === 'https:' || parsed.protocol === 'http:' || parsed.protocol === 'mailto:') {
      void shell.openExternal(url)
    } else {
      console.warn(`[app] blocked external open of ${parsed.protocol} URL`)
    }
  } catch {
    console.warn('[app] blocked external open of malformed URL')
  }
}

/**
 * All database access happens in this process; the renderer only ever sees
 * serialised results through the preload bridge.
 *
 * Before migrations run on a database from an older schema, an online
 * snapshot is taken (`pre-upgrade-<timestamp>.db`, next to the daily
 * auto-backups): a failed upgrade must leave a same-session copy of the data
 * exactly as it was, not only yesterday's daily backup. Snapshot problems are
 * logged but never fatal — a missing backup must not stop the app from
 * starting (startup itself is still guarded by the integrity check below).
 */
const PRE_UPGRADE_KEEP = 5

async function snapshotBeforeUpgrade(): Promise<void> {
  const dbPath = resolveDatabasePath()
  if (!fs.existsSync(dbPath)) return

  const probe = openNodeDatabase(dbPath)
  try {
    let current = 0
    try {
      const row = probe
        .prepare('SELECT MAX(version) AS v FROM schema_version')
        .get() as { v: number | null } | undefined
      current = row?.v ?? 0
    } catch {
      current = 0 // no schema_version table — an pre-v1 file; migrations will rebuild it
    }
    if (current >= TARGET_SCHEMA_VERSION) return // already current; nothing risky will run

    const dir = autoBackupDirectory()
    fs.mkdirSync(dir, { recursive: true })
    const target = path.join(dir, `pre-upgrade-${localTimestampStamp()}.db`)
    await (probe as unknown as { backup(dest: string): Promise<void> }).backup(target)
    console.log(`[app] pre-upgrade snapshot -> ${target}`)

    const preUpgrade = fs
      .readdirSync(dir)
      .filter((name) => /^pre-upgrade-.*\.db$/.test(name))
      .sort() // date-stamped names sort chronologically
    for (const name of preUpgrade.slice(0, Math.max(0, preUpgrade.length - PRE_UPGRADE_KEEP))) {
      fs.rmSync(path.join(dir, name), { force: true })
    }
  } catch (error) {
    console.warn(`[app] pre-upgrade snapshot failed: ${error instanceof Error ? error.message : String(error)}`)
  } finally {
    try {
      probe.close()
    } catch {
      /* already closed */
    }
  }
}

async function setupDatabase(): Promise<void> {
  await snapshotBeforeUpgrade()
  db = createDatabase()
}

/**
 * Automatic backups: one snapshot per launch-day under
 * `<app data>/auto-backups`, pruned to the newest ones. Failures are logged
 * but never fatal — a missing backup must not stop the app from starting.
 */
const AUTO_BACKUP_KEEP = 14
const AUTO_BACKUP_PATTERN = /^substiflow-\d{4}-\d{2}-\d{2}\.db$/

/** Local calendar date (`2026-09-29`) — the UTC date rolls over a day early. */
function localDateStamp(date: Date = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/** Local date + time (`2026-10-10-143059`) for uniquely named snapshots. */
function localTimestampStamp(date: Date = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${localDateStamp(date)}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
}

function autoBackupDirectory(): string {
  return path.join(path.dirname(resolveDatabasePath()), 'auto-backups')
}

function listAutoBackups(): string[] {
  const dir = autoBackupDirectory()
  if (!fs.existsSync(dir)) return []
  // Date-stamped names sort chronologically.
  return fs.readdirSync(dir).filter((name) => AUTO_BACKUP_PATTERN.test(name)).sort()
}

function pruneAutoBackups(): number {
  const snapshots = listAutoBackups()
  const excess = snapshots.slice(0, Math.max(0, snapshots.length - AUTO_BACKUP_KEEP))
  for (const name of excess) {
    fs.rmSync(path.join(autoBackupDirectory(), name), { force: true })
  }
  return excess.length
}

/** Pre-import snapshots are one per import attempt — keep the 5 newest. */
function pruneImportSnapshots(): void {
  try {
    const dir = autoBackupDirectory()
    const snapshots = fs
      .readdirSync(dir)
      .filter((name) => /^pre-import-.*\.db$/.test(name))
      .sort()
    for (const name of snapshots.slice(0, Math.max(0, snapshots.length - 5))) {
      fs.rmSync(path.join(dir, name), { force: true })
    }
  } catch {
    // Pruning must never fail an already-successful import.
  }
}

async function runAutoBackup(): Promise<void> {
  try {
    const dbPath = resolveDatabasePath()
    if (!fs.existsSync(dbPath)) return

    const dir = autoBackupDirectory()
    fs.mkdirSync(dir, { recursive: true })

    const target = path.join(dir, `substiflow-${localDateStamp()}.db`)
    if (!fs.existsSync(target)) {
      // Opened only to snapshot — always closed, even if the backup throws
      // (a leaked writer handle would keep the WAL alive and undermine the
      // import flow's sidecar cleanup).
      const snapshot = openNodeDatabase(dbPath)
      try {
        await (snapshot as unknown as { backup(dest: string): Promise<void> }).backup(target)
      } finally {
        snapshot.close()
      }
      console.log(`[app] auto backup -> ${target}`)
    }

    const pruned = pruneAutoBackups()
    if (pruned > 0) {
      console.log(`[app] auto backup pruned ${pruned} old snapshot(s)`)
    }
  } catch (error) {
    console.warn(`[app] auto backup failed: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function setupIpc(): void {
  const handle = (channel: string, fn: (payload: any) => unknown) => {
    ipcMain.on(channel, (event, payload) => {
      if (!isTrustedSender(event)) {
        event.returnValue = fail('IPC sender is not the main window')
        return
      }
      if (!db) {
        event.returnValue = fail('Database is not initialised')
        return
      }
      try {
        event.returnValue = ok(fn(payload))
      } catch (error) {
        event.returnValue = fail(error)
      }
    })
  }

  handle('db:all', ({ sql, params }: { sql: string; params?: unknown[] }) =>
    db!.prepare(sql).all(...((params ?? []) as unknown[]))
  )
  handle('db:get', ({ sql, params }: { sql: string; params?: unknown[] }) =>
    db!.prepare(sql).get(...((params ?? []) as unknown[]))
  )
  handle('db:run', ({ sql, params }: { sql: string; params?: unknown[] }) =>
    db!.prepare(sql).run(...((params ?? []) as unknown[]))
  )
  handle('db:exec', ({ sql }: { sql: string }) => {
    db!.exec(sql)
    return null
  })

  // NOTE: the async `db:query` / `db:transaction` channels that used to live
  // here were never called by the renderer (everything goes through the sync
  // bridge above) and performed raw BEGIN/COMMIT with no nesting guard — dead
  // surface that could have COMMITted another in-flight transaction.

  ipcMain.handle('backup:export', async (event) => {
    if (!isTrustedSender(event)) return { success: false, error: 'IPC sender is not the main window' }
    if (!db) return { success: false, error: 'Database is not initialised' }

    const { filePath, canceled } = await dialog.showSaveDialog({
      title: 'Export Backup',
      defaultPath: `substiflow-backup-${localDateStamp()}.db`,
      filters: [{ name: 'SQLite Database', extensions: ['db'] }],
    })
    if (canceled || !filePath) return { success: false, error: 'Cancelled' }

    try {
      const backupDb = openNodeDatabase(resolveDatabasePath())
      try {
        await (backupDb as unknown as { backup(dest: string): Promise<void> }).backup(filePath)
      } finally {
        backupDb.close()
      }
      return { success: true, path: filePath }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.handle('backup:import', async (event, filePath: string) => {
    if (!isTrustedSender(event)) return { success: false, error: 'IPC sender is not the main window' }
    if (!filePath || !fs.existsSync(filePath)) {
      return { success: false, error: 'File not found' }
    }
    const targetPath = resolveDatabasePath()
    // Selecting the LIVE database as the "backup" must be refused up front:
    // copyFileSync(src === dest) truncates the destination first, which would
    // silently destroy the only copy of the data while reporting success.
    if (path.resolve(filePath) === path.resolve(targetPath)) {
      return {
        success: false,
        error: 'That file is the database currently in use — choose a backup exported earlier instead.',
      }
    }
    // The renderer passes an arbitrary path — never copy it over the live
    // database without verifying it is a real SubstiFlow backup whose
    // integrity check passes and whose schema this build can open.
    const validation = validateBackupFile(filePath)
    if (!validation.ok) {
      return { success: false, error: validation.error }
    }

    const { response } = await dialog.showMessageBox({
      type: 'warning',
      buttons: ['Cancel', 'Overwrite'],
      defaultId: 0,
      cancelId: 0,
      title: 'Confirm Import',
      message: 'Importing a backup will overwrite current data. A snapshot of the current data is taken first, so a failed import can be rolled back. Continue?',
    })
    if (response === 0) return { success: false, error: 'Cancelled' }

    // 1) Snapshot the CURRENT database before anything is touched. If this
    //    fails the import is aborted — we never overwrite the only copy of
    //    the coordinator's data.
    const snapshotPath = path.join(autoBackupDirectory(), `pre-import-${localTimestampStamp()}.db`)
    try {
      fs.mkdirSync(autoBackupDirectory(), { recursive: true })
      const snapshot = openNodeDatabase(targetPath)
      try {
        await (snapshot as unknown as { backup(dest: string): Promise<void> }).backup(snapshotPath)
      } finally {
        snapshot.close()
      }
    } catch (error) {
      return {
        success: false,
        error: `Could not snapshot the current database before importing (${error instanceof Error ? error.message : String(error)}). Nothing was changed.`,
      }
    }

    // 2) Swap the file ATOMICALLY: stage the validated backup NEXT TO the
    //    live database, then close the connection, drop the OLD WAL/SHM
    //    sidecars (they describe the previous file, not the imported one)
    //    and rename the staged copy into place. A crash mid-copy can never
    //    leave a half-written database — the rename either happened or it
    //    did not, and the rollback below is equally atomic.
    // 3) Reopen — `createDatabase()` runs migrations, so an older backup is
    //    upgraded to the current schema in place.
    const stagedPath = `${targetPath}.incoming`
    try {
      fs.copyFileSync(filePath, stagedPath)
      db?.close()
      db = null
      for (const suffix of ['-wal', '-shm']) {
        fs.rmSync(`${targetPath}${suffix}`, { force: true })
      }
      fs.renameSync(stagedPath, targetPath)
      await setupDatabase()
      pruneImportSnapshots()
      return { success: true }
    } catch (error) {
      fs.rmSync(stagedPath, { force: true })
      // Roll back to the snapshot so the app always comes back with the
      // data it had. Never leave `db` null — every IPC handler after a
      // failed import must keep working.
      const importError = error instanceof Error ? error.message : String(error)
      try {
        for (const suffix of ['-wal', '-shm']) {
          fs.rmSync(`${targetPath}${suffix}`, { force: true })
        }
        const restoreStagedPath = `${targetPath}.restore`
        fs.copyFileSync(snapshotPath, restoreStagedPath)
        fs.renameSync(restoreStagedPath, targetPath)
        await setupDatabase()
        return {
          success: false,
          error: `Import failed (${importError}). The previous database was restored — your existing data is intact.`,
        }
      } catch (restoreError) {
        const restoreMsg = restoreError instanceof Error ? restoreError.message : String(restoreError)
        // Last resort: still reopen whatever is on disk so the app has a
        // live connection; the snapshot path is reported for manual recovery.
        try {
          await setupDatabase()
        } catch {
          db = null
        }
        return {
          success: false,
          error: `Import failed (${importError}) and automatic restore also failed (${restoreMsg}). Your pre-import snapshot is at: ${snapshotPath}`,
        }
      }
    }
  })

  ipcMain.handle('backup:autoInfo', (event) => {
    if (!isTrustedSender(event)) return { error: 'IPC sender is not the main window' }
    try {
      const snapshots = listAutoBackups()
      const last = snapshots.length > 0 ? snapshots[snapshots.length - 1] : null
      return {
        directory: autoBackupDirectory(),
        keep: AUTO_BACKUP_KEEP,
        count: snapshots.length,
        lastBackup: last ? last.replace(/^substiflow-/, '').replace(/\.db$/, '') : null,
      }
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.handle('app:info', (event) => {
    if (!isTrustedSender(event)) return { error: 'IPC sender is not the main window' }
    try {
      return {
        version: app.getVersion(),
        name: app.getName(),
        userDataPath: app.getPath('userData'),
        dbPath: resolveDatabasePath(),
        isDev,
        // True only when the process was started by `npm run demo:launch`
        // (SUBSTIFLOW_DEMO=1) — drives the DEMO DATA banner in the UI.
        isDemo: process.env.SUBSTIFLOW_DEMO === '1',
      }
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.handle('print', async (event, html?: string) => {
    if (!isTrustedSender(event)) return { success: false, error: 'IPC sender is not the main window' }
    const { filePath, canceled } = await dialog.showSaveDialog({
      title: 'Save as PDF',
      defaultPath: `substiflow-${localDateStamp()}.pdf`,
      filters: [{ name: 'PDF', extensions: ['pdf'] }],
    })
    if (canceled || !filePath) return { success: false, canceled: true }

    // Sandboxed: the window renders renderer-supplied HTML from a data: URL
    // and needs no preload, no node, no network — the tightest webPreferences
    // available keep the print pipeline out of the app's trust boundary.
    const printWindow = new BrowserWindow({ show: false, webPreferences: { sandbox: true } })
    try {
      await printWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html ?? '<html></html>')}`)
      const data = await printWindow.webContents.printToPDF({})
      fs.writeFileSync(filePath, data)
      return { success: true }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    } finally {
      if (!printWindow.isDestroyed()) printWindow.destroy()
    }
  })
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1080,
    minHeight: 700,
    title: 'SubstiFlow',
    backgroundColor: '#f8fafc',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
    },
    show: false,
  })

  Menu.setApplicationMenu(null)

  mainWindow.once('ready-to-show', () => mainWindow?.show())

  if (isDev) {
    mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL || 'http://localhost:5173')
    mainWindow.webContents.openDevTools({ mode: 'detach' })
  } else {
    mainWindow.loadFile(path.join(__dirname, '../../renderer/index.html'))
  }

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    openExternalSafely(url)
    return { action: 'deny' }
  })

  // The renderer must never leave the app: no remote navigation (which would
  // hand the preload bridge to a hostile page), and in production no local
  // file outside the app's own renderer bundle either. In-page router
  // navigation (history.pushState) does not trigger will-navigate.
  const rendererRootUrl = pathToFileURL(path.join(__dirname, '../../renderer')).href
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const allowed =
      url.startsWith('about:') ||
      (!isDev && url.startsWith(rendererRootUrl)) ||
      (isDev && (url === 'http://localhost:5173/' || url.startsWith('http://localhost:5173/')))
    if (!allowed) {
      console.warn(`[app] blocked navigation to ${url}`)
      event.preventDefault()
    }
  })

  // Surface renderer console output and load failures in the terminal.
  // The console-message signature varies across Electron versions, so decode
  // it defensively instead of relying on one particular shape.
  ;(mainWindow.webContents as unknown as {
    on(channel: string, listener: (...args: unknown[]) => void): void
  }).on('console-message', (...args: unknown[]) => {
    const first = args[1]
    let message = ''
    let line = ''
    let sourceId = ''
    if (first && typeof first === 'object') {
      const details = first as Record<string, unknown>
      message = String(details.message ?? '')
      line = String(details.lineNumber ?? '')
      sourceId = String(details.sourceId ?? '')
    } else {
      message = String(args[2] ?? '')
      line = String(args[3] ?? '')
      sourceId = String(args[4] ?? '')
    }
    console.log(`[renderer] ${message} (${sourceId}:${line})`)
  })
  mainWindow.webContents.on('did-fail-load', (_event, code, description, failedUrl) => {
    console.error(`[renderer] failed to load ${failedUrl}: ${code} ${description}`)
  })
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    console.error(`[renderer] process gone: ${details.reason} (exit ${details.exitCode})`)
  })
  mainWindow.webContents.on('did-finish-load', () => {
    console.log(`[app] loaded ${mainWindow?.webContents.getURL()}`)
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

if (gotSingleInstanceLock) {
  app.whenReady().then(async () => {
    try {
      await setupDatabase()
    } catch (error) {
      // A failed migration or integrity check must never surface as "the app
      // does nothing when I open it": explain what happened, that the data is
      // not deleted, and how to recover — then exit instead of opening a
      // window with no database. (The upgrade path also leaves a same-session
      // `pre-upgrade-*.db` snapshot next to the daily auto-backups.)
      const message = error instanceof Error ? error.message : String(error)
      console.error(`[app] database setup failed: ${message}`)
      dialog.showErrorBox(
        'SubstiFlow — database could not be opened',
        `Opening or upgrading the database failed:\n\n${message}\n\n` +
          `Your existing data has not been deleted.\n` +
          `• If this persists, close the app and restore the newest file from the\n` +
          `  "auto-backups" folder next to your database, then open SubstiFlow again.\n` +
          `• Otherwise, report this message as a bug.`
      )
      app.quit()
      return
    }
    setupIpc()
    createWindow()
    // Rolling daily snapshots; runs in the background so startup is unaffected.
    void runAutoBackup()

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      db?.close()
      db = null
      app.quit()
    }
  })

  app.on('before-quit', () => {
    db?.close()
    db = null
  })
}
