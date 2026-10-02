import { useState, useMemo } from 'react'
import { Link } from 'react-router-dom'
import { 
  CheckCircle, XCircle, Calendar, ChevronLeft, ChevronRight,
  UserCheck, UserX, RefreshCw
} from 'lucide-react'
import { format, addDays, subDays } from 'date-fns'
import { Button } from '@/components/ui/Button'
import { Card, CardHeader, CardBody } from '@/components/ui/Card'
import { Badge } from '@/components/ui/Badge'
import { Input } from '@/components/ui/Input'
import { useAppStore } from '@/stores/appStore'
import { facultyRepository, attendanceRepository, departmentRepository, auditLogRepository, AUDIT_ACTIONS } from '@/db/repositories'
import { cn } from '@/utils/cn'
import { parseISODate, todayISO } from '@/utils/date'

export function Attendance() {
  const { currentAcademicYear, currentDate, setCurrentDate } = useAppStore()
  const [searchQuery, setSearchQuery] = useState('' as string)
  const [filterStatus, setFilterStatus] = useState<'all' | 'present' | 'absent'>('all')
  // Bumped after every write so the memoised map is recomputed and the rows,
  // badges and counters re-render immediately (writes are synchronous).
  const [attendanceVersion, setAttendanceVersion] = useState(0)

  const today = currentDate || todayISO()

  const faculty = useMemo(() => {
    if (!currentAcademicYear) return []
    return facultyRepository.findActive()
  }, [currentAcademicYear])

  const departments = useMemo(() => departmentRepository.findAll(), [])

  const attendanceMap = useMemo(() => {
    const records = attendanceRepository.findByDate(today)
    const map = new Map<string, 'PRESENT' | 'ABSENT'>()
    for (const record of records) {
      map.set(record.facultyId, record.status)
    }
    return map
  }, [today, attendanceVersion])

  const filteredFaculty = useMemo(() => {
    return faculty.filter(f => {
      const matchesSearch = f.name.toLowerCase().includes(searchQuery.toLowerCase())
      const status = attendanceMap.get(f.id) || 'PRESENT'
      const matchesFilter = filterStatus === 'all' || 
        (filterStatus === 'present' && status === 'PRESENT') ||
        (filterStatus === 'absent' && status === 'ABSENT')
      return matchesSearch && matchesFilter
    })
  }, [faculty, searchQuery, filterStatus, attendanceMap])

  const handleToggleAttendance = (facultyId: string) => {
    try {
      const currentStatus = attendanceMap.get(facultyId) || 'PRESENT'
      const newStatus = currentStatus === 'PRESENT' ? 'ABSENT' : 'PRESENT'
      attendanceRepository.upsert(today, facultyId, newStatus)
      const name = faculty.find(f => f.id === facultyId)?.name ?? facultyId
      auditLogRepository.record(
        AUDIT_ACTIONS.ATTENDANCE_MARKED,
        'attendance',
        facultyId,
        `${name} marked ${newStatus.toLowerCase()} for ${today}`
      )
      setAttendanceVersion(v => v + 1)
    } catch (error) {
      alert(error instanceof Error ? error.message : 'Could not save attendance. Please try again.')
    }
  }

  const handleMarkAllPresent = () => {
    try {
      const facultyIds = faculty.map(f => f.id)
      attendanceRepository.initializeAllPresent(today, facultyIds)
      auditLogRepository.record(
        AUDIT_ACTIONS.ATTENDANCE_MARKED,
        'attendance',
        undefined,
        `All ${facultyIds.length} faculty marked present for ${today}`
      )
      setAttendanceVersion(v => v + 1)
    } catch (error) {
      alert(error instanceof Error ? error.message : 'Could not save attendance. Please try again.')
    }
  }

  const absentCount = faculty.filter(f => attendanceMap.get(f.id) === 'ABSENT').length
  const presentCount = faculty.length - absentCount

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

  const dayName = new Date(today).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-secondary-900">Today's Attendance</h1>
          <p className="text-secondary-500">Mark absent faculty for {dayName}</p>
        </div>
        <div className="flex items-center gap-3">
          <Button variant="outline" size="sm" aria-label="Previous day" onClick={() => setCurrentDate(format(subDays(parseISODate(today), 1), 'yyyy-MM-dd'))}>
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <input
            type="date"
            value={today}
            onChange={(e) => {
              // Ignore an empty/partial value so clearing the field can never
              // silently redirect reads and writes to today's date.
              if (/^\d{4}-\d{2}-\d{2}$/.test(e.target.value)) setCurrentDate(e.target.value)
            }}
            className="w-auto px-3 py-2 border border-secondary-300 rounded-lg text-sm focus:border-primary-500 focus:ring-1 focus:ring-primary-500"
          />
          <Button variant="outline" size="sm" aria-label="Next day" onClick={() => setCurrentDate(format(addDays(parseISODate(today), 1), 'yyyy-MM-dd'))}>
            <ChevronRight className="h-4 w-4" />
          </Button>
          <Button variant="outline" size="sm" onClick={() => setCurrentDate(format(new Date(), 'yyyy-MM-dd'))}>
            <RefreshCw className="h-4 w-4" />
            <span className="hidden sm:inline">Today</span>
          </Button>
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        <Card>
          <CardBody className="flex items-center justify-between">
            <div>
              <p className="text-sm text-secondary-600">Total Faculty</p>
              <p className="text-3xl font-bold text-secondary-900">{faculty.length}</p>
            </div>
            <div className="p-3 rounded-xl bg-secondary-100 text-secondary-700">
              <UserX className="h-6 w-6" />
            </div>
          </CardBody>
        </Card>
        <Card>
          <CardBody className="flex items-center justify-between">
            <div>
              <p className="text-sm text-secondary-600">Present</p>
              <p className="text-3xl font-bold text-success-700">{presentCount}</p>
            </div>
            <div className="p-3 rounded-xl bg-success-50 text-success-700">
              <CheckCircle className="h-6 w-6" />
            </div>
          </CardBody>
        </Card>
        <Card>
          <CardBody className="flex items-center justify-between">
            <div>
              <p className="text-sm text-secondary-600">Absent</p>
              <p className="text-3xl font-bold text-danger-700">{absentCount}</p>
            </div>
            <div className="p-3 rounded-xl bg-danger-50 text-danger-700">
              <XCircle className="h-6 w-6" />
            </div>
          </CardBody>
        </Card>
      </div>

      <Card>
        <CardBody className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <Input
              placeholder="Search faculty..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-64"
            />
            <select
              value={filterStatus}
              onChange={(e) => setFilterStatus(e.target.value as any)}
              className="px-3 py-2 border border-secondary-300 rounded-lg text-sm focus:border-primary-500 focus:ring-1 focus:ring-primary-500"
            >
              <option value="all">All</option>
              <option value="present">Present</option>
              <option value="absent">Absent</option>
            </select>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="secondary" onClick={handleMarkAllPresent}>
              <UserCheck className="h-4 w-4" />
              Mark All Present
            </Button>
          </div>
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <h3 className="text-lg font-semibold text-secondary-900">Faculty Attendance</h3>
          <p className="text-sm text-secondary-500">Click to toggle attendance status</p>
        </CardHeader>
        <CardBody className="p-0">
          {filteredFaculty.length === 0 ? (
            <div className="p-8 text-center text-secondary-500">
              No faculty found
            </div>
          ) : (
            <div className="divide-y divide-secondary-200">
              {filteredFaculty.map((facultyMember) => {
                const status = attendanceMap.get(facultyMember.id) || 'PRESENT'
                const isAbsent = status === 'ABSENT'
                return (
                  <button
                    key={facultyMember.id}
                    onClick={() => handleToggleAttendance(facultyMember.id)}
                    className={cn(
                      'w-full flex items-center justify-between p-4 hover:bg-secondary-50 transition-colors text-left',
                      isAbsent && 'bg-danger-50'
                    )}
                  >
                    <div className="flex items-center gap-4">
                      <div className={cn(
                        'flex h-10 w-10 items-center justify-center rounded-full',
                        isAbsent ? 'bg-danger-100 text-danger-600' : 'bg-success-100 text-success-600'
                      )}>
                        {isAbsent ? <XCircle className="h-5 w-5" /> : <CheckCircle className="h-5 w-5" />}
                      </div>
                      <div>
                        <p className="font-medium text-secondary-900">{facultyMember.name}</p>
                        <p className="text-sm text-secondary-500">
                          {departments.find(d => d.id === facultyMember.departmentId)?.name ?? facultyMember.departmentId}
                        </p>
                      </div>
                    </div>
                    <Badge variant={isAbsent ? 'danger' : 'success'}>
                      {isAbsent ? 'Absent' : 'Present'}
                    </Badge>
                  </button>
                )
              })}
            </div>
          )}
        </CardBody>
      </Card>

      <Card className="bg-primary-50 border-primary-200">
        <CardBody>
          <h4 className="font-medium text-primary-900 mb-2">How it works</h4>
          <ul className="text-sm text-primary-700 space-y-1 list-disc list-inside">
            <li>All faculty default to <strong>Present</strong> each day</li>
            <li>Click any faculty member to toggle their status</li>
            <li>Use "Mark All Present" to reset</li>
            <li>Only mark faculty who are actually absent</li>
            <li>After marking attendance, go to <strong>Substitution Planner</strong> to generate the plan</li>
          </ul>
        </CardBody>
      </Card>
    </div>
  )
}