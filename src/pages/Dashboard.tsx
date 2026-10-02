import { useMemo } from 'react'
import { Link } from 'react-router-dom'
import { 
  Users, CheckCircle, AlertCircle, Calendar, Clock, 
  ArrowRight, Plus, BookOpen, Building2, FileText, Activity
} from 'lucide-react'
import { format } from 'date-fns'
import { Button } from '@/components/ui/Button'
import { Card, CardHeader, CardBody } from '@/components/ui/Card'
import { Badge } from '@/components/ui/Badge'
import { useAppStore } from '@/stores/appStore'
import { 
  facultyRepository, 
  attendanceRepository, 
  substitutionRunRepository,
  substitutionAssignmentRepository,
  timetableEntryRepository,
  sectionRepository,
  termRepository,
  auditLogRepository,
} from '@/db/repositories'
import {
  findAffectedEntries,
  getRunLifecycle,
  RUN_LIFECYCLE_LABELS,
} from '@/services/substitution'
import type { RunLifecycleStatus } from '@/services/substitution'
import { cn } from '@/utils/cn'

/** Human labels for the audit trail's canonical action names. */
const AUDIT_LABELS: Record<string, string> = {
  'timetable.created': 'Timetable entry added',
  'timetable.updated': 'Timetable entry edited',
  'timetable.deleted': 'Timetable entry deleted',
  'attendance.marked': 'Attendance marked',
  'substitution.generated': 'Substitutions generated',
  'substitution.override': 'Substitute overridden',
  'substitution.locked': 'Assignment locked',
  'substitution.unlocked': 'Assignment unlocked',
  'substitution.approved': 'Revised timetable approved',
}

interface BannerSpec {
  tone: 'info' | 'warning' | 'danger' | 'success'
  title: string
  text: string
  cta: { to: string; label: string }
}

export function Dashboard() {
  const { currentAcademicYear, currentDate, setCurrentDate } = useAppStore()
  const today = currentDate || format(new Date(), 'yyyy-MM-dd')

  const stats = useMemo(() => {
    if (!currentAcademicYear) return null

    const allFaculty = facultyRepository.findActive()
    const absentFacultyIds = new Set(attendanceRepository.getAbsentFacultyIds(today))
    const presentCount = allFaculty.length - absentFacultyIds.size

    const dateObj = new Date(today + 'T00:00:00')
    const dayIndex = dateObj.getDay()
    const dayNames = ['SUNDAY', 'MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY']
    const dayOfWeek = dayNames[dayIndex]

    // Policy-aware: TEAM_SUFFICIENT activities where part of the team is
    // present are NOT affected (the remaining team runs them) — the same
    // logic the generator uses, so the dashboard never overcounts.
    const affectedEntries = findAffectedEntries(absentFacultyIds, dayOfWeek, currentAcademicYear.id).length

    const run = substitutionRunRepository.findByDate(today)
    const assignments = run ? substitutionAssignmentRepository.findByRun(run.id) : []
    const covered = assignments.filter(a => a.substituteFacultyId).length
    const uncovered = assignments.filter(a => !a.substituteFacultyId).length

    return {
      totalFaculty: allFaculty.length,
      presentCount,
      absentCount: absentFacultyIds.size,
      markedCount: attendanceRepository.findByDate(today).length,
      affectedEntries,
      covered,
      uncovered,
      substitutionCount: covered,
      hasRun: Boolean(run),
    }
  }, [currentAcademicYear, today])

  const lifecycle = useMemo<RunLifecycleStatus>(() => getRunLifecycle(today), [today])

  const effectiveTerm = useMemo(() => {
    const active = termRepository.getActive()
    if (!active) return null
    const todayInRange = today >= active.startDate && today <= active.endDate
    return { term: active, todayInRange }
  }, [today])

  const recentActivity = useMemo(() => auditLogRepository.findRecent(8), [lifecycle, today])

  const recentRuns = useMemo(() => {
    return substitutionRunRepository.findAll().slice(0, 5)
  }, [])

  if (!currentAcademicYear) {
    return (
      <div className="max-w-4xl mx-auto text-center py-12">
        <Calendar className="h-16 w-16 mx-auto text-secondary-300 mb-4" />
        <h1 className="text-2xl font-bold text-secondary-900 mb-2">No Active Academic Year</h1>
        <p className="text-secondary-500 mb-6">Please configure an academic year in Settings to get started.</p>
        <Link to="/settings"><Button>Go to Settings</Button></Link>
      </div>
    )
  }

  const dayName = new Date(today + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })

  // The morning workflow, derived from actual state — the banner always
  // shows the ONE next step: attendance → generate → review → approve →
  // revised timetable.
  const banner: BannerSpec | null = (() => {
    switch (lifecycle) {
      case 'NOT_STARTED':
        return {
          tone: 'info',
          title: 'Start today’s workflow',
          text: 'Mark faculty attendance first — substitutions are only generated from real attendance.',
          cta: { to: '/attendance', label: 'Mark Attendance' },
        }
      case 'ATTENDANCE_IN_PROGRESS':
        return {
          tone: 'warning',
          title: `Attendance in progress — ${stats?.markedCount ?? 0} of ${stats?.totalFaculty ?? 0} marked`,
          text: 'Finish marking attendance so today’s substitutions can be generated.',
          cta: { to: '/attendance', label: 'Continue Attendance' },
        }
      case 'ATTENDANCE_COMPLETE':
        return {
          tone: 'info',
          title: 'Attendance complete',
          text: stats?.absentCount
            ? `${stats.absentCount} faculty absent — generate substitutions to cover ${stats.affectedEntries} affected class(es).`
            : 'All faculty present — generate substitutions to confirm nothing needs covering.',
          cta: { to: '/substitution', label: 'Generate Substitutions' },
        }
      case 'GENERATED':
        return {
          tone: 'info',
          title: 'Substitution plan generated',
          text: 'Review the plan and approve the revised timetable for today.',
          cta: { to: '/substitution', label: 'Review Plan' },
        }
      case 'REVIEW_REQUIRED':
        return {
          tone: 'danger',
          title: `${stats?.uncovered ?? 0} class${(stats?.uncovered ?? 0) === 1 ? '' : 'es'} still uncovered`,
          text: 'A plan with uncovered classes is never “done” — review, assign substitutes manually where possible, then approve.',
          cta: { to: '/substitution', label: 'Review Uncovered' },
        }
      case 'ALL_COVERED':
        return {
          tone: 'success',
          title: 'All affected classes covered',
          text: 'Review the assignments and approve today’s revised timetable.',
          cta: { to: '/substitution', label: 'Review & Approve' },
        }
      case 'APPROVED':
        return {
          tone: 'success',
          title: 'Revised timetable approved',
          text: 'The revised timetable for today is ready to print or export.',
          cta: { to: '/revised', label: 'View Revised Timetable' },
        }
      case 'LOCKED':
        return {
          tone: 'success',
          title: 'Assignments locked',
          text: 'Today’s revised timetable is final — print or export it for circulation.',
          cta: { to: '/revised', label: 'View Revised Timetable' },
        }
      default:
        return null
    }
  })()

  const bannerTones = {
    info: 'bg-primary-50 border-primary-200 text-primary-900',
    warning: 'bg-warning-50 border-warning-200 text-warning-900',
    danger: 'bg-danger-50 border-danger-200 text-danger-900',
    success: 'bg-success-50 border-success-200 text-success-900',
  }

  return (
    <div className="max-w-7xl mx-auto space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-secondary-900">Hi, Admin</h1>
          <p className="text-secondary-500">{dayName}</p>
          <div className="flex flex-wrap items-center gap-2 mt-2">
            <Badge variant="neutral" data-testid="lifecycle-status">{RUN_LIFECYCLE_LABELS[lifecycle]}</Badge>
            {effectiveTerm && (
              <Badge variant={effectiveTerm.todayInRange ? 'info' : 'warning'}>
                {effectiveTerm.todayInRange ? 'Effective' : 'Outside term'}: {effectiveTerm.term.name}
              </Badge>
            )}
            <Badge variant="neutral">{currentAcademicYear.name}</Badge>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <label className="text-sm text-secondary-600">Date:</label>
          <input
            type="date"
            value={today}
            onChange={(e) => setCurrentDate(e.target.value)}
            className="w-auto px-3 py-2 border border-secondary-300 rounded-lg text-sm focus:border-primary-500 focus:ring-1 focus:ring-primary-500"
          />
        </div>
      </div>

      {banner && (
        <div
          data-testid="workflow-banner"
          className={cn('flex flex-col sm:flex-row sm:items-center gap-4 p-4 rounded-lg border', bannerTones[banner.tone])}
        >
          <div className="flex-1 min-w-0">
            <p className="font-semibold">{banner.title}</p>
            <p className="text-sm opacity-90 mt-0.5">{banner.text}</p>
          </div>
          <Link to={banner.cta.to} className="shrink-0">
            <Button size="sm">
              {banner.cta.label}
              <ArrowRight className="h-4 w-4" />
            </Button>
          </Link>
        </div>
      )}

      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        <StatCard title="Total Faculty" value={stats?.totalFaculty || 0} icon={Users} color="primary" />
        <StatCard title="Present Today" value={stats?.presentCount || 0} icon={CheckCircle} color="success" />
        <StatCard title="Absent Today" value={stats?.absentCount || 0} icon={AlertCircle} color="danger" />
        <StatCard title="Affected Classes" value={stats?.affectedEntries || 0} icon={Calendar} color="warning" subtitle="per multi-faculty policy" />
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        <StatCard title="Classes Covered" value={stats?.covered || 0} icon={CheckCircle} color="success" subtitle={stats?.hasRun ? `${stats?.uncovered || 0} uncovered` : 'not generated yet'} />
        <StatCard title="Uncovered Classes" value={stats?.uncovered || 0} icon={AlertCircle} color="danger" subtitle={stats?.hasRun ? 'needs review' : 'not generated yet'} />
        <StatCard title="Substitutions Made" value={stats?.substitutionCount || 0} icon={Clock} color="info" />
      </div>

      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        <Link to="/attendance">
          <Card className="hover:shadow-md transition-shadow cursor-pointer h-full">
            <CardBody className="flex items-start gap-4">
              <div className="p-3 rounded-xl bg-primary-50 text-primary-700"><CheckCircle className="h-6 w-6" /></div>
              <div className="flex-1">
                <h3 className="font-semibold text-secondary-900">Mark Attendance</h3>
                <p className="text-sm text-secondary-500 mt-1">Record today's faculty attendance</p>
              </div>
            </CardBody>
          </Card>
        </Link>
        <Link to="/substitution">
          <Card className="hover:shadow-md transition-shadow cursor-pointer h-full">
            <CardBody className="flex items-start gap-4">
              <div className="p-3 rounded-xl bg-primary-50 text-primary-700"><Calendar className="h-6 w-6" /></div>
              <div className="flex-1">
                <h3 className="font-semibold text-secondary-900">Generate Substitutions</h3>
                <p className="text-sm text-secondary-500 mt-1">Create substitution plan for today</p>
              </div>
            </CardBody>
          </Card>
        </Link>
        <Link to="/timetable">
          <Card className="hover:shadow-md transition-shadow cursor-pointer h-full">
            <CardBody className="flex items-start gap-4">
              <div className="p-3 rounded-xl bg-secondary-100 text-secondary-700"><BookOpen className="h-6 w-6" /></div>
              <div className="flex-1">
                <h3 className="font-semibold text-secondary-900">View Timetable</h3>
                <p className="text-sm text-secondary-500 mt-1">See the master timetable</p>
              </div>
            </CardBody>
          </Card>
        </Link>
        <Link to="/revised">
          <Card className="hover:shadow-md transition-shadow cursor-pointer h-full">
            <CardBody className="flex items-start gap-4">
              <div className="p-3 rounded-xl bg-secondary-100 text-secondary-700"><FileText className="h-6 w-6" /></div>
              <div className="flex-1">
                <h3 className="font-semibold text-secondary-900">Revised Timetable</h3>
                <p className="text-sm text-secondary-500 mt-1">Today's effective schedule — print or export</p>
              </div>
            </CardBody>
          </Card>
        </Link>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card>
          <CardHeader>
            <h3 className="text-lg font-semibold text-secondary-900">Recent Substitution Runs</h3>
          </CardHeader>
          <CardBody className="p-0">
            {recentRuns.length === 0 ? (
              <div className="p-6 text-center text-secondary-500">No substitution runs yet</div>
            ) : (
              <div className="divide-y divide-secondary-200">
                {recentRuns.map((run) => (
                  <Link key={run.id} to={`/substitution?date=${run.date}`} className="block p-4 hover:bg-secondary-50 transition-colors">
                    <div className="flex items-center justify-between">
                      <div>
                        <p className="font-medium text-secondary-900">{format(new Date(run.date + 'T00:00:00'), 'MMM d, yyyy')}</p>
                        <p className="text-sm text-secondary-500">{run.status}</p>
                      </div>
                      <Badge variant={run.status === 'APPROVED' ? 'success' : run.status === 'GENERATED' ? 'info' : 'neutral'}>
                        {run.status}
                      </Badge>
                    </div>
                  </Link>
                ))}
              </div>
            )}
          </CardBody>
        </Card>

        <Card>
          <CardHeader>
            <h3 className="text-lg font-semibold text-secondary-900">Quick Stats</h3>
          </CardHeader>
          <CardBody>
            <dl className="space-y-4">
              <div className="flex justify-between">
                <dt className="text-secondary-600">Active Sections</dt>
                <dd className="font-medium text-secondary-900">{sectionRepository.findByAcademicYear(currentAcademicYear.id).length}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-secondary-600">Timetable Entries</dt>
                <dd className="font-medium text-secondary-900">{timetableEntryRepository.findByAcademicYear(currentAcademicYear.id).length}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-secondary-600">Active Faculty</dt>
                <dd className="font-medium text-secondary-900">{facultyRepository.findActive().length}</dd>
              </div>
            </dl>
          </CardBody>
        </Card>

        <Card>
          <CardHeader>
            <h3 className="text-lg font-semibold text-secondary-900 flex items-center gap-2">
              <Activity className="h-4 w-4 text-primary-600" />
              Recent Activity
            </h3>
          </CardHeader>
          <CardBody className="p-0">
            {recentActivity.length === 0 ? (
              <div className="p-6 text-center text-secondary-500">No activity recorded yet</div>
            ) : (
              <div className="divide-y divide-secondary-200">
                {recentActivity.map((a) => (
                  <div key={a.id} className="px-4 py-3" title={a.detail}>
                    <div className="flex items-center justify-between gap-2">
                      <p className="text-sm font-medium text-secondary-900 truncate">
                        {AUDIT_LABELS[a.action] ?? a.action}
                      </p>
                      <span className="text-xs text-secondary-400 shrink-0">
                        {(() => {
                          try {
                            return format(new Date(a.createdAt), 'MMM d, HH:mm')
                          } catch {
                            return a.createdAt
                          }
                        })()}
                      </span>
                    </div>
                    {a.detail && <p className="text-xs text-secondary-500 truncate">{a.detail}</p>}
                  </div>
                ))}
              </div>
            )}
          </CardBody>
        </Card>
      </div>
    </div>
  )
}

function StatCard({ title, value, icon: Icon, color, subtitle }: {
  title: string
  value: number
  icon: React.ComponentType<{ className?: string }>
  color: 'primary' | 'success' | 'danger' | 'warning' | 'info'
  subtitle?: string
}) {
  const colors = {
    primary: 'bg-primary-50 text-primary-700',
    success: 'bg-success-50 text-success-700',
    danger: 'bg-danger-50 text-danger-700',
    warning: 'bg-warning-50 text-warning-700',
    info: 'bg-primary-50 text-primary-700',
  }

  return (
    <Card>
      <CardBody className="flex items-center justify-between">
        <div>
          <p className="text-sm text-secondary-600">{title}</p>
          <p className="text-3xl font-bold text-secondary-900 mt-1">{value}</p>
          {subtitle && <p className="text-xs text-secondary-500 mt-1">{subtitle}</p>}
        </div>
        <div className={cn('p-3 rounded-xl', colors[color])}>
          <Icon className="h-6 w-6" />
        </div>
      </CardBody>
    </Card>
  )
}
