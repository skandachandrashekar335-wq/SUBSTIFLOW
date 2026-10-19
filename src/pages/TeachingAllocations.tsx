import { useState, useMemo, useEffect } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useAppStore } from '@/stores/appStore'
import { facultyRepository, sectionRepository, subjectRepository } from '@/db/repositories'
import {
  createTeachingAllocation,
  updateTeachingAllocation,
  deleteTeachingAllocation,
  deleteTeachingAllocationsForActivity,
  getTeachingAllocationsForAcademicYear,
  getAllocationsGroupedBySectionSubject,
} from '@/services/timetableGeneration'
import { ClassType } from '@/types'
import { weeklySessionCounter } from '@/utils/weeklyCapacity'
import { Button } from '@/components/ui/Button'
import { Card, CardBody, CardHeader } from '@/components/ui/Card'
import { Dialog } from '@/components/ui/Dialog'
import { Table, TableHeader, TableBody, TableRow, TableCell, TableHead } from '@/components/ui/Table'

const CLASS_TYPES: { value: ClassType; label: string }[] = [
  { value: 'LECTURE', label: 'Lecture' },
  { value: 'LAB', label: 'Lab' },
  { value: 'TUTORIAL', label: 'Tutorial' },
  { value: 'LIBRARY', label: 'Library' },
  { value: 'MENTORING', label: 'Mentoring' },
  { value: 'SKILL_BUILD', label: 'Skill Build' },
  { value: 'COE', label: 'COE' },
  { value: 'OTHER', label: 'Other' },
]

const emptyFormData = {
  facultyId: '',
  sectionId: '',
  subjectId: '',
  classType: 'LECTURE' as any,
  requiredSessionsPerWeek: 1,
}

export function TeachingAllocations() {
  const { currentAcademicYear } = useAppStore()
  const [allocations, setAllocations] = useState<any[]>([])
  const [groupedAllocations, setGroupedAllocations] = useState<any[]>([])
  const [showForm, setShowForm] = useState(false)
  const [editingAllocation, setEditingAllocation] = useState<any | null>(null)
  const [formError, setFormError] = useState<string | null>(null)
  const [formData, setFormData] = useState(emptyFormData)
  const [deletingId, setDeletingId] = useState<string | null>(null)

  // Only teaching staff may hold allocations — non-teaching staff are filtered
  // out here and refused again in the service layer.
  const faculty = useMemo(
    () => facultyRepository.findActive().filter(f => f.staffType === 'TEACHING'),
    []
  )
  const sections = useMemo(() => currentAcademicYear ? sectionRepository.findByAcademicYear(currentAcademicYear.id) : [], [currentAcademicYear])
  const subjects = useMemo(() => subjectRepository.findAll(), [])
  const currentYear = currentAcademicYear?.name || '—'

  useEffect(() => {
    if (currentAcademicYear) {
      loadAllocations()
    }
  }, [currentAcademicYear])

  const loadAllocations = () => {
    if (!currentAcademicYear) return
    const allocs = getTeachingAllocationsForAcademicYear(currentAcademicYear.id)
    setAllocations(allocs)
    setGroupedAllocations(getAllocationsGroupedBySectionSubject(currentAcademicYear.id))
  }

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    setFormError(null)
    try {
      if (editingAllocation) {
        updateTeachingAllocation(editingAllocation.id, formData)
      } else {
        createTeachingAllocation({ ...formData, academicYearId: currentAcademicYear!.id })
      }
      setShowForm(false)
      setEditingAllocation(null)
      setFormData(emptyFormData)
      loadAllocations()
    } catch (error) {
      setFormError(error instanceof Error ? error.message : 'An error occurred')
    }
  }

  const handleDelete = (id: string) => {
    if (!id) return
    if (!confirm('Delete this teaching allocation?')) return
    setDeletingId(id)
    try {
      deleteTeachingAllocation(id)
      loadAllocations()
    } catch (error) {
      alert(error instanceof Error ? error.message : 'Could not delete')
    } finally {
      setDeletingId(null)
    }
  }

  /** Delete EVERY allocation of one activity (the grouped row's trash button). */
  const handleDeleteGroup = (group: any) => {
    const count = group.faculty.length
    const message =
      count > 1
        ? `Delete all ${count} teaching allocations for ${group.subjectName} (${group.classType}) — ${group.sectionName}?`
        : `Delete this teaching allocation for ${group.subjectName} (${group.classType}) — ${group.sectionName}?`
    if (!confirm(message)) return
    setDeletingId(`${group.sectionId}-${group.subjectId}-${group.classType}`)
    try {
      deleteTeachingAllocationsForActivity(
        currentAcademicYear!.id,
        group.sectionId,
        group.subjectId,
        group.classType
      )
      loadAllocations()
    } catch (error) {
      alert(error instanceof Error ? error.message : 'Could not delete the allocations')
    } finally {
      setDeletingId(null)
    }
  }

  const handleEdit = (alloc: any) => {
    setEditingAllocation(alloc)
    setFormData({
      facultyId: alloc.facultyId,
      sectionId: alloc.sectionId,
      subjectId: alloc.subjectId,
      classType: alloc.classType,
      requiredSessionsPerWeek: alloc.requiredSessionsPerWeek,
    })
    setShowForm(true)
  }

  const handleNew = () => {
    setEditingAllocation(null)
    setFormData(emptyFormData)
    setShowForm(true)
  }

  const handleCancel = () => {
    setShowForm(false)
    setEditingAllocation(null)
    setFormData(emptyFormData)
    setFormError(null)
  }

  // The real solver lives on the Timetable Generation page (draft → validate →
  // publish). This button just takes the coordinator there with the allocations
  // they just reviewed.
  const navigate = useNavigate()
  const handleGenerate = () => navigate('/generation')

  const totalRequiredSessions = groupedAllocations.reduce((sum, g) => sum + g.totalRequiredSessions, 0)
  const totalFaculty = new Set(allocations.map(a => a.facultyId)).size
  const totalSections = new Set(allocations.map(a => a.sectionId)).size
  // Weekly counter: allocated sessions/week from the persisted allocation
  // rows (each teacher's own row counts once; requirements are not added on
  // top, so shared activities are never double-counted).
  const sessionCounter = weeklySessionCounter(allocations)

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-secondary-900">Teaching Allocations</h1>
          <p className="text-secondary-600 mt-1">Academic Year: <span className="font-medium">{currentYear}</span></p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={handleNew}>
            <svg className="h-4 w-4 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4"></path></svg>
            Add Allocation
          </Button>
          <Button onClick={handleGenerate}>
            <svg className="h-4 w-4 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z"></path></svg>
            Generate Timetable
          </Button>
        </div>
      </div>

      {/* Stats Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Card className="border-primary-200 bg-primary-50">
          <CardBody className="p-4">
            <div className="text-2xl font-bold text-primary-700">{allocations.length}</div>
            <div className="text-sm text-secondary-600">Total Allocations</div>
          </CardBody>
        </Card>
        <Card className="border-secondary-200">
          <CardBody className="p-4">
            <div className="text-2xl font-bold text-secondary-700">{totalRequiredSessions}</div>
            <div className="text-sm text-secondary-600">Sessions/Week Required</div>
          </CardBody>
        </Card>
        <Card className="border-secondary-200">
          <CardBody className="p-4">
            <div className="text-2xl font-bold text-secondary-700">{totalFaculty}</div>
            <div className="text-sm text-secondary-600">Faculty Members</div>
          </CardBody>
        </Card>
        <Card className="border-secondary-200">
          <CardBody className="p-4">
            <div className="text-2xl font-bold text-secondary-700">{totalSections}</div>
            <div className="text-sm text-secondary-600">Sections</div>
          </CardBody>
        </Card>
      </div>

      {/* Help/Info */}
      <div className="p-4 text-sm text-info-800 bg-info-50 border border-info-200 rounded-lg flex items-start gap-3">
        <svg className="h-5 w-5 text-info-600 mt-0.5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"></path></svg>
        <div className="text-sm text-info-800 space-y-1">
          <p className="font-medium">How Teaching Allocations Work</p>
          <ul className="list-disc list-inside space-y-1 text-sm">
            <li>Each row defines: <strong>Faculty</strong> teaches <strong>Subject</strong> to <strong>Section</strong> as <strong>Type</strong>, <strong>N sessions/week</strong></li>
            <li>For <strong>Labs</strong> requiring multiple faculty: add <strong>multiple rows</strong> with same Section+Subject+Type, different Faculty</li>
            <li>Required sessions = total sessions needed per week across all faculty for that Section+Subject+Type</li>
            <li>The generator will schedule exactly this many sessions per week</li>
          </ul>
        </div>
      </div>

      {/* Grouped Allocations Table */}
      <Card>
        <CardHeader className="p-4 border-b border-secondary-200">
          {/* Title left, weekly counter right; wraps on narrow windows
              instead of overlapping. */}
          <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
            <h3 className="text-lg font-semibold text-secondary-900">Allocations by Section & Subject</h3>
            <div className="flex items-baseline gap-x-2 text-sm" data-testid="weekly-session-counter">
              <span className={sessionCounter.exceededBy ? 'font-semibold text-danger-600' : 'font-semibold text-secondary-900'}>
                {sessionCounter.allocated} / {sessionCounter.capacity}
              </span>
              <span className="text-secondary-500">sessions/week</span>
              {sessionCounter.exceededBy ? (
                <span className="font-medium text-danger-600">capacity exceeded (+{sessionCounter.exceededBy})</span>
              ) : (
                <>
                  <span className="text-secondary-300" aria-hidden="true">·</span>
                  <span className="text-secondary-500">{sessionCounter.remaining} remaining</span>
                </>
              )}
            </div>
          </div>
        </CardHeader>
        <CardBody className="p-0">
          {groupedAllocations.length === 0 ? (
            <div className="p-8 text-center text-secondary-500">
              <p className="text-lg font-medium text-secondary-700 mb-2">No teaching allocations yet</p>
              <p className="text-secondary-500">Click "Add Allocation" to define teaching assignments</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow className="bg-secondary-50">
                    <TableHead className="w-1/4">Section</TableHead>
                    <TableHead className="w-1/4">Subject</TableHead>
                    <TableHead className="w-1/5">Type</TableHead>
                    <TableHead className="w-1/5">Sessions/Week</TableHead>
                    <TableHead className="w-1/5">Faculty</TableHead>
                    <TableHead className="w-1/6">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {groupedAllocations.map((group, index) => (
                    <TableRow key={`${group.sectionId}-${group.subjectId}-${group.classType}`} className={index % 2 === 0 ? 'bg-white' : 'bg-secondary-50/50'}>
                      <TableCell className="font-medium">
                        <div>{group.sectionName}</div>
                        <div className="text-xs text-secondary-500">Semester {group.semester}</div>
                      </TableCell>
                      <TableCell>{group.subjectName}</TableCell>
                      <TableCell>
                        <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${group.classType === 'LAB' ? 'bg-primary-100 text-primary-800' : 'bg-secondary-100 text-secondary-800'}`}>
                          {group.classType}
                        </span>
                      </TableCell>
                      <TableCell className="font-mono text-lg font-semibold text-secondary-700">
                        {group.totalRequiredSessions} / week
                      </TableCell>
                      <TableCell className="whitespace-nowrap">
                        {/* Plain stacked text, one teacher per line. A former
                            rounded-full pill shrank to the column's minimum
                            (longest word) and wrapped the name INSIDE the grey
                            bubble, which made the table look broken. */}
                        <div className="space-y-0.5 leading-normal">
                          {group.faculty.map((f: any) => (
                            <div key={f.allocationId}>{f.name} ({f.requiredSessions})</div>
                          ))}
                        </div>
                      </TableCell>
                      <TableCell>
                        {/* nowrap keeps every action icon on ONE row; the table
                            wrapper scrolls horizontally on narrow windows. */}
                        <div className="flex items-center gap-1.5 whitespace-nowrap">
                          {group.faculty.map((f: any) => (
                            <div key={f.allocationId} className="flex items-center gap-1.5">
                              <Button
                                variant="ghost"
                                size="icon"
                                onClick={() => handleEdit({
                                  id: f.allocationId,
                                  facultyId: f.id,
                                  sectionId: group.sectionId,
                                  subjectId: group.subjectId,
                                  classType: group.classType,
                                  requiredSessionsPerWeek: f.requiredSessions,
                                })}
                                title={`Edit ${f.name}'s allocation`}
                                aria-label={`Edit ${f.name}'s allocation`}
                              >
                                <svg aria-hidden="true" className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"></path></svg>
                              </Button>
                              <Button
                                variant="ghost"
                                size="icon"
                                className="text-danger-600 hover:text-danger-700 hover:bg-danger-50"
                                onClick={() => handleDelete(f.allocationId)}
                                disabled={deletingId !== null}
                                title={`Delete ${f.name}'s allocation`}
                                aria-label={`Delete ${f.name}'s allocation`}
                              >
                                <svg aria-hidden="true" className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"></path></svg>
                              </Button>
                            </div>
                          ))}
                          {/* The group ("delete all") button only exists when
                              there is something extra to delete: with a single
                              teacher it performed the exact same operation as
                              that teacher's own delete button, rendering a
                              confusing second trash icon. */}
                          {group.faculty.length > 1 && (
                            <Button
                              variant="ghost"
                              size="icon"
                              className="text-danger-600 hover:text-danger-700 hover:bg-danger-50"
                              onClick={() => handleDeleteGroup(group)}
                              disabled={deletingId !== null}
                              title="Delete all allocations for this Section+Subject+Type"
                              aria-label="Delete all allocations for this Section+Subject+Type"
                            >
                              <svg aria-hidden="true" className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"></path></svg>
                            </Button>
                          )}
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardBody>
      </Card>

      {/* Add/Edit Dialog */}
      <Dialog open={showForm} onOpenChange={setShowForm}>
        <div className="max-w-md max-h-[90vh] overflow-y-auto">
          <div className="flex items-start justify-between p-6 border-b border-secondary-200">
            <div>
              <h2 id="dialog-title" className="text-lg font-semibold text-secondary-900">
                {editingAllocation ? 'Edit Teaching Allocation' : 'Add Teaching Allocation'}
              </h2>
              <p id="dialog-description" className="mt-1 text-sm text-secondary-500">
                Define a teaching assignment: which faculty teaches which subject to which section, how many periods per week.
              </p>
            </div>
            <button
              onClick={handleCancel}
              className="p-1.5 rounded-lg text-secondary-500 hover:bg-secondary-100 transition-colors"
              aria-label="Close dialog"
            >
              <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12"></path></svg>
            </button>
          </div>
          <form onSubmit={handleSubmit} className="space-y-4 p-6">
            {formError && (
              <div className="p-3 text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg">
                {formError}
              </div>
            )}
            <div>
              <label className="block text-sm font-medium text-secondary-700 mb-1">Faculty *</label>
              <select
                value={formData.facultyId}
                onChange={(e) => setFormData({...formData, facultyId: e.target.value})}
                className="w-full rounded-lg border px-3 py-2 text-sm bg-white focus:outline-none focus:ring-1 focus:ring-primary-500 border-secondary-300"
                required
              >
                <option value="">Select faculty</option>
                {faculty.map(f => (
                  <option key={f.id} value={f.id}>{f.name} ({f.departmentId})</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-secondary-700 mb-1">Section / Class *</label>
              <select
                value={formData.sectionId}
                onChange={(e) => setFormData({...formData, sectionId: e.target.value})}
                className="w-full rounded-lg border px-3 py-2 text-sm bg-white focus:outline-none focus:ring-1 focus:ring-primary-500 border-secondary-300"
                required
              >
                <option value="">Select section</option>
                {sections.map(s => (
                  <option key={s.id} value={s.id}>{s.name} (Sem {s.semester})</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-secondary-700 mb-1">Subject *</label>
              <select
                value={formData.subjectId}
                onChange={(e) => setFormData({...formData, subjectId: e.target.value})}
                className="w-full rounded-lg border px-3 py-2 text-sm bg-white focus:outline-none focus:ring-1 focus:ring-primary-500 border-secondary-300"
                required
              >
                <option value="">Select subject</option>
                {subjects.map(s => (
                  <option key={s.id} value={s.id}>{s.name} ({s.code})</option>
                ))}
              </select>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-secondary-700 mb-1">Class Type *</label>
                <select
                  value={formData.classType}
                  onChange={(e) => setFormData({...formData, classType: e.target.value})}
                  className="w-full rounded-lg border px-3 py-2 text-sm bg-white focus:outline-none focus:ring-1 focus:ring-primary-500 border-secondary-300"
                  required
                >
                  {CLASS_TYPES.map(c => (
                    <option key={c.value} value={c.value}>{c.label}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-secondary-700 mb-1">Sessions per Week *</label>
                <input
                  type="number"
                  min="1"
                  max="10"
                  value={formData.requiredSessionsPerWeek}
                  onChange={e => setFormData({...formData, requiredSessionsPerWeek: parseInt(e.target.value) || 1})}
                  className="w-full rounded-lg border px-3 py-2 text-sm bg-white focus:outline-none focus:ring-1 focus:ring-primary-500 border-secondary-300"
                  required
                />
              </div>
            </div>
            <div className="flex items-center justify-end gap-2 pt-4 border-t border-secondary-200">
              <button type="button" onClick={handleCancel} className="inline-flex items-center justify-center px-4 py-2 text-sm font-medium text-secondary-700 bg-white border border-secondary-300 rounded-lg hover:bg-secondary-50 transition-colors">
                Cancel
              </button>
              <button type="submit" disabled={deletingId !== null} className="inline-flex items-center justify-center px-4 py-2 text-sm font-medium text-white bg-primary-600 border border-transparent rounded-lg hover:bg-primary-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-primary-500 disabled:opacity-50 disabled:cursor-not-allowed">
                {editingAllocation ? 'Update' : 'Create'}
              </button>
            </div>
          </form>
        </div>
      </Dialog>
    </div>
  )
}