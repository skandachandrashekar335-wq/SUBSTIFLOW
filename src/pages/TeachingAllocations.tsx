import { useState, useMemo, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAppStore } from '@/stores/appStore'
import { facultyRepository, sectionRepository, subjectRepository, subjectRequirementRepository } from '@/db/repositories'
import {
  createTeachingAllocation,
  updateTeachingAllocation,
  deleteTeachingAllocation,
  deleteTeachingAllocationsForActivity,
  getTeachingAllocationsForAcademicYear,
  getAllocationsGroupedBySectionSubject,
} from '@/services/timetableGeneration'
import { ClassType } from '@/types'
import { calculateSectionCapacities, weeklySessionCounter, WEEKLY_SESSION_CAPACITY } from '@/utils/weeklyCapacity'
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
  classType: 'LECTURE' as ClassType,
  requiredSessionsPerWeek: 1,
}

export function TeachingAllocations() {
  const { currentAcademicYear } = useAppStore()
  const [allocations, setAllocations] = useState<any[]>([])
  const [groupedAllocations, setGroupedAllocations] = useState<any[]>([])
  const [selectedSectionId, setSelectedSectionId] = useState<string>('')
  const [showForm, setShowForm] = useState(false)
  const [editingAllocation, setEditingAllocation] = useState<any | null>(null)
  const [formError, setFormError] = useState<string | null>(null)
  const [formData, setFormData] = useState(emptyFormData)
  const [deletingId, setDeletingId] = useState<string | null>(null)

  // Only teaching staff may hold allocations — non-teaching staff are filtered
  // out here and refused again in the service layer.
  const faculty = useMemo(
    () => facultyRepository.findActive().filter((f) => f.staffType === 'TEACHING'),
    []
  )
  const sections = useMemo(
    () => (currentAcademicYear ? sectionRepository.findByAcademicYear(currentAcademicYear.id) : []),
    [currentAcademicYear]
  )
  const subjects = useMemo(() => subjectRepository.findAll(), [])
  const requirements = useMemo(
    () => (currentAcademicYear ? subjectRequirementRepository.findByAcademicYear(currentAcademicYear.id) : []),
    [currentAcademicYear, allocations]
  )
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

  // Section-wise capacity calculation (distinguishes sessions from span-weighted periods)
  const capacitySummary = useMemo(() => {
    return calculateSectionCapacities({
      sections,
      requirements,
      allocations,
    })
  }, [sections, requirements, allocations])

  const activeSectionCapacity = useMemo(() => {
    if (!selectedSectionId) return null
    return capacitySummary.sections.find((s) => s.sectionId === selectedSectionId) ?? null
  }, [capacitySummary, selectedSectionId])

  // Active weekly session counter:
  // If a single section is selected (or only 1 section exists in the academic year),
  // compute capacity for that section (36).
  // If multiple sections exist and "All Sections" is selected, compare total against
  // aggregate capacity (sections.length * 36).
  const activeSessionCounter = useMemo(() => {
    const targetSectionId = selectedSectionId || (sections.length === 1 ? sections[0].id : null)
    if (targetSectionId) {
      const secAllocs = allocations.filter((a) => a.sectionId === targetSectionId)
      return weeklySessionCounter(secAllocs, WEEKLY_SESSION_CAPACITY)
    }
    const totalCapacity = sections.length > 0 ? sections.length * WEEKLY_SESSION_CAPACITY : WEEKLY_SESSION_CAPACITY
    return weeklySessionCounter(allocations, totalCapacity)
  }, [allocations, selectedSectionId, sections])

  // Filtered grouped allocations
  const displayedGroups = useMemo(() => {
    if (!selectedSectionId) return groupedAllocations
    return groupedAllocations.filter((g) => g.sectionId === selectedSectionId)
  }, [groupedAllocations, selectedSectionId])

  // Section requirement completeness check
  const sectionCompleteness = useMemo(() => {
    if (!selectedSectionId) return null
    const secReqs = requirements.filter((r) => r.sectionId === selectedSectionId)
    const secAllocs = allocations.filter((a) => a.sectionId === selectedSectionId)
    const coveredReqs = secReqs.filter((r) =>
      secAllocs.some((a) => a.subjectId === r.subjectId && a.classType === r.classType)
    )
    return {
      total: secReqs.length,
      allocated: coveredReqs.length,
      isComplete: secReqs.length > 0 && coveredReqs.length >= secReqs.length,
      missingCount: secReqs.length - coveredReqs.length,
    }
  }, [selectedSectionId, requirements, allocations])

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
      setFormData({ ...emptyFormData, sectionId: selectedSectionId || '' })
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
    setFormData({
      ...emptyFormData,
      sectionId: selectedSectionId || (sections[0]?.id ?? ''),
    })
    setShowForm(true)
  }

  const handleCancel = () => {
    setShowForm(false)
    setEditingAllocation(null)
    setFormData({ ...emptyFormData, sectionId: selectedSectionId || '' })
    setFormError(null)
  }

  const navigate = useNavigate()
  const handleGenerate = () => navigate('/generation')

  const totalRequiredSessions = capacitySummary.totalAllocatedSessions
  const totalFaculty = new Set(allocations.map((a) => a.facultyId)).size
  const totalSections = new Set(allocations.map((a) => a.sectionId)).size

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-secondary-900">Teaching Allocations</h1>
          <p className="text-secondary-600 mt-1">
            Academic Year: <span className="font-medium">{currentYear}</span>
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={handleNew}>
            <svg className="h-4 w-4 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
            </svg>
            Add Allocation
          </Button>
          <Button onClick={handleGenerate}>
            <svg className="h-4 w-4 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
            </svg>
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
            <div className="text-sm text-secondary-600">Weekly Sessions</div>
          </CardBody>
        </Card>
        <Card className="border-secondary-200">
          <CardBody className="p-4">
            <div className="text-2xl font-bold text-secondary-700">{capacitySummary.totalAllocatedPeriods} / {capacitySummary.totalCapacity}</div>
            <div className="text-sm text-secondary-600">Occupied Periods ({capacitySummary.utilizationPercent}%)</div>
          </CardBody>
        </Card>
        <Card className="border-secondary-200">
          <CardBody className="p-4">
            <div className="text-2xl font-bold text-secondary-700">{totalFaculty} / {totalSections}</div>
            <div className="text-sm text-secondary-600">Faculty / Sections</div>
          </CardBody>
        </Card>
      </div>

      {/* Section-Wise Capacity Summary Card */}
      <Card>
        <CardHeader className="p-4 border-b border-secondary-200">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h3 className="text-lg font-semibold text-secondary-900">Section-Wise Timetable Capacity</h3>
              <p className="text-xs text-secondary-500 mt-0.5">
                Each section has 36 teaching periods/week (6 days × 6 periods). Total capacity: {capacitySummary.totalCapacity} periods across {sections.length} sections.
              </p>
            </div>
            <div className="text-sm font-medium text-secondary-700">
              Aggregate: <span className="font-semibold text-primary-700">{capacitySummary.totalAllocatedPeriods}</span> / {capacitySummary.totalCapacity} periods ({capacitySummary.remainingPeriods} free)
            </div>
          </div>
        </CardHeader>
        <CardBody className="p-4">
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
            {capacitySummary.sections.map((sec) => {
              const isSelected = selectedSectionId === sec.sectionId
              return (
                <div
                  key={sec.sectionId}
                  onClick={() => setSelectedSectionId(isSelected ? '' : sec.sectionId)}
                  className={`cursor-pointer rounded-lg border p-3 transition-all ${
                    isSelected
                      ? 'border-primary-500 bg-primary-50/60 shadow-sm ring-1 ring-primary-500'
                      : 'border-secondary-200 bg-white hover:border-secondary-300 hover:bg-secondary-50/50'
                  }`}
                >
                  <div className="flex items-center justify-between mb-1.5">
                    <span className="font-semibold text-secondary-900 text-sm">{sec.sectionName}</span>
                    <span className="text-xs text-secondary-500">Sem {sec.semester}</span>
                  </div>
                  <div className="flex items-baseline justify-between text-xs mb-1">
                    <span className="text-secondary-600">
                      <strong className={sec.isOverCapacity ? 'text-red-600 font-bold' : 'text-secondary-900'}>
                        {sec.allocatedPeriods}
                      </strong>{' '}
                      / {sec.weeklyCapacity} periods
                    </span>
                    <span className={sec.isOverCapacity ? 'text-red-600 font-medium' : 'text-secondary-500'}>
                      {sec.isOverCapacity ? `+${sec.exceededBy} over` : `${sec.remainingPeriods} remaining`}
                    </span>
                  </div>
                  {/* Progress bar */}
                  <div className="w-full h-2 bg-secondary-100 rounded-full overflow-hidden">
                    <div
                      className={`h-full transition-all duration-300 rounded-full ${
                        sec.isOverCapacity
                          ? 'bg-red-500'
                          : sec.utilizationPercent >= 75
                            ? 'bg-primary-600'
                            : 'bg-primary-500'
                      }`}
                      style={{ width: `${Math.min(100, sec.utilizationPercent)}%` }}
                    />
                  </div>
                  <div className="flex items-center justify-between text-[11px] text-secondary-400 mt-1.5">
                    <span>{sec.allocatedSessions} weekly sessions</span>
                    <span>{sec.utilizationPercent}% load</span>
                  </div>
                </div>
              )
            })}
          </div>
        </CardBody>
      </Card>

      {/* Grouped Allocations Table */}
      <Card>
        <CardHeader className="p-4 border-b border-secondary-200">
          <div className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
              <div>
                <h3 className="text-lg font-semibold text-secondary-900">
                  {selectedSectionId
                    ? `Allocations for ${sections.find((s) => s.id === selectedSectionId)?.name ?? 'Selected Section'}`
                    : 'Allocations by Section & Subject'}
                </h3>
                {selectedSectionId && sectionCompleteness && (
                  <p className="text-xs text-secondary-500 mt-0.5">
                    {sectionCompleteness.isComplete ? (
                      <span className="text-green-700 font-medium">✓ All {sectionCompleteness.total} required curriculum subjects allocated</span>
                    ) : (
                      <span className="text-amber-700 font-medium">⚠ {sectionCompleteness.missingCount} of {sectionCompleteness.total} subjects missing teaching allocation</span>
                    )}
                  </p>
                )}
              </div>

              {/* Weekly counter in header with data-testid for compatibility */}
              <div className="flex items-baseline gap-x-2 text-sm" data-testid="weekly-session-counter">
                <span className={activeSessionCounter.exceededBy !== null ? 'font-semibold text-danger-600' : 'font-semibold text-secondary-900'}>
                  {activeSessionCounter.allocated} / {activeSessionCounter.capacity}
                </span>
                <span className="text-secondary-500">sessions/week</span>
                {activeSessionCounter.exceededBy !== null ? (
                  <span className="font-medium text-danger-600">
                    capacity exceeded (+{activeSessionCounter.exceededBy})
                  </span>
                ) : (
                  <>
                    <span className="text-secondary-300" aria-hidden="true">·</span>
                    <span className="text-secondary-500">{activeSessionCounter.remaining} remaining</span>
                  </>
                )}
                {activeSectionCapacity ? (
                  <span className="text-xs text-secondary-400 font-normal">
                    ({activeSectionCapacity.allocatedPeriods} periods occupied)
                  </span>
                ) : (
                  <span className="text-xs text-secondary-400 font-normal">
                    ({capacitySummary.totalAllocatedPeriods} periods occupied)
                  </span>
                )}
              </div>
            </div>

            {/* Section Filter Pills / Selector */}
            <div className="flex flex-wrap items-center gap-1.5 pt-2 border-t border-secondary-100">
              <span className="text-xs font-medium text-secondary-500 mr-1">Filter section:</span>
              <button
                type="button"
                onClick={() => setSelectedSectionId('')}
                className={`px-2.5 py-1 rounded-md text-xs font-medium transition-colors ${
                  selectedSectionId === ''
                    ? 'bg-secondary-900 text-white'
                    : 'bg-secondary-100 text-secondary-700 hover:bg-secondary-200'
                }`}
              >
                All Sections ({sections.length})
              </button>
              {sections.map((sec) => (
                <button
                  key={sec.id}
                  type="button"
                  onClick={() => setSelectedSectionId(sec.id)}
                  className={`px-2.5 py-1 rounded-md text-xs font-medium transition-colors ${
                    selectedSectionId === sec.id
                      ? 'bg-primary-600 text-white'
                      : 'bg-secondary-100 text-secondary-700 hover:bg-secondary-200'
                  }`}
                >
                  {sec.name}
                </button>
              ))}
            </div>
          </div>
        </CardHeader>
        <CardBody className="p-0">
          {displayedGroups.length === 0 ? (
            <div className="p-8 text-center text-secondary-500">
              <p className="text-lg font-medium text-secondary-700 mb-2">No teaching allocations found</p>
              <p className="text-secondary-500">
                {selectedSectionId ? 'No allocations for this section yet.' : 'Click "Add Allocation" to define teaching assignments.'}
              </p>
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
                  {displayedGroups.map((group, index) => (
                    <TableRow
                      key={`${group.sectionId}-${group.subjectId}-${group.classType}`}
                      className={index % 2 === 0 ? 'bg-white' : 'bg-secondary-50/50'}
                    >
                      <TableCell className="font-medium">
                        <div>{group.sectionName}</div>
                        <div className="text-xs text-secondary-500">Semester {group.semester}</div>
                      </TableCell>
                      <TableCell>{group.subjectName}</TableCell>
                      <TableCell>
                        <span
                          className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${
                            group.classType === 'LAB' ? 'bg-primary-100 text-primary-800' : 'bg-secondary-100 text-secondary-800'
                          }`}
                        >
                          {group.classType}
                        </span>
                      </TableCell>
                      <TableCell className="font-mono text-lg font-semibold text-secondary-700">
                        {group.totalRequiredSessions} / week
                      </TableCell>
                      <TableCell className="whitespace-nowrap">
                        <div className="space-y-0.5 leading-normal">
                          {group.faculty.map((f: any) => (
                            <div key={f.allocationId}>
                              {f.name} ({f.requiredSessions})
                            </div>
                          ))}
                        </div>
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-1.5 whitespace-nowrap">
                          {group.faculty.map((f: any) => (
                            <div key={f.allocationId} className="flex items-center gap-1.5">
                              <Button
                                variant="ghost"
                                size="icon"
                                onClick={() =>
                                  handleEdit({
                                    id: f.allocationId,
                                    facultyId: f.id,
                                    sectionId: group.sectionId,
                                    subjectId: group.subjectId,
                                    classType: group.classType,
                                    requiredSessionsPerWeek: f.requiredSessions,
                                  })
                                }
                                title={`Edit ${f.name}'s allocation`}
                                aria-label={`Edit ${f.name}'s allocation`}
                              >
                                <svg aria-hidden="true" className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                                </svg>
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
                                <svg aria-hidden="true" className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                                </svg>
                              </Button>
                            </div>
                          ))}
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
                              <svg aria-hidden="true" className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                              </svg>
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
              <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
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
                onChange={(e) => setFormData({ ...formData, facultyId: e.target.value })}
                className="w-full rounded-lg border px-3 py-2 text-sm bg-white focus:outline-none focus:ring-1 focus:ring-primary-500 border-secondary-300"
                required
              >
                <option value="">Select faculty</option>
                {faculty.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.name} ({f.departmentId})
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-secondary-700 mb-1">Section / Class *</label>
              <select
                value={formData.sectionId}
                onChange={(e) => setFormData({ ...formData, sectionId: e.target.value })}
                className="w-full rounded-lg border px-3 py-2 text-sm bg-white focus:outline-none focus:ring-1 focus:ring-primary-500 border-secondary-300"
                required
              >
                <option value="">Select section</option>
                {sections.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name} (Sem {s.semester})
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-secondary-700 mb-1">Subject *</label>
              <select
                value={formData.subjectId}
                onChange={(e) => setFormData({ ...formData, subjectId: e.target.value })}
                className="w-full rounded-lg border px-3 py-2 text-sm bg-white focus:outline-none focus:ring-1 focus:ring-primary-500 border-secondary-300"
                required
              >
                <option value="">Select subject</option>
                {subjects.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name} ({s.code})
                  </option>
                ))}
              </select>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-secondary-700 mb-1">Class Type *</label>
                <select
                  value={formData.classType}
                  onChange={(e) => setFormData({ ...formData, classType: e.target.value as ClassType })}
                  className="w-full rounded-lg border px-3 py-2 text-sm bg-white focus:outline-none focus:ring-1 focus:ring-primary-500 border-secondary-300"
                  required
                >
                  {CLASS_TYPES.map((c) => (
                    <option key={c.value} value={c.value}>
                      {c.label}
                    </option>
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
                  onChange={(e) =>
                    setFormData({ ...formData, requiredSessionsPerWeek: parseInt(e.target.value, 10) || 1 })
                  }
                  className="w-full rounded-lg border px-3 py-2 text-sm bg-white focus:outline-none focus:ring-1 focus:ring-primary-500 border-secondary-300"
                  required
                />
              </div>
            </div>
            <div className="flex items-center justify-end gap-2 pt-4 border-t border-secondary-200">
              <button
                type="button"
                onClick={handleCancel}
                className="inline-flex items-center justify-center px-4 py-2 text-sm font-medium text-secondary-700 bg-white border border-secondary-300 rounded-lg hover:bg-secondary-50 transition-colors"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={deletingId !== null}
                className="inline-flex items-center justify-center px-4 py-2 text-sm font-medium text-white bg-primary-600 border border-transparent rounded-lg hover:bg-primary-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-primary-500 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {editingAllocation ? 'Update' : 'Create'}
              </button>
            </div>
          </form>
        </div>
      </Dialog>
    </div>
  )
}
