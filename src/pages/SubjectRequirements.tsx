import { useState, useMemo, useEffect } from 'react'
import { Plus, Trash2, Edit2, X, Loader2, AlertCircle, HelpCircle } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Card, CardBody, CardHeader } from '@/components/ui/Card'
import { Badge } from '@/components/ui/Badge'
import { Input } from '@/components/ui/Input'
import { Dialog } from '@/components/ui/Dialog'
import { Table, TableHeader, TableBody, TableRow, TableCell, TableHead } from '@/components/ui/Table'
import { useAppStore } from '@/stores/appStore'
import { sectionRepository, subjectRepository, academicYearRepository } from '@/db/repositories'
import { createSubjectRequirement, updateSubjectRequirement, deleteSubjectRequirement, getSubjectRequirementsForAcademicYear, getSubjectRequirementsBySection } from '@/services/subjectRequirement'
import { ClassType, CLASS_TYPES, TEACHING_ARRANGEMENTS, TEACHING_ARRANGEMENT_LABELS, TeachingArrangement } from '@/types'
import { cn } from '@/utils/cn'

const emptyFormData = {
  sectionId: '',
  subjectId: '',
  classType: 'LECTURE' as any,
  requiredSessionsPerWeek: 1,
  span: 1,
  teachingArrangement: 'AUTO' as TeachingArrangement,
}

export function SubjectRequirements() {
  const { currentAcademicYear } = useAppStore()
  const [requirements, setRequirements] = useState<any[]>([])
  const [showForm, setShowForm] = useState(false)
  const [editingRequirement, setEditingRequirement] = useState<any | null>(null)
  const [formError, setFormError] = useState<string | null>(null)
  const [formData, setFormData] = useState({
    sectionId: '',
    subjectId: '',
    classType: 'LECTURE' as any,
    requiredSessionsPerWeek: 1,
    span: 1,
    teachingArrangement: 'AUTO' as TeachingArrangement,
  })
  const [deletingId, setDeletingId] = useState<string | null>(null)

  const sections = useMemo(() => currentAcademicYear ? sectionRepository.findByAcademicYear(currentAcademicYear.id) : [], [currentAcademicYear])
  const subjects = useMemo(() => subjectRepository.findAll(), [])
  const currentYear = currentAcademicYear?.name || '—'

  useEffect(() => {
    if (currentAcademicYear) {
      loadRequirements()
    }
  }, [currentAcademicYear])

  const loadRequirements = () => {
    if (!currentAcademicYear) return
    const reqs = getSubjectRequirementsForAcademicYear(currentAcademicYear.id)
    setRequirements(reqs)
  }

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    setFormError(null)
    try {
      if (editingRequirement) {
        updateSubjectRequirement(editingRequirement.id, formData)
      } else {
        createSubjectRequirement({ ...formData, academicYearId: currentAcademicYear!.id })
      }
      setShowForm(false)
      setEditingRequirement(null)
      setFormData({
        sectionId: '',
        subjectId: '',
        classType: 'LECTURE',
        requiredSessionsPerWeek: 1,
        span: 1,
        teachingArrangement: 'AUTO',
      })
      loadRequirements()
    } catch (error) {
      setFormError(error instanceof Error ? error.message : 'An error occurred')
    }
  }

  const handleDelete = (id: string) => {
    if (!confirm('Delete this subject requirement?')) return
    setDeletingId(id)
    try {
      deleteSubjectRequirement(id)
      loadRequirements()
    } catch (error) {
      alert(error instanceof Error ? error.message : 'Could not delete')
    } finally {
      setDeletingId(null)
    }
  }

  const handleEdit = (req: any) => {
    setEditingRequirement(req)
    setFormData({
      sectionId: req.sectionId,
      subjectId: req.subjectId,
      classType: req.classType,
      requiredSessionsPerWeek: req.requiredSessionsPerWeek,
      span: req.span || 1,
      teachingArrangement: req.teachingArrangement || 'AUTO',
    })
    setShowForm(true)
  }

  const handleNew = () => {
    setEditingRequirement(null)
    setFormData({
      sectionId: '',
      subjectId: '',
      classType: 'LECTURE',
      requiredSessionsPerWeek: 1,
      span: 1,
      teachingArrangement: 'AUTO',
    })
    setShowForm(true)
  }

  const handleCancel = () => {
    setShowForm(false)
    setEditingRequirement(null)
    setFormData({
      sectionId: '',
      subjectId: '',
      classType: 'LECTURE',
      requiredSessionsPerWeek: 1,
      span: 1,
      teachingArrangement: 'AUTO',
    })
    setFormError(null)
  }

  const arrangementShortLabel = (arrangement: string) =>
    arrangement === 'TEAM' ? 'Team' : arrangement === 'ALTERNATE' ? 'Alternate' : 'Auto'

  const badgeVariant = (type: string) => {
    switch (type) {
      case 'LAB': return 'default'
      default: return 'secondary'
    }
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-secondary-900">Subject Requirements</h1>
          <p className="text-secondary-600 mt-1">Academic Year: <span className="font-medium">{currentYear}</span></p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={handleNew}>
            <svg className="h-4 w-4 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4"></path></svg>
            Add Requirement
          </Button>
        </div>
      </div>

      {/* Help/Info */}
      <div className="p-4 text-sm text-info-800 bg-info-50 border border-info-200 rounded-lg flex items-start gap-3">
        <svg className="h-5 w-5 text-info-600 mt-0.5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"></path></svg>
        <div className="text-sm text-info-800 space-y-1">
          <p className="font-medium">Subject Requirements</p>
          <p className="text-sm">
            Define how many sessions per week each subject requires for each section.
            This is separate from Teaching Allocations (which defines who teaches what).
            Requirements drive the automatic timetable generator.
          </p>
          <ul className="list-disc list-inside space-y-1 text-sm mt-2">
            <li><strong>Section</strong> + <strong>Subject</strong> + <strong>Type</strong> + <strong>Sessions/Week</strong></li>
            <li><strong>Span</strong>: Number of consecutive periods (1 for lecture, 2 for 2-period lab)</li>
            <li><strong>Teaching Arrangement</strong>: <em>Team</em> puts every allocated teacher on every session (a lab run by three or five teachers together); <em>Alternate</em> gives each session exactly one teacher from the allocated, eligible teachers; <em>Automatic</em> keeps the historical rule (multi-teacher labs are teams). Configure it here — it is never guessed from a subject's name</li>
            <li>Labs automatically require <code>span ≥ 2</code> and will be scheduled as a single continuous block</li>
            <li>Requirements feed directly into the timetable generator</li>
          </ul>
        </div>
      </div>

      {/* Current Requirements Table */}
      <Card>
        <CardHeader className="p-4 border-b border-secondary-200">
          <h3 className="text-lg font-semibold text-secondary-900">Subject Requirements</h3>
        </CardHeader>
        <CardBody className="p-0">
          {requirements.length === 0 ? (
            <div className="p-8 text-center text-secondary-500">
              <p className="text-lg font-medium text-secondary-700 mb-2">No subject requirements yet</p>
              <p className="text-secondary-500">Click "Add Requirement" to define session requirements</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow className="bg-secondary-50">
                    <TableHead className="w-1/5">Section</TableHead>
                    <TableHead className="w-1/5">Subject</TableHead>
                    <TableHead className="w-1/6">Type</TableHead>
                    <TableHead className="w-1/6">Sessions/Week</TableHead>
                    <TableHead className="w-1/6">Span</TableHead>
                    <TableHead className="w-1/6">Teaching</TableHead>
                    <TableHead className="w-1/6">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {requirements.map((req, index) => (
                    <TableRow key={req.id} className={index % 2 === 0 ? 'bg-white' : 'bg-secondary-50/50'}>
                      <TableCell className="font-medium">
                        <div>{req.section?.name || req.sectionId}</div>
                        <div className="text-xs text-secondary-500">Semester {req.section?.semester || '?'}</div>
                      </TableCell>
                      <TableCell>{req.subject?.name || req.subjectId}</TableCell>
                      <TableCell>
                        <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${req.classType === 'LAB' ? 'bg-primary-100 text-primary-800' : 'bg-secondary-100 text-secondary-800'}`}>
                          {req.classType}
                        </span>
                      </TableCell>
                      <TableCell className="font-mono text-lg font-semibold text-secondary-700">
                        {req.requiredSessionsPerWeek} / week
                      </TableCell>
                      <TableCell className="font-mono text-lg font-semibold text-secondary-700">
                        {req.span} period{req.span > 1 ? 's' : ''}
                      </TableCell>
                      <TableCell>
                        <span
                          className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${
                            req.teachingArrangement === 'TEAM'
                              ? 'bg-primary-100 text-primary-800'
                              : req.teachingArrangement === 'ALTERNATE'
                                ? 'bg-warning-50 text-warning-700'
                                : 'bg-secondary-100 text-secondary-800'
                          }`}
                          title={TEACHING_ARRANGEMENT_LABELS[(req.teachingArrangement ?? 'AUTO') as TeachingArrangement]}
                        >
                          {arrangementShortLabel(req.teachingArrangement ?? 'AUTO')}
                        </span>
                      </TableCell>
                      <TableCell>
                        <div className="flex flex-wrap items-center gap-1.5">
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => handleEdit(req)}
                            title="Edit requirement"
                            aria-label="Edit requirement"
                          >
                            <svg aria-hidden="true" className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"></path></svg>
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="text-danger-600 hover:text-danger-700 hover:bg-danger-50"
                            onClick={() => handleDelete(req.id)}
                            disabled={deletingId !== null}
                            title="Delete requirement"
                            aria-label="Delete requirement"
                          >
                            <svg aria-hidden="true" className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"></path></svg>
                          </Button>
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
                {editingRequirement ? 'Edit Subject Requirement' : 'Add Subject Requirement'}
              </h2>
              <p id="dialog-description" className="mt-1 text-sm text-secondary-500">
                Define how many sessions per week a subject requires for a section.
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
            {/* min-h-10 (= two text-sm lines) + items-end keeps all three
                controls on ONE line even when a label wraps: in a max-w-md
                dialog "Sessions per Week *" wraps to two lines, which pushed
                its input ~20px below its neighbours. */}
            <div className="grid grid-cols-3 gap-4">
              <div>
                <label className="flex min-h-10 items-end text-sm font-medium text-secondary-700 mb-1">Class Type *</label>
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
                <label className="flex min-h-10 items-end text-sm font-medium text-secondary-700 mb-1">Sessions per Week *</label>
                <Input
                  type="number"
                  min="1"
                  max="10"
                  value={formData.requiredSessionsPerWeek}
                  onChange={e => setFormData({...formData, requiredSessionsPerWeek: parseInt(e.target.value) || 1})}
                  className="w-full"
                  required
                />
              </div>
              <div>
                <label className="flex min-h-10 items-end text-sm font-medium text-secondary-700 mb-1">Span (periods) *</label>
                <Input
                  type="number"
                  min="1"
                  max="4"
                  value={formData.span}
                  onChange={e => setFormData({...formData, span: parseInt(e.target.value) || 1})}
                  className="w-full"
                  required
                />
              </div>
            </div>
            <div>
              <label className="block text-sm font-medium text-secondary-700 mb-1">Teaching Arrangement *</label>
              <select
                value={formData.teachingArrangement}
                onChange={(e) => setFormData({...formData, teachingArrangement: e.target.value as TeachingArrangement})}
                className="w-full rounded-lg border px-3 py-2 text-sm bg-white focus:outline-none focus:ring-1 focus:ring-primary-500 border-secondary-300"
                required
              >
                {TEACHING_ARRANGEMENTS.map(a => (
                  <option key={a} value={a}>{TEACHING_ARRANGEMENT_LABELS[a]}</option>
                ))}
              </select>
              <p className="mt-1 text-xs text-secondary-500">
                How the teachers allocated to this requirement share its sessions: Team = every teacher on every
                session, Alternate = one teacher per session, Automatic = multi-teacher labs are teams and
                everything else alternates. At least two teachers are required for Team.
              </p>
            </div>
            <div className="flex items-center justify-end gap-2 pt-4 border-t border-secondary-200">
              <button type="button" onClick={handleCancel} className="inline-flex items-center justify-center px-4 py-2 text-sm font-medium text-secondary-700 bg-white border border-secondary-300 rounded-lg hover:bg-secondary-50 transition-colors">
                Cancel
              </button>
              <button type="submit" disabled={deletingId !== null} className="inline-flex items-center justify-center px-4 py-2 text-sm font-medium text-white bg-primary-600 border border-transparent rounded-lg hover:bg-primary-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-primary-500 disabled:opacity-50 disabled:cursor-not-allowed">
                {editingRequirement ? 'Update' : 'Create'}
              </button>
            </div>
          </form>
        </div>
      </Dialog>
    </div>
  )
}