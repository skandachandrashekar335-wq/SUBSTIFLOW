import { useState, useEffect, useMemo } from 'react'
import { Link } from 'react-router-dom'
import { format } from 'date-fns'
import { 
  Calendar, RefreshCw, CheckCircle, XCircle, AlertTriangle, 
  Lock, Unlock, Edit, Trash2, Download, Eye, Plus
} from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Card, CardHeader, CardBody } from '@/components/ui/Card'
import { Badge } from '@/components/ui/Badge'
import { Dialog, DialogHeader, DialogContent, DialogFooter } from '@/components/ui/Dialog'
import { Select, SelectOption } from '@/components/ui/Select'
import { useAppStore } from '@/stores/appStore'
import { 
  generateSubstitutions, 
  getSubstitutionRun, 
  updateSubstitutionAssignment, 
  lockAssignment, 
  unlockAssignment,
  approveSubstitutionRun,
  availableSubstitutesForAssignment,
  validateSubstituteAssignment,
} from '@/services/substitution'
import { cn } from '@/utils/cn'

export function SubstitutionPlanner() {
  const { currentAcademicYear, currentDate, setCurrentDate } = useAppStore()
  
  const [runData, setRunData] = useState<any>(null)
  const [generating, setGenerating] = useState(false)
  const [approving, setApproving] = useState(false)
  const [selectedAssignment, setSelectedAssignment] = useState<any>(null)
  const [showManualAssign, setShowManualAssign] = useState(false)
  const [manualFacultyId, setManualFacultyId] = useState('')

  const today = currentDate || format(new Date(), 'yyyy-MM-dd')

  useEffect(() => {
    loadRun()
  }, [today])

  const loadRun = () => {
    const run = getSubstitutionRun(today)
    setRunData(run)
  }

  const handleGenerate = async () => {
    if (!currentAcademicYear) return
    setGenerating(true)
    try {
      const result = generateSubstitutions(today)
      setRunData(result)
    } catch (error) {
      console.error('Failed to generate substitutions:', error)
      alert('Failed to generate substitutions: ' + (error as Error).message)
    } finally {
      setGenerating(false)
    }
  }

  const handleApprove = async () => {
    if (!runData) return
    setApproving(true)
    try {
      const approved = approveSubstitutionRun(today, 'Coordinator')
      if (!approved) {
        alert('There is no substitution plan to approve for this date. Generate one first.')
        return
      }
      loadRun()
    } catch (error) {
      console.error('Failed to approve:', error)
      alert('Failed to approve: ' + (error as Error).message)
    } finally {
      setApproving(false)
    }
  }

  const handleUpdateAssignment = (assignmentId: string, facultyId: string | null) => {
    // A hand-picked substitute must satisfy the same hard constraints as the
    // generated plan: not absent, not already teaching or covering another
    // class in this slot, and not past the daily limit.
    if (facultyId) {
      const check = validateSubstituteAssignment(assignmentId, facultyId)
      if (!check.ok) {
        alert(check.reason || 'That faculty member cannot be assigned to this slot.')
        return
      }
    }

    const updated = updateSubstitutionAssignment(assignmentId, { substituteFacultyId: facultyId })
    if (facultyId && !updated) {
      alert('The assignment could not be changed. The substitute may be absent, busy or at the daily limit.')
      return
    }

    loadRun()
    setShowManualAssign(false)
    setSelectedAssignment(null)
  }

  const handleLock = (assignmentId: string) => {
    if (!lockAssignment(assignmentId)) {
      alert('Could not lock this assignment. Reload the page and try again.')
      return
    }
    loadRun()
  }

  const handleUnlock = (assignmentId: string) => {
    if (!unlockAssignment(assignmentId)) {
      alert('Could not unlock this assignment. Reload the page and try again.')
      return
    }
    loadRun()
  }

  const handleOpenManualAssign = (assignment: any) => {
    setSelectedAssignment(assignment)
    setManualFacultyId(assignment.substituteFacultyId || '')
    setShowManualAssign(true)
  }

  // The dialog picker must offer exactly the faculty that
  // `updateSubstitutionAssignment` will accept — absent, already-teaching,
  // already-covering-this-slot and over-limit faculty are all excluded.
  const availableFaculty = useMemo(
    () => (selectedAssignment ? availableSubstitutesForAssignment(selectedAssignment.id) : []),
    [selectedAssignment, runData]
  )

  const dayName = new Date(today + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })

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

  return (
    <div className="max-w-7xl mx-auto space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-secondary-900">Substitution Planner</h1>
          <p className="text-secondary-500">Generate and review substitutions for {dayName}</p>
        </div>
        <div className="flex items-center gap-3">
          <input
            type="date"
            value={today}
            onChange={(e) => setCurrentDate(e.target.value)}
            className="w-auto px-3 py-2 border border-secondary-300 rounded-lg text-sm focus:border-primary-500 focus:ring-1 focus:ring-primary-500"
          />
          <Button variant="outline" onClick={loadRun} disabled={generating}>
            <RefreshCw className="h-4 w-4" />
            Refresh
          </Button>
          <Button onClick={handleGenerate} disabled={generating} loading={generating}>
            <Plus className="h-4 w-4" />
            Generate Plan
          </Button>
        </div>
      </div>

      {runData && (
        <div className="grid gap-4 md:grid-cols-4">
          <StatCard title="Affected Classes" value={runData.statistics.totalAffected} icon={Calendar} color="primary" />
          <StatCard title="Covered" value={runData.statistics.covered} icon={CheckCircle} color="success" />
          <StatCard title="Uncovered" value={runData.statistics.uncovered} icon={AlertTriangle} color="danger" />
          <StatCard title="Locked" value={runData.statistics.manuallyAssigned} icon={Lock} color="warning" />
        </div>
      )}

      {!runData && (
        <Card>
          <CardBody className="flex flex-col items-center justify-center py-12 text-center">
            <Calendar className="h-12 w-12 text-secondary-300 mb-4" />
            <h3 className="text-lg font-medium text-secondary-900 mb-2">No substitution plan for today</h3>
            <p className="text-secondary-500 mb-6 max-w-md">
              Click "Generate Plan" to automatically create substitutions based on today's absent faculty.
            </p>
            <Button onClick={handleGenerate} disabled={generating} loading={generating} size="lg">
              <Plus className="h-4 w-4" />
              Generate Substitution Plan
            </Button>
          </CardBody>
        </Card>
      )}

      {runData && runData.uncovered.length > 0 && (
        <Card className="border-danger-200 bg-danger-50">
          <CardHeader>
            <h3 className="text-lg font-semibold text-danger-900 flex items-center gap-2">
              <AlertTriangle className="h-5 w-5" />
              Uncovered Classes ({runData.uncovered.length})
            </h3>
          </CardHeader>
          <CardBody>
            <div className="space-y-3">
              {runData.uncovered.map((uncovered: any, index: number) => {
                const entry = runData.affectedEntries.find((e: any) => e.id === uncovered.originalEntryId)
                return (
                  <div key={index} className="p-4 bg-white border border-danger-200 rounded-lg">
                    <div className="flex items-start justify-between gap-4">
                      <div className="flex-1">
                        <p className="font-medium text-secondary-900">
                          {entry?.section?.name} - {entry?.subject?.name}
                        </p>
                        <p className="text-sm text-secondary-500">
                          {entry?.timeSlot?.name} • {entry?.faculty?.name} (Absent)
                        </p>
                        <p className="text-sm text-danger-600 mt-1">{uncovered.reason}</p>
                      </div>
                      <Button 
                        variant="outline" 
                        size="sm" 
                        onClick={() => handleOpenManualAssign({
                          id: '',
                          runId: runData.runId,
                          originalEntryId: uncovered.originalEntryId,
                          substituteFacultyId: null,
                          status: 'PENDING',
                          score: 0,
                          reasoning: '',
                          isLocked: false,
                          createdAt: '',
                          updatedAt: '',
                          originalEntry: entry,
                        })}
                      >
                        <Plus className="h-4 w-4" />
                        Assign Manually
                      </Button>
                    </div>
                  </div>
                )
              })}
            </div>
          </CardBody>
        </Card>
      )}

      {runData && runData.assignments.length > 0 && (
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <h3 className="text-lg font-semibold text-secondary-900">Generated Substitutions ({runData.assignments.length})</h3>
              {runData.statistics.uncovered === 0 && (
                <Button onClick={handleApprove} disabled={approving} loading={approving} variant="success">
                  <CheckCircle className="h-4 w-4" />
                  Approve Plan
                </Button>
              )}
            </div>
          </CardHeader>
          <CardBody className="p-0">
            <div className="divide-y divide-secondary-200">
              {runData.assignments.map((assignment: any) => (
                <AssignmentRow
                  key={assignment.id}
                  assignment={assignment}
                  onUpdate={handleUpdateAssignment}
                  onLock={handleLock}
                  onUnlock={handleUnlock}
                  onManualAssign={handleOpenManualAssign}
                  availableFaculty={availableSubstitutesForAssignment(assignment.id)}
                />
              ))}
            </div>
          </CardBody>
        </Card>
      )}

      <Dialog open={showManualAssign} onOpenChange={setShowManualAssign}>
        <DialogHeader 
          title="Assign Substitute" 
          description={selectedAssignment ? `${selectedAssignment.originalEntry?.section?.name} - ${selectedAssignment.originalEntry?.subject?.name} at ${selectedAssignment.originalEntry?.timeSlot?.name}` : ''}
        />
        <DialogContent>
          <div className="space-y-4">
            <p className="text-sm text-secondary-600">
              Select a faculty member to assign as substitute. The list shows available faculty for this time slot.
            </p>
            <Select
              label="Substitute Faculty"
              value={manualFacultyId}
              onChange={setManualFacultyId}
              options={[
                { value: '', label: 'No substitute (leave uncovered)' },
                ...availableFaculty.map(f => ({ value: f.id, label: f.name }))
              ]}
              placeholder="Select faculty..."
            />
            <div className="text-xs text-secondary-500">
              Locked assignments will not be changed by future regenerations.
            </div>
          </div>
        </DialogContent>
        <DialogFooter>
          <Button variant="secondary" onClick={() => setShowManualAssign(false)}>Cancel</Button>
          <Button 
            onClick={() => {
              if (selectedAssignment) {
                handleUpdateAssignment(selectedAssignment.id, manualFacultyId || null)
              }
            }}
          >
            Assign
          </Button>
        </DialogFooter>
      </Dialog>

      {runData && (
        <Card>
          <CardBody className="flex items-center justify-between">
            <div>
              <h3 className="font-medium text-secondary-900">View Reports</h3>
              <p className="text-sm text-secondary-500">See detailed substitution reports and statistics</p>
            </div>
            <Link to="/reports">
              <Button variant="secondary">
                <Eye className="h-4 w-4 mr-2" />
                Go to Reports
              </Button>
            </Link>
          </CardBody>
        </Card>
      )}
    </div>
  )
}

function AssignmentRow({ 
  assignment, 
  onUpdate, 
  onLock, 
  onUnlock, 
  onManualAssign,
  availableFaculty 
}: { 
  assignment: any
  onUpdate: (id: string, facultyId: string | null) => void
  onLock: (id: string) => void
  onUnlock: (id: string) => void
  onManualAssign: (assignment: any) => void
  availableFaculty: any[]
}) {
  const entry = assignment.originalEntry
  const isLocked = assignment.isLocked
  const hasSubstitute = !!assignment.substituteFacultyId
  const isUncovered = !hasSubstitute

  // The current substitute stays selectable even if a later change (another
  // substitution, the daily limit) would make them ineligible for a fresh pick.
  const selectable = hasSubstitute && !availableFaculty.some((f) => f.id === assignment.substituteFacultyId)
    ? [{ id: assignment.substituteFacultyId, name: assignment.substituteFaculty?.name || 'Current substitute' }, ...availableFaculty]
    : availableFaculty
  const facultyOptions = [
    { value: '', label: 'Remove substitute' },
    ...selectable.map((f) => ({ value: f.id, label: f.name })),
  ]

  return (
    <div className={cn('p-4 hover:bg-secondary-50 transition-colors', isLocked && 'bg-warning-50', isUncovered && 'bg-danger-50')}>
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-3 flex-wrap">
            <span className="font-medium text-secondary-900 truncate">
              {entry?.section?.name} - {entry?.subject?.name}
            </span>
            <Badge variant={isLocked ? 'warning' : isUncovered ? 'danger' : 'success'}>
              {isLocked ? 'Locked' : isUncovered ? 'Uncovered' : 'Substituted'}
            </Badge>
            {assignment.score && (
              <Badge variant="info">Score: {Math.round(assignment.score)}</Badge>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-4 mt-2 text-sm text-secondary-500">
            <span>{entry?.timeSlot?.name}</span>
            <span>Original: {entry?.faculty?.name}</span>
            {hasSubstitute && <span className="text-primary-700 font-medium">Substitute: {assignment.substituteFaculty?.name}</span>}
          </div>
          {assignment.reasoning && (
            <p className="text-xs text-secondary-400 mt-1">{assignment.reasoning}</p>
          )}
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          {isUncovered ? (
            <Button variant="outline" size="sm" onClick={() => onManualAssign(assignment)}>
              <Plus className="h-3 w-3" />
              Assign
            </Button>
          ) : (
            <>
              <Select
                value={assignment.substituteFacultyId || ''}
                onChange={(v) => onUpdate(assignment.id, v || null)}
                options={facultyOptions}
                className="w-48"
                disabled={isLocked}
              />
              {isLocked ? (
                <Button variant="ghost" size="sm" onClick={() => onUnlock(assignment.id)}>
                  <Unlock className="h-3 w-3" />
                </Button>
              ) : (
                <Button variant="ghost" size="sm" onClick={() => onLock(assignment.id)}>
                  <Lock className="h-3 w-3" />
                </Button>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  )
}

function StatCard({ title, value, icon: Icon, color }: {
  title: string
  value: number
  icon: React.ComponentType<{ className?: string }>
  color: 'primary' | 'success' | 'danger' | 'warning'
}) {
  const colors = {
    primary: 'bg-primary-50 text-primary-700',
    success: 'bg-success-50 text-success-700',
    danger: 'bg-danger-50 text-danger-700',
    warning: 'bg-warning-50 text-warning-700',
  }

  return (
    <Card>
      <CardBody className="flex items-center justify-between">
        <div>
          <p className="text-sm text-secondary-600">{title}</p>
          <p className="text-3xl font-bold text-secondary-900 mt-1">{value}</p>
        </div>
        <div className={cn('p-3 rounded-xl', colors[color])}>
          <Icon className="h-6 w-6" />
        </div>
      </CardBody>
    </Card>
  )
}