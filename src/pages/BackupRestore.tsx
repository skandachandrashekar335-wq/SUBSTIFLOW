import { useEffect, useState } from 'react'
import { Database, Download, Upload, CheckCircle, AlertTriangle, Clock } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Card, CardHeader, CardBody } from '@/components/ui/Card'
import { Badge } from '@/components/ui/Badge'

type Message = { type: 'success' | 'error' | 'info'; text: string }

/**
 * Static class strings — Tailwind only generates classes it can see in the
 * source, so template interpolation like `bg-${type}-50` compiles to nothing.
 */
const MESSAGE_STYLES: Record<Message['type'], { card: string; text: string; Icon: typeof CheckCircle }> = {
  success: { card: 'border-success-200 bg-success-50', text: 'text-success-800', Icon: CheckCircle },
  error: { card: 'border-danger-200 bg-danger-50', text: 'text-danger-800', Icon: AlertTriangle },
  info: { card: 'border-info-200 bg-info-50', text: 'text-info-800', Icon: Clock },
}

type AutoBackupInfo = {
  directory?: string
  keep?: number
  count?: number
  lastBackup?: string | null
}

export function BackupRestore() {
  const [message, setMessage] = useState<Message | null>(null)
  const [autoBackup, setAutoBackup] = useState<AutoBackupInfo | null>(null)
  const [autoBackupError, setAutoBackupError] = useState<string | null>(null)
  const [dbPath, setDbPath] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false

    if (!window.electron?.backup) {
      setAutoBackupError('Auto-backup status is only available in the desktop app.')
      return
    }

    window.electron.backup
      .autoInfo()
      .then((info) => {
        if (cancelled) return
        if (info.error) setAutoBackupError(info.error)
        else setAutoBackup(info)
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setAutoBackupError(error instanceof Error ? error.message : 'Could not read auto-backup status.')
        }
      })
    void window.electron?.app
      .getInfo()
      .then((info) => {
        if (!cancelled) setDbPath(info.dbPath)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [])

  const storageLabel =
    dbPath ?? (typeof window !== 'undefined' && window.electron ? 'App data directory' : 'Browser (dev)')

  const handleExportBackup = async () => {
    try {
      if (typeof window.electron !== 'undefined' && window.electron.backup) {
        const result = await window.electron.backup.exportBackup()
        if (result.success) {
          setMessage({ type: 'success', text: `Backup saved to ${result.path}` })
        } else {
          setMessage({ type: 'error', text: result.error || 'Backup failed' })
        }
      } else {
        setMessage({ type: 'error', text: 'Backups are written by the desktop app — launch SubstiFlow, not the browser, to export a backup.' })
      }
    } catch (error) {
      setMessage({ type: 'error', text: 'Failed to export backup: ' + (error as Error).message })
    }
  }

  const handleImportBackup = async () => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = '.db,.sqlite,.sql'
    input.onchange = async (e) => {
      const file = (e.target as HTMLInputElement).files?.[0]
      if (!file) return

      if (!confirm('Importing a backup will overwrite current data. Continue?')) return

      try {
        if (typeof window.electron !== 'undefined' && window.electron.backup) {
          const result = await window.electron.backup.importBackup(file.path)
          if (result.success) {
            setMessage({ type: 'success', text: 'Backup imported successfully. Please restart the application.' })
          } else {
            setMessage({ type: 'error', text: result.error || 'Import failed' })
          }
        } else {
          setMessage({ type: 'error', text: 'Electron API not available. Use the desktop application for backup restore.' })
        }
      } catch (error) {
        setMessage({ type: 'error', text: 'Failed to import backup: ' + (error as Error).message })
      }
    }
    input.click()
  }

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-secondary-900">Backup & Restore</h1>
        <p className="text-secondary-500">Export and import your SubstiFlow database</p>
      </div>

      {message &&
        (() => {
          const { card, text, Icon } = MESSAGE_STYLES[message.type]
          const iconColor =
            message.type === 'success' ? 'text-success-600' : message.type === 'error' ? 'text-danger-600' : 'text-info-600'
          return (
            <Card className={card}>
              <CardBody className="flex items-center gap-3">
                <Icon className={`h-5 w-5 ${iconColor}`} />
                <span className={`text-sm font-medium ${text}`}>{message.text}</span>
              </CardBody>
            </Card>
          )
        })()}

      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader>
            <div className="flex items-center gap-3">
              <div className="p-3 rounded-xl bg-primary-50 text-primary-700">
                <Download className="h-6 w-6" />
              </div>
              <div>
                <h3 className="text-lg font-semibold text-secondary-900">Export Backup</h3>
                <p className="text-sm text-secondary-500">Download your database</p>
              </div>
            </div>
          </CardHeader>
          <CardBody className="space-y-4">
            <p className="text-sm text-secondary-600">
              Export your complete database as a backup file. Save this file safely for disaster recovery.
            </p>
            <ul className="text-sm text-secondary-500 space-y-1 list-disc list-inside">
              <li>Includes all faculty, timetable, and settings</li>
              <li>Store in a safe location</li>
              <li>Recommended: weekly backups</li>
            </ul>
            <Button onClick={handleExportBackup} className="w-full">
              <Download className="h-4 w-4" />
              Export Backup
            </Button>
          </CardBody>
        </Card>

        <Card>
          <CardHeader>
            <div className="flex items-center gap-3">
              <div className="p-3 rounded-xl bg-warning-50 text-warning-700">
                <Upload className="h-6 w-6" />
              </div>
              <div>
                <h3 className="text-lg font-semibold text-secondary-900">Import Backup</h3>
                <p className="text-sm text-secondary-500">Restore from backup</p>
              </div>
            </div>
          </CardHeader>
          <CardBody className="space-y-4">
            <div className="p-4 bg-warning-50 border border-warning-200 rounded-lg">
              <div className="flex items-start gap-3">
                <AlertTriangle className="h-5 w-5 text-warning-600 mt-0.5" />
                <div className="text-sm text-warning-800">
                  <p className="font-medium">Warning</p>
                  <p>Importing will overwrite current data. Export a backup first.</p>
                </div>
              </div>
            </div>
            <Button onClick={handleImportBackup} variant="outline" className="w-full">
              <Upload className="h-4 w-4" />
              Import Backup
            </Button>
          </CardBody>
        </Card>
      </div>

      {/* Database Info */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-3">
            <div className="p-3 rounded-xl bg-secondary-100 text-secondary-700">
              <Database className="h-6 w-6" />
            </div>
            <div>
              <h3 className="text-lg font-semibold text-secondary-900">Database Information</h3>
              <p className="text-sm text-secondary-500">Local SQLite database details</p>
            </div>
          </div>
        </CardHeader>
        <CardBody className="space-y-4">
          <div className="flex items-center justify-between py-2 border-b border-secondary-200">
            <span className="text-sm text-secondary-600">Storage Location</span>
            <span className="text-sm font-medium text-secondary-900 break-all text-right ml-4">
              {storageLabel}
            </span>
          </div>
          <div className="flex items-center justify-between py-2 border-b border-secondary-200">
            <span className="text-sm text-secondary-600">Database Engine</span>
            <span className="text-sm font-medium text-secondary-900">SQLite (better-sqlite3)</span>
          </div>
          <div className="flex items-center justify-between py-2 border-b border-secondary-200">
            <span className="text-sm text-secondary-600">Auto Backup</span>
            <span className="flex items-center gap-2">
              <Badge variant="success">Daily</Badge>
              <span className="text-sm font-medium text-secondary-900">
                {autoBackup
                  ? `keeps the last ${autoBackup.keep} snapshots`
                  : autoBackupError
                    ? <span className="text-danger-600">{autoBackupError}</span>
                    : 'checking…'}
              </span>
            </span>
          </div>
          <div className="flex items-center justify-between py-2 border-b border-secondary-200">
            <span className="text-sm text-secondary-600">Snapshots stored</span>
            <span className="text-sm font-medium text-secondary-900">
              {autoBackup
                ? autoBackup.count
                  ? `${autoBackup.count} in auto-backups${autoBackup.lastBackup ? ` (last: ${autoBackup.lastBackup})` : ''}`
                  : 'none yet'
                : autoBackupError
                  ? <span className="text-danger-600">unavailable</span>
                  : '—'}
            </span>
          </div>
          <div className="flex items-center justify-between py-2">
            <span className="text-sm text-secondary-600">Encryption</span>
            <Badge variant="neutral">Not Encrypted</Badge>
          </div>
          <div className="pt-4">
            <p className="text-sm text-secondary-500">
              The database is stored in your user data directory and will persist across application updates.
              On every launch SubstiFlow also writes a dated snapshot to <code className="text-secondary-700">auto-backups/</code>,
              keeping the most recent {autoBackup?.keep ?? 14}. Export a copy elsewhere for safekeeping.
            </p>
          </div>
        </CardBody>
      </Card>
    </div>
  )
}