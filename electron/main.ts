import { app, BrowserWindow, ipcMain, dialog, shell, Menu } from 'electron'
import * as path from 'path'
import * as fs from 'fs'
import { createDatabase, openNodeDatabase, resolveDatabasePath } from '../src/db/nodeDb'
import { validateBackupFile } from './backupValidation'
import type { SqlDatabase } from '../src/db/types'

const isDev = process.env.NODE_ENV === 'development' && !app.isPackaged

// Fixed storage folder shared with the maintenance CLI (`scripts/cli.js`).
app.setName('SubstiFlow')
let mainWindow: BrowserWindow | null = null
let db: SqlDatabase | null = null

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
 */
function setupDatabase(): void {
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

async function runAutoBackup(): Promise<void> {
  try {
    const dbPath = resolveDatabasePath()
    if (!fs.existsSync(dbPath)) return

    const dir = autoBackupDirectory()
    fs.mkdirSync(dir, { recursive: true })

    const target = path.join(dir, `substiflow-${localDateStamp()}.db`)
    if (!fs.existsSync(target)) {
      const snapshot = openNodeDatabase(dbPath)
      await (snapshot as unknown as { backup(dest: string): Promise<void> }).backup(target)
      snapshot.close()
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

  ipcMain.handle('db:query', (event, sql: string, params: unknown[] = []) => {
    if (!isTrustedSender(event)) return fail('IPC sender is not the main window')
    if (!db) return fail('Database is not initialised')
    try {
      return ok(db.prepare(sql).all(...(params as unknown[])))
    } catch (error) {
      return fail(error)
    }
  })

  ipcMain.handle('db:transaction', (event, sqls: { sql: string; params?: unknown[] }[]) => {
    if (!isTrustedSender(event)) return fail('IPC sender is not the main window')
    if (!db) return fail('Database is not initialised')
    try {
      // Real transaction: every statement commits together, or none do.
      db.exec('BEGIN')
      try {
        const results: unknown[] = []
        for (const { sql, params } of sqls) {
          results.push(db.prepare(sql).run(...((params ?? []) as unknown[])))
        }
        db.exec('COMMIT')
        return ok(results)
      } catch (error) {
        db.exec('ROLLBACK')
        throw error
      }
    } catch (error) {
      return fail(error)
    }
  })

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
      await (backupDb as unknown as { backup(dest: string): Promise<void> }).backup(filePath)
      backupDb.close()
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
    // The renderer passes an arbitrary path — never copy it over the live
    // database without verifying it is a real, non-corrupt SQLite backup.
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
      message: 'Importing a backup will overwrite current data. This cannot be undone.',
    })
    if (response === 0) return { success: false, error: 'Cancelled' }

    try {
      db?.close()
      db = null
      fs.copyFileSync(filePath, resolveDatabasePath())
      setupDatabase()
      return { success: true }
    } catch (error) {
      setupDatabase()
      return { success: false, error: error instanceof Error ? error.message : String(error) }
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
    return {
      version: app.getVersion(),
      name: app.getName(),
      userDataPath: app.getPath('userData'),
      dbPath: resolveDatabasePath(),
      isDev,
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

    const printWindow = new BrowserWindow({ show: false })
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
  // hand the preload bridge to a hostile page). In-page router navigation
  // (history.pushState) does not trigger will-navigate.
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const allowed =
      url.startsWith('about:') ||
      (!isDev && url.startsWith('file://')) ||
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

app.whenReady().then(() => {
  setupDatabase()
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
