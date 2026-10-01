import { useMemo } from 'react'
import { Link } from 'react-router-dom'
import { 
  Users, CheckCircle, AlertCircle, Calendar, Clock, 
  ArrowRight, Plus, BookOpen, Building2, FileText
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
  timeSlotRepository,
  sectionRepository 
} from '@/db/repositories'
import { cn } from '@/utils/cn'

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

    let affectedEntries = 0
    // Skip break periods — they are not classes (is_break is the source of
    // truth, not a hardcoded slot id like 'break').
    const breakSlotIds = new Set(timeSlotRepository.getBreakSlots().map(s => s.id))
    for (const facultyId of absentFacultyIds) {
      const entries = timetableEntryRepository.findByFacultyAndDay(facultyId, dayOfWeek as any, currentAcademicYear.id)
      affectedEntries += entries.filter(e => !breakSlotIds.has(e.timeSlotId)).length
    }

    const run = substitutionRunRepository.findByDate(today)
    const assignments = run ? substitutionAssignmentRepository.findByRun(run.id) : []
    const covered = assignments.filter(a => a.substituteFacultyId).length
    const uncovered = affectedEntries - covered

    return {
      totalFaculty: allFaculty.length,
      presentCount,
      absentCount: absentFacultyIds.size,
      affectedEntries,
      covered,
      uncovered,
      substitutionCount: covered,
    }
  }, [currentAcademicYear, today])

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

  return (
    <div className="max-w-7xl mx-auto space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-secondary-900">Dashboard</h1>
          <p className="text-secondary-500">{dayName}</p>
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

      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        <StatCard title="Total Faculty" value={stats?.totalFaculty || 0} icon={Users} color="primary" />
        <StatCard title="Present Today" value={stats?.presentCount || 0} icon={CheckCircle} color="success" />
        <StatCard title="Absent Today" value={stats?.absentCount || 0} icon={AlertCircle} color="danger" />
        <StatCard title="Affected Classes" value={stats?.affectedEntries || 0} icon={Calendar} color="warning" />
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        <StatCard title="Classes Covered" value={stats?.covered || 0} icon={CheckCircle} color="success" subtitle={`${stats?.uncovered || 0} uncovered`} />
        <StatCard title="Uncovered Classes" value={stats?.uncovered || 0} icon={AlertCircle} color="danger" />
        <StatCard title="Substitutions Made" value={stats?.substitutionCount || 0} icon={Clock} color="info" />
      </div>

      <div className="grid gap-4 md:grid-cols-3">
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
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
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