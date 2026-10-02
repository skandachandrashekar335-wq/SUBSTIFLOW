import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { format } from 'date-fns'
import { ArrowLeft, ArrowRight, Download, Printer, Table2, Calendar } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Card, CardHeader, CardBody } from '@/components/ui/Card'
import { Badge } from '@/components/ui/Badge'
import { useAppStore } from '@/stores/appStore'
import { getRevisedTimetable, getRunLifecycle, RUN_LIFECYCLE_LABELS } from '@/services/substitution'
import { timeRangeLabel } from '@/services/timetable'
import { attendanceRepository } from '@/db/repositories'
import { cn } from '@/utils/cn'

function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

interface DisplayRow {
  period: string
  section: string
  subject: string
  originalTeam: string
  substitute: string
  room: string
  classType: string
  status: 'Locked' | 'Substituted' | 'Uncovered' | 'Team continues' | 'As Scheduled'
}

/**
 * The effective schedule for one day: master entries + approved (or pending)
 * substitutions as a read-only overlay. Print / PDF goes through the existing
 * desktop print pipeline; CSV export through a Blob download — the master
 * timetable itself is never modified from this screen.
 */
export function RevisedTimetable() {
  const { currentAcademicYear, currentDate, setCurrentDate } = useAppStore()
  const today = currentDate || format(new Date(), 'yyyy-MM-dd')
  const [error, setError] = useState<string | null>(null)

  const lifecycle = getRunLifecycle(today)
  const absentIds = useMemo(() => new Set(attendanceRepository.getAbsentFacultyIds(today)), [today])
  const revised = useMemo(
    () => (currentAcademicYear ? getRevisedTimetable(today) : []),
    [currentAcademicYear, today]
  )

  const dayName = new Date(today + 'T00:00:00').toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  })

  const rows: DisplayRow[] = useMemo(() => {
    return revised.map((row: any) => {
      const entry = row.originalEntry
      const facultyIds: string[] = entry?.facultyIds ?? []
      const absentHere = facultyIds.filter(f => absentIds.has(f))
      const partiallyAbsent = absentHere.length > 0 && absentHere.length < facultyIds.length
      const status: DisplayRow['status'] = row.isSubstituted
        ? row.substitution?.isLocked
          ? 'Locked'
          : 'Substituted'
        : row.substitution
          ? 'Uncovered'
          : partiallyAbsent
            ? 'Team continues'
            : 'As Scheduled'
      return {
        period: entry
          ? entry.span > 1
            ? timeRangeLabel(entry.timeSlotId, entry.span)
            : entry.timeSlot?.name ?? ''
          : '',
        section: entry?.section?.name ?? '',
        subject: entry?.subject?.name ?? '',
        originalTeam: (entry?.facultyList ?? []).map((f: any) => f.name).join(', ') || 'No faculty',
        substitute: row.substituteFaculty?.name ?? '',
        room: (entry?.roomList ?? []).map((r: any) => r.name).join(', '),
        classType: entry?.classType ?? '',
        status,
      }
    })
  }, [revised, absentIds])

  const statusVariant = (status: DisplayRow['status']) =>
    status === 'Locked'
      ? 'warning'
      : status === 'Substituted'
        ? 'success'
        : status === 'Uncovered'
          ? 'danger'
          : status === 'Team continues'
            ? 'info'
            : 'neutral'

  const filename = `revised-timetable-${today}`

  const handleExportCSV = () => {
    if (rows.length === 0) {
      alert('There is no timetable data to export for this date.')
      return
    }
    const headers = ['Period', 'Class', 'Subject', 'Original Faculty', 'Substitute', 'Room', 'Type', 'Status']
    const csvRows = rows.map(r => [
      r.period,
      r.section,
      r.subject,
      r.originalTeam,
      r.substitute,
      r.room,
      r.classType,
      r.status,
    ])
    const csv = [headers, ...csvRows]
      .map(row => row.map(cell => `"${String(cell).replace(/"/g, '""')}"`).join(','))
      .join('\n')
    const blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${filename}.csv`
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    // Revoke on the next tick: revoking synchronously can cancel the download.
    setTimeout(() => URL.revokeObjectURL(url), 0)
  }

  const handlePrintPdf = async () => {
    if (rows.length === 0) {
      alert('There is no timetable data to print for this date.')
      return
    }
    if (!window.electron?.print?.print) {
      alert('Printing is only available inside the SubstiFlow desktop app.')
      return
    }
    const headers = ['Period', 'Class', 'Subject', 'Original Faculty', 'Substitute', 'Room', 'Status']
    const head = headers.map(h => `<th>${escapeHtml(h)}</th>`).join('')
    const body = rows
      .map(
        r =>
          `<tr><td>${escapeHtml(r.period)}</td><td>${escapeHtml(r.section)}</td>` +
          `<td>${escapeHtml(r.subject)}</td><td>${escapeHtml(r.originalTeam)}</td>` +
          `<td>${escapeHtml(r.substitute || '—')}</td><td>${escapeHtml(r.room || '—')}</td>` +
          `<td>${escapeHtml(r.status)}</td></tr>`
      )
      .join('')
    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${escapeHtml(`Revised Timetable — ${today}`)}</title>
<style>
  body { font-family: Helvetica, Arial, sans-serif; margin: 24px; color: #0f172a; }
  h1 { font-size: 15px; margin: 0 0 4px; }
  p.meta { font-size: 11px; color: #64748b; margin: 0 0 16px; }
  table { border-collapse: collapse; width: 100%; }
  th, td { border: 1px solid #cbd5e1; padding: 6px 8px; font-size: 11px; text-align: left; }
  th { background: #f1f5f9; font-weight: 600; }
</style></head>
<body>
  <h1>Revised Timetable — ${escapeHtml(dayName)}</h1>
  <p class="meta">Status: ${escapeHtml(RUN_LIFECYCLE_LABELS[lifecycle])} · Generated ${escapeHtml(format(new Date(), 'yyyy-MM-dd HH:mm'))}</p>
  <table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>
</body></html>`
    try {
      const result = await window.electron.print.print(html)
      if (!result.success && !result.canceled) {
        alert(`Could not create the PDF: ${result.error || 'unknown error'}`)
      }
    } catch (err) {
      console.error('[revised timetable] print failed', err)
      alert('Could not create the PDF. Please try again.')
    }
  }

  if (!currentAcademicYear) {
    return (
      <div className="max-w-4xl mx-auto text-center py-12">
        <Calendar className="h-16 w-16 mx-auto text-secondary-300 mb-4" />
        <h1 className="text-2xl font-bold text-secondary-900 mb-2">No Active Academic Year</h1>
        <p className="text-secondary-500 mb-6">Please configure an academic year in Settings.</p>
        <Link to="/settings"><Button>Go to Settings</Button></Link>
      </div>
    )
  }

  const substituted = rows.filter(r => r.status === 'Substituted' || r.status === 'Locked').length
  const uncovered = rows.filter(r => r.status === 'Uncovered').length

  return (
    <div className="max-w-7xl mx-auto space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <div className="flex items-center gap-3 flex-wrap">
            <h1 className="text-2xl font-bold text-secondary-900">Revised Timetable</h1>
            <Badge variant="neutral" data-testid="lifecycle-status">{RUN_LIFECYCLE_LABELS[lifecycle]}</Badge>
          </div>
          <p className="text-secondary-500">{dayName} — the effective schedule after today’s substitutions</p>
        </div>
        <div className="flex items-center gap-3 flex-wrap">
          <input
            type="date"
            value={today}
            onChange={(e) => setCurrentDate(e.target.value)}
            className="w-auto px-3 py-2 border border-secondary-300 rounded-lg text-sm focus:border-primary-500 focus:ring-1 focus:ring-primary-500"
          />
          <Button variant="secondary" onClick={handleExportCSV}>
            <Download className="h-4 w-4" />
            Export CSV
          </Button>
          <Button variant="secondary" onClick={handlePrintPdf}>
            <Printer className="h-4 w-4" />
            Print / PDF
          </Button>
          <Link to="/dashboard">
            <Button variant="outline">
              <ArrowLeft className="h-4 w-4" />
              Dashboard
            </Button>
          </Link>
        </div>
      </div>

      {error && (
        <div className="p-3 bg-danger-50 border border-danger-200 rounded-lg text-sm text-danger-700">
          {error}
        </div>
      )}

      <div className="grid gap-4 md:grid-cols-3">
        <Card>
          <CardBody>
            <p className="text-sm text-secondary-600">Activities</p>
            <p className="text-3xl font-bold text-secondary-900 mt-1">{rows.length}</p>
          </CardBody>
        </Card>
        <Card>
          <CardBody>
            <p className="text-sm text-secondary-600">Substituted</p>
            <p className="text-3xl font-bold text-primary-700 mt-1">{substituted}</p>
          </CardBody>
        </Card>
        <Card>
          <CardBody>
            <p className="text-sm text-secondary-600">Uncovered</p>
            <p className={cn('text-3xl font-bold mt-1', uncovered > 0 ? 'text-danger-600' : 'text-secondary-900')}>
              {uncovered}
            </p>
          </CardBody>
        </Card>
      </div>

      <Card data-testid="revised-timetable">
        <CardHeader>
          <div className="flex items-center gap-2">
            <Table2 className="h-5 w-5 text-primary-600" aria-hidden="true" />
            <h3 className="text-lg font-semibold text-secondary-900">Effective Schedule — {dayName}</h3>
          </div>
          <p className="text-sm text-secondary-500">
            Master timetable entries are never modified — substitutions are applied as a read-only overlay.
            Uncovered and partially-absent classes are shown explicitly.
          </p>
        </CardHeader>
        <CardBody className="p-0">
          {rows.length === 0 ? (
            <div className="p-10 text-center text-secondary-500">
              No timetable entries for this date.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-secondary-50 text-secondary-600">
                  <tr>
                    <th scope="col" className="text-left font-medium px-4 py-2">Period</th>
                    <th scope="col" className="text-left font-medium px-4 py-2">Class</th>
                    <th scope="col" className="text-left font-medium px-4 py-2">Subject</th>
                    <th scope="col" className="text-left font-medium px-4 py-2">Type</th>
                    <th scope="col" className="text-left font-medium px-4 py-2">Original Faculty</th>
                    <th scope="col" className="text-left font-medium px-4 py-2">Substitute</th>
                    <th scope="col" className="text-left font-medium px-4 py-2">Room</th>
                    <th scope="col" className="text-left font-medium px-4 py-2">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-secondary-100" data-testid="revised-timetable-body">
                  {rows.map((r, i) => (
                    <tr
                      key={i}
                      className={cn(
                        r.status === 'Substituted' || r.status === 'Locked'
                          ? 'bg-primary-50/50'
                          : r.status === 'Uncovered'
                            ? 'bg-danger-50'
                            : undefined
                      )}
                    >
                      <td className="px-4 py-2 whitespace-nowrap text-secondary-700">{r.period}</td>
                      <td className="px-4 py-2 whitespace-nowrap text-secondary-900">{r.section}</td>
                      <td className="px-4 py-2 text-secondary-700">{r.subject}</td>
                      <td className="px-4 py-2 text-secondary-500">{r.classType}</td>
                      <td className="px-4 py-2 text-secondary-600">{r.originalTeam}</td>
                      <td className={cn('px-4 py-2', r.substitute ? 'font-semibold text-primary-700' : 'text-secondary-400')}>
                        {r.substitute ? (
                          <span className="inline-flex items-center gap-1">
                            <ArrowRight className="h-3.5 w-3.5" />
                            {r.substitute}
                          </span>
                        ) : (
                          '—'
                        )}
                      </td>
                      <td className="px-4 py-2 text-secondary-700">{r.room || '—'}</td>
                      <td className="px-4 py-2">
                        <Badge variant={statusVariant(r.status)}>{r.status}</Badge>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardBody>
      </Card>
    </div>
  )
}
