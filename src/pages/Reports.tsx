import { useState, useMemo } from 'react'
import { format, startOfMonth, endOfMonth, eachDayOfInterval } from 'date-fns'
import { FileText, Download, Calendar, Users, AlertTriangle, CheckCircle, Printer, Table2 } from 'lucide-react'
import * as XLSX from 'xlsx'
import { Button } from '@/components/ui/Button'
import { Card, CardHeader, CardBody } from '@/components/ui/Card'
import { Badge } from '@/components/ui/Badge'
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/Table'
import { Select, SelectOption } from '@/components/ui/Select'
import { Input } from '@/components/ui/Input'
import { useAppStore } from '@/stores/appStore'
import { facultyRepository, substitutionRunRepository, substitutionAssignmentRepository, timetableEntryRepository, attendanceRepository, timeSlotRepository, settingsRepository } from '@/db/repositories'
import { findAffectedEntries } from '@/services/substitution/engine'

type ReportType = 'daily' | 'monthly' | 'faculty-stats' | 'uncovered'

/** One exportable view: every exporter (CSV, Excel, PDF) reads this. */
interface ReportView {
  title: string
  filename: string
  headers: string[]
  rows: (string | number)[][]
}

function escapeHtml(value: string | number): string {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

export function Reports() {
  const { currentAcademicYear } = useAppStore()
  const [reportType, setReportType] = useState<ReportType>('daily')
  const [selectedDate, setSelectedDate] = useState(format(new Date(), 'yyyy-MM-dd'))
  const [month, setMonth] = useState(format(new Date(), 'yyyy-MM'))

  const dailyData = useMemo(() => {
    if (reportType !== 'daily' || !currentAcademicYear) return null

    const run = substitutionRunRepository.findByDate(selectedDate)
    const assignments = run ? substitutionAssignmentRepository.findByRunWithRelations(run.id) : []
    const absentFaculty = attendanceRepository.findByDate(selectedDate).filter(a => a.status === 'ABSENT')
    const absentIds = new Set(absentFaculty.map(a => a.facultyId))
    
    const dateObj = new Date(selectedDate + 'T00:00:00')
    const dayIndex = dateObj.getDay()
    const dayNames = ['SUNDAY', 'MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY']
    const dayOfWeek = dayNames[dayIndex]

    // Same policy-aware, span-aware, deduplicated calculation the generator
    // uses — so "Affected" here always matches the plan the engine produces.
    const affectedEntries = findAffectedEntries(absentIds, dayOfWeek as any, currentAcademicYear.id)
    const affected = affectedEntries.length

    const covered = assignments.filter(a => a.substituteFacultyId).length

    return {
      run,
      assignments,
      absentFaculty,
      affected,
      covered,
      uncovered: affected - covered,
    }
  }, [reportType, selectedDate, currentAcademicYear])

  const monthlyData = useMemo(() => {
    if (reportType !== 'monthly' || !currentAcademicYear) return null

    const startDate = startOfMonth(new Date(month + '-01'))
    const endDate = endOfMonth(startDate)
    const days = eachDayOfInterval({ start: startDate, end: endDate })

    const runs = substitutionRunRepository.findAll().filter(r => {
      const d = new Date(r.date + 'T00:00:00')
      return d >= startDate && d <= endDate
    })

    const facultyStats = facultyRepository.findActive().map(f => {
      let totalSubs = 0
      let totalAbsent = 0
      for (const run of runs) {
        const assignments = substitutionAssignmentRepository.findByRunWithRelations(run.id)
        totalSubs += assignments.filter(a => a.substituteFacultyId === f.id).length
        const attendance = attendanceRepository.findByDateAndFaculty(run.date, f.id)
        if (attendance?.status === 'ABSENT') totalAbsent++
      }
      return { faculty: f, totalSubs, totalAbsent, days: days.length }
    }).sort((a, b) => b.totalSubs - a.totalSubs)

    return { runs, facultyStats, days }
  }, [reportType, month, currentAcademicYear])

  const facultyStats = useMemo(() => {
    if (reportType !== 'faculty-stats') return null

    const allRuns = substitutionRunRepository.findAll()
    const allFaculty = facultyRepository.findActive()

    return allFaculty.map(f => {
      let totalSubs = 0
      let asOriginal = 0
      for (const run of allRuns) {
        const assignments = substitutionAssignmentRepository.findByRunWithRelations(run.id)
        totalSubs += assignments.filter(a => a.substituteFacultyId === f.id).length
        asOriginal += assignments.filter(a => a.originalEntry?.facultyIds.includes(f.id) ?? false).length
      }
      return { faculty: f, totalSubs, asOriginal }
    }).sort((a, b) => b.totalSubs - a.totalSubs)
  }, [reportType])

  const uncoveredData = useMemo(() => {
    if (reportType !== 'uncovered' || !currentAcademicYear) return null

    const allRuns = substitutionRunRepository.findAll()
    const uncoveredEntries: { date: string; section: string; subject: string; slot: string; faculty: string }[] = []

    for (const run of allRuns) {
      const assignments = substitutionAssignmentRepository.findByRunWithRelations(run.id)
      const uncovered = assignments.filter(a => !a.substituteFacultyId)
      for (const u of uncovered) {
        if (u.originalEntry) {
          uncoveredEntries.push({
            date: run.date,
            section: u.originalEntry.section?.name || '',
            subject: u.originalEntry.subject?.name || '',
            slot: u.originalEntry.timeSlot?.name || '',
            faculty: (u.originalEntry.facultyList ?? []).map(f => f.name).join(', ') || u.originalEntry.faculty?.name || '',
          })
        }
      }
    }

    return uncoveredEntries
  }, [reportType, currentAcademicYear])

  /** Build the exportable view for the currently selected report. */
  const reportView: ReportView | null = useMemo(() => {
    const institution = settingsRepository.getInstitutionName()

    if (reportType === 'daily' && dailyData) {
      const rows = dailyData.assignments.map(a => {
        const e = a.originalEntry
        const team = (e?.facultyList ?? []).map(f => f.name).join(', ') || e?.faculty?.name || ''
        return [
          e?.section?.name || '',
          e?.subject?.name || '',
          e?.timeSlot?.name || '',
          team,
          a.substituteFaculty?.name || 'Uncovered',
          a.substituteFacultyId ? (a.isLocked ? 'Locked' : 'Substituted') : 'Uncovered',
        ]
      })
      return {
        title: `${institution} — Daily Substitution Report — ${format(new Date(selectedDate + 'T00:00:00'), 'EEEE, MMMM d, yyyy')}`,
        filename: `substitution-report-${selectedDate}`,
        headers: ['Section', 'Subject', 'Time Slot', 'Original Faculty', 'Substitute', 'Status'],
        rows,
      }
    }

    if (reportType === 'monthly' && monthlyData) {
      const rows = monthlyData.facultyStats.map(fs => [
        fs.faculty.name,
        fs.totalSubs,
        fs.totalAbsent,
        monthlyData.runs.length,
      ])
      return {
        title: `${institution} — Monthly Statistics — ${format(new Date(month + '-01T00:00:00'), 'MMMM yyyy')}`,
        filename: `monthly-stats-${month}`,
        headers: ['Faculty', 'Total Substitutions', 'Days Absent', 'Substitution Days Run'],
        rows,
      }
    }

    if (reportType === 'faculty-stats' && facultyStats) {
      const rows = facultyStats.map((fs, i) => [i + 1, fs.faculty.name, fs.totalSubs, fs.asOriginal])
      return {
        title: `${institution} — Faculty Substitution Count`,
        filename: 'faculty-stats',
        headers: ['Rank', 'Faculty', 'Times as Substitute', 'Times Replaced'],
        rows,
      }
    }

    if (reportType === 'uncovered' && uncoveredData) {
      const rows = uncoveredData.map(u => [
        format(new Date(u.date + 'T00:00:00'), 'MMM d, yyyy'),
        u.section,
        u.subject,
        u.slot,
        u.faculty,
      ])
      return {
        title: `${institution} — Uncovered Classes`,
        filename: 'uncovered-classes',
        headers: ['Date', 'Section', 'Subject', 'Time Slot', 'Original Faculty'],
        rows,
      }
    }

    return null
  }, [reportType, dailyData, monthlyData, facultyStats, uncoveredData, selectedDate, month])

  const requireReport = (): ReportView | null => {
    if (!reportView) {
      alert('Select a report to export first.')
      return null
    }
    if (reportView.rows.length === 0) {
      alert('There is no data to export for this selection.')
      return null
    }
    return reportView
  }

  const handleExportCSV = () => {
    const view = requireReport()
    if (!view) return
    const csvEscape = (value: string | number) => {
      const s = String(value)
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
    }
    const csv = [view.headers.map(csvEscape).join(','), ...view.rows.map(r => r.map(csvEscape).join(','))].join('\n')
    const blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${view.filename}.csv`
    document.body.appendChild(a)
    a.click()
    a.remove()
    // Revoke on the next tick: revoking synchronously can cancel the download.
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }

  const handleExportExcel = () => {
    const view = requireReport()
    if (!view) return
    try {
      const worksheet = XLSX.utils.aoa_to_sheet([view.headers, ...view.rows])
      const workbook = XLSX.utils.book_new()
      XLSX.utils.book_append_sheet(workbook, worksheet, 'Report')
      XLSX.writeFile(workbook, `${view.filename}.xlsx`)
    } catch (error) {
      console.error('[reports] excel export failed', error)
      alert('Could not export the Excel file. Please try again.')
    }
  }

  const handlePrintPdf = async () => {
    const view = requireReport()
    if (!view) return
    if (!window.electron?.print?.print) {
      alert('Printing is only available inside the SubstiFlow desktop app.')
      return
    }
    const head = view.headers.map(h => `<th>${escapeHtml(h)}</th>`).join('')
    const body = view.rows
      .map(row => `<tr>${row.map(cell => `<td>${escapeHtml(cell)}</td>`).join('')}</tr>`)
      .join('')
    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${escapeHtml(view.title)}</title>
<style>
  body { font-family: Helvetica, Arial, sans-serif; margin: 24px; color: #0f172a; }
  h1 { font-size: 15px; margin: 0 0 4px; }
  p.meta { font-size: 11px; color: #64748b; margin: 0 0 16px; }
  table { border-collapse: collapse; width: 100%; }
  th, td { border: 1px solid #cbd5e1; padding: 6px 8px; font-size: 11px; text-align: left; }
  th { background: #f1f5f9; font-weight: 600; }
</style></head>
<body>
  <h1>${escapeHtml(view.title)}</h1>
  <p class="meta">Generated ${escapeHtml(format(new Date(), 'yyyy-MM-dd HH:mm'))}</p>
  <table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>
</body></html>`
    try {
      const result = await window.electron.print.print(html)
      if (!result.success && !result.canceled) {
        alert(`Could not create the PDF: ${result.error || 'unknown error'}`)
      }
    } catch (error) {
      console.error('[reports] print failed', error)
      alert('Could not create the PDF. Please try again.')
    }
  }

  const reportTypeOptions: SelectOption[] = [
    { value: 'daily', label: 'Daily Substitution Report' },
    { value: 'monthly', label: 'Monthly Statistics' },
    { value: 'faculty-stats', label: 'Faculty Substitution Count' },
    { value: 'uncovered', label: 'Uncovered Classes' },
  ]

  return (
    <div className="max-w-7xl mx-auto space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-secondary-900">Reports</h1>
          <p className="text-secondary-500">View and export substitution statistics</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button onClick={handleExportCSV} variant="secondary">
            <Download className="h-4 w-4" />
            Export CSV
          </Button>
          <Button onClick={handleExportExcel} variant="secondary">
            <Table2 className="h-4 w-4" />
            Export Excel
          </Button>
          <Button onClick={handlePrintPdf} variant="secondary">
            <Printer className="h-4 w-4" />
            Print / PDF
          </Button>
        </div>
      </div>

      <Card>
        <CardBody className="flex flex-wrap items-center gap-4">
          <Select value={reportType} onChange={(v) => setReportType(v as ReportType)} options={reportTypeOptions} className="w-64" />
          {reportType === 'daily' && (
            <Input type="date" value={selectedDate} onChange={(e) => setSelectedDate(e.target.value)} className="w-48" />
          )}
          {reportType === 'monthly' && (
            <Input type="month" value={month} onChange={(e) => setMonth(e.target.value)} className="w-48" />
          )}
        </CardBody>
      </Card>

      {reportType === 'daily' && dailyData && (
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-lg font-semibold text-secondary-900">
                  Daily Substitution Report - {format(new Date(selectedDate + 'T00:00:00'), 'EEEE, MMMM d, yyyy')}
                </h3>
                <div className="flex items-center gap-4 mt-2">
                  <Badge variant="danger">Absent: {dailyData.absentFaculty.length}</Badge>
                  <Badge variant="warning">Affected: {dailyData.affected}</Badge>
                  <Badge variant="success">Covered: {dailyData.covered}</Badge>
                  <Badge variant="neutral">Uncovered: {dailyData.uncovered}</Badge>
                </div>
              </div>
            </div>
          </CardHeader>
          <CardBody className="p-0">
            {dailyData.absentFaculty.length > 0 && (
              <div className="p-4 border-b border-secondary-200 bg-secondary-50">
                <p className="text-sm font-medium text-secondary-700 mb-2">Absent Faculty:</p>
                <div className="flex flex-wrap gap-2">
                  {dailyData.absentFaculty.map(a => {
                    const f = facultyRepository.findById(a.facultyId)
                    return <Badge key={a.facultyId} variant="danger">{f?.name}</Badge>
                  })}
                </div>
              </div>
            )}
            {dailyData.assignments.length > 0 ? (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Section</TableHead>
                    <TableHead>Subject</TableHead>
                    <TableHead>Time</TableHead>
                    <TableHead>Original</TableHead>
                    <TableHead>Substitute</TableHead>
                    <TableHead>Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {dailyData.assignments.map(a => (
                    <TableRow key={a.id}>
                      <TableCell className="font-medium">{a.originalEntry?.section?.name}</TableCell>
                      <TableCell>{a.originalEntry?.subject?.name}</TableCell>
                      <TableCell>{a.originalEntry?.timeSlot?.name}</TableCell>
                      <TableCell className="text-secondary-500">
                        {(a.originalEntry?.facultyList ?? []).map(f => f.name).join(', ') ||
                          a.originalEntry?.faculty?.name}
                      </TableCell>
                      <TableCell className={a.substituteFacultyId ? 'text-primary-700 font-medium' : 'text-danger-600'}>
                        {a.substituteFaculty?.name || 'Uncovered'}
                      </TableCell>
                      <TableCell>
                        <Badge variant={a.substituteFacultyId ? (a.isLocked ? 'warning' : 'success') : 'danger'}>
                          {a.substituteFacultyId ? (a.isLocked ? 'Locked' : 'Substituted') : 'Uncovered'}
                        </Badge>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            ) : (
              <div className="p-8 text-center text-secondary-500">
                <CheckCircle className="h-12 w-12 mx-auto text-success-500 mb-4" />
                <p>No substitutions needed for this date</p>
              </div>
            )}
          </CardBody>
        </Card>
      )}

      {reportType === 'monthly' && monthlyData && (
        <Card>
          <CardHeader>
            <h3 className="text-lg font-semibold text-secondary-900">
              Monthly Statistics - {format(new Date(month + '-01T00:00:00'), 'MMMM yyyy')}
            </h3>
          </CardHeader>
          <CardBody className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Faculty</TableHead>
                  <TableHead>Total Substitutions</TableHead>
                  <TableHead>Days Absent</TableHead>
                  <TableHead>Substitution Days Run</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {monthlyData.facultyStats.map(fs => (
                  <TableRow key={fs.faculty.id}>
                    <TableCell className="font-medium">{fs.faculty.name}</TableCell>
                    <TableCell>{fs.totalSubs}</TableCell>
                    <TableCell>{fs.totalAbsent}</TableCell>
                    <TableCell>{monthlyData.runs.length}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardBody>
        </Card>
      )}

      {reportType === 'faculty-stats' && facultyStats && (
        <Card>
          <CardHeader>
            <h3 className="text-lg font-semibold text-secondary-900">Faculty Substitution Statistics</h3>
          </CardHeader>
          <CardBody className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Rank</TableHead>
                  <TableHead>Faculty</TableHead>
                  <TableHead>Times as Substitute</TableHead>
                  <TableHead>Times Replaced (absent)</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {facultyStats.map((fs, i) => (
                  <TableRow key={fs.faculty.id}>
                    <TableCell className="font-medium">#{i + 1}</TableCell>
                    <TableCell>{fs.faculty.name}</TableCell>
                    <TableCell>{fs.totalSubs}</TableCell>
                    <TableCell>{fs.asOriginal}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardBody>
        </Card>
      )}

      {reportType === 'uncovered' && (
        <Card>
          <CardHeader>
            <h3 className="text-lg font-semibold text-secondary-900">Uncovered Classes</h3>
          </CardHeader>
          <CardBody className="p-0">
            {uncoveredData && uncoveredData.length > 0 ? (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Date</TableHead>
                    <TableHead>Section</TableHead>
                    <TableHead>Subject</TableHead>
                    <TableHead>Time Slot</TableHead>
                    <TableHead>Original Faculty</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {uncoveredData.map((u, i) => (
                    <TableRow key={i}>
                      <TableCell>{format(new Date(u.date + 'T00:00:00'), 'MMM d, yyyy')}</TableCell>
                      <TableCell className="font-medium">{u.section}</TableCell>
                      <TableCell>{u.subject}</TableCell>
                      <TableCell>{u.slot}</TableCell>
                      <TableCell className="text-secondary-500">{u.faculty}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            ) : (
              <div className="p-8 text-center text-secondary-500">
                <CheckCircle className="h-12 w-12 mx-auto text-success-500 mb-4" />
                <p>No uncovered classes recorded</p>
              </div>
            )}
          </CardBody>
        </Card>
      )}
    </div>
  )
}