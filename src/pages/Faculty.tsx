import { useState, useMemo, useEffect } from 'react'
import { Plus, Edit, Trash2, User, BookOpen, Calendar, Award, AlertCircle, CheckCircle, XCircle, Search } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Card, CardBody } from '@/components/ui/Card'
import { Badge } from '@/components/ui/Badge'
import { Input } from '@/components/ui/Input'
import { Select, SelectOption } from '@/components/ui/Select'
import { Dialog, DialogHeader, DialogContent, DialogFooter } from '@/components/ui/Dialog'
import { useAppStore } from '@/stores/appStore'
import { facultyRepository, departmentRepository, subjectRepository, sectionRepository } from '@/db/repositories'
import type { Faculty as FacultyType } from '@/types'
import { cn } from '@/utils/cn'

export function Faculty() {
  const { currentAcademicYear } = useAppStore()
  const [searchQuery, setSearchQuery] = useState('')
  const [filterDepartment, setFilterDepartment] = useState('')
  const [filterStatus, setFilterStatus] = useState<'all' | 'active' | 'inactive'>('all')
  const [showForm, setShowForm] = useState(false)
  const [editingFaculty, setEditingFaculty] = useState<FacultyType | null>(null)
  const [formData, setFormData] = useState({
    name: '',
    employeeId: '',
    departmentId: '',
    isActive: true,
    // Raw strings while editing: a controlled number input plus parseInt(x) || 0
    // silently turned "clear the field" into a meaningful 0 on every keystroke.
    maxDailySubstitutions: '2',
    priority: '0',
    notes: '',
    subjectIds: [] as string[],
    sectionIds: [] as string[],
  })

  const departments = useMemo(() => departmentRepository.findAll(), [])
  const allSubjects = useMemo(() => subjectRepository.findAll(), [])
  const allSections = useMemo(() => 
    currentAcademicYear ? sectionRepository.findByAcademicYear(currentAcademicYear.id) : [], 
    [currentAcademicYear]
  )

  const [facultyList, setFacultyList] = useState<FacultyType[]>([])
  useEffect(() => {
    setFacultyList(facultyRepository.findAll())
  }, [])

  const filteredFaculty = useMemo(() => {
    return facultyList.filter(f => {
      if (searchQuery && !f.name.toLowerCase().includes(searchQuery.toLowerCase())) return false
      if (filterDepartment && f.departmentId !== filterDepartment) return false
      if (filterStatus === 'active' && !f.isActive) return false
      if (filterStatus === 'inactive' && f.isActive) return false
      return true
    })
  }, [facultyList, searchQuery, filterDepartment, filterStatus])

  const handleSubmit = () => {
    if (!formData.name.trim()) { alert('Name is required'); return }
    if (!formData.departmentId) { alert('Department is required'); return }

    const maxDailySubstitutions = Number(formData.maxDailySubstitutions)
    if (!Number.isInteger(maxDailySubstitutions) || maxDailySubstitutions < 0) {
      alert('Max daily substitutions must be a whole number of 0 or more.')
      return
    }
    const priority = Number(formData.priority)
    if (!Number.isInteger(priority) || priority < 0) {
      alert('Priority must be a whole number of 0 or more.')
      return
    }

    const data = {
      name: formData.name.trim(),
      employeeId: formData.employeeId.trim() || undefined,
      departmentId: formData.departmentId,
      isActive: formData.isActive,
      maxDailySubstitutions,
      priority,
      notes: formData.notes,
    }

    try {
      if (editingFaculty) {
        // Keep existing proficiency values for subjects that stay mapped, so an
        // unrelated edit never resets them to the default.
        const existing = facultyRepository.getWithRelations(editingFaculty.id)
        const priorProficiency = new Map<string, number>(
          (existing?.subjects ?? []).map((s: any) => [s.id, s.proficiency ?? 3])
        )
        facultyRepository.update(editingFaculty.id, data)
        facultyRepository.setSubjects(
          editingFaculty.id,
          formData.subjectIds.map(id => ({
            facultyId: editingFaculty.id,
            subjectId: id,
            proficiency: priorProficiency.get(id) ?? 3,
          }))
        )
        facultyRepository.setSections(editingFaculty.id, formData.sectionIds)
      } else {
        const newFaculty = facultyRepository.create({ id: crypto.randomUUID(), ...data })
        facultyRepository.setSubjects(newFaculty.id, formData.subjectIds.map(id => ({ facultyId: newFaculty.id, subjectId: id, proficiency: 3 })))
        facultyRepository.setSections(newFaculty.id, formData.sectionIds)
      }

      setShowForm(false)
      setEditingFaculty(null)
      resetForm()
      setFacultyList(facultyRepository.findAll())
    } catch (error) {
      const raw = error instanceof Error ? error.message : String(error)
      alert(
        /UNIQUE constraint failed: faculty.employee_id/i.test(raw)
          ? 'Another faculty member already uses that Employee ID.'
          : /FOREIGN KEY constraint failed/i.test(raw)
            ? 'One of the selected subjects or sections no longer exists. Refresh the page and try again.'
            : error instanceof Error && !/constraint|SQLITE|database/i.test(raw)
              ? raw
              : 'Could not save the faculty member. Please try again.'
      )
    }
  }

  const handleEdit = (f: FacultyType) => {
    const withRelations = facultyRepository.getWithRelations(f.id)
    setEditingFaculty(f)
    setFormData({
      name: f.name,
      employeeId: f.employeeId || '',
      departmentId: f.departmentId,
      isActive: f.isActive,
      maxDailySubstitutions: String(f.maxDailySubstitutions),
      priority: String(f.priority),
      notes: f.notes || '',
      subjectIds: withRelations?.subjects?.map((s: any) => s.id) || [],
      sectionIds: withRelations?.sections?.map((s: any) => s.id) || [],
    })
    setShowForm(true)
  }

  const handleDelete = (id: string) => {
    if (!confirm('Delete this faculty member? Their subject mappings, section mappings and attendance records will also be removed. A faculty member scheduled in the timetable cannot be deleted. This cannot be undone.')) return
    try {
      const removed = facultyRepository.delete(id)
      if (!removed) {
        alert('This faculty member no longer exists. The list has been refreshed.')
      }
      setFacultyList(facultyRepository.findAll())
    } catch (error) {
      alert(
        /FOREIGN KEY constraint failed/i.test(String(error))
          ? 'This faculty member is still referenced and cannot be deleted.'
          : error instanceof Error ? error.message : 'Could not delete the faculty member.'
      )
    }
  }

  const resetForm = () => {
    setFormData({
      name: '',
      employeeId: '',
      departmentId: '',
      isActive: true,
      maxDailySubstitutions: '2',
      priority: '0',
      notes: '',
      subjectIds: [],
      sectionIds: [],
    })
  }

  const departmentOptions: SelectOption[] = [{ value: '', label: 'All Departments' }, ...departments.map(d => ({ value: d.id, label: d.name }))]
  const departmentFormOptions: SelectOption[] = departments.map(d => ({ value: d.id, label: d.name }))
  const subjectOptions: SelectOption[] = allSubjects.map(s => ({ value: s.id, label: s.name }))
  const sectionOptions: SelectOption[] = allSections.map(s => ({ value: s.id, label: s.name }))

  return (
    <div className="max-w-7xl mx-auto space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-secondary-900">Faculty Management</h1>
          <p className="text-secondary-500">Manage faculty profiles, subjects, and teaching assignments</p>
        </div>
        <Button onClick={() => { resetForm(); setEditingFaculty(null); setShowForm(true); }}>
          <Plus className="h-4 w-4" />
          Add Faculty
        </Button>
      </div>

      <Card>
        <CardBody className="flex flex-wrap items-center gap-4">
          <Input placeholder="Search faculty..." value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)} className="w-64" />
          <Select value={filterDepartment} onChange={setFilterDepartment} options={departmentOptions} className="w-48" placeholder="Department" />
          <Select value={filterStatus} onChange={(v) => setFilterStatus(v as 'all' | 'active' | 'inactive')} options={[
            { value: 'all', label: 'All' },
            { value: 'active', label: 'Active' },
            { value: 'inactive', label: 'Inactive' },
          ]} className="w-40" placeholder="Status" />
        </CardBody>
      </Card>

      <Card>
        <CardBody className="p-0">
          {filteredFaculty.length === 0 ? (
            <div className="p-8 text-center text-secondary-500">
              <User className="h-12 w-12 mx-auto text-secondary-300 mb-4" />
              <p>No faculty found</p>
            </div>
          ) : (
            <div className="divide-y divide-secondary-200">
              {filteredFaculty.map(f => {
                const withRelations = facultyRepository.getWithRelations(f.id)
                const subjectsTaught = withRelations?.subjects?.length || 0
                const sectionsTaught = withRelations?.sections?.length || 0
                return (
                  <div key={f.id} className="p-4 hover:bg-secondary-50 transition-colors">
                    <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
                      <div className="flex items-center gap-4">
                        <div className={cn('flex h-12 w-12 items-center justify-center rounded-full', f.isActive ? 'bg-primary-100 text-primary-600' : 'bg-secondary-100 text-secondary-400')}>
                          <User className="h-6 w-6" />
                        </div>
                        <div>
                          <div className="flex items-center gap-2">
                            <h3 className="font-medium text-secondary-900">{f.name}</h3>
                            <Badge variant={f.isActive ? 'success' : 'neutral'}>
                              {f.isActive ? 'Active' : 'Inactive'}
                            </Badge>
                          </div>
                          <div className="flex flex-wrap items-center gap-3 text-sm text-secondary-500 mt-1">
                            {f.employeeId && <span>ID: {f.employeeId}</span>}
                            <span>{departments.find(d => d.id === f.departmentId)?.name ?? f.departmentId}</span>
                            <span>{subjectsTaught} subjects</span>
                            <span>{sectionsTaught} sections</span>
                            <span>Max subs/day: {f.maxDailySubstitutions}</span>
                          </div>
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        <Button variant="ghost" size="sm" onClick={() => handleEdit(f)} aria-label={`Edit ${f.name}`}>
                          <Edit className="h-4 w-4" />
                        </Button>
                        <Button variant="ghost" size="sm" onClick={() => handleDelete(f.id)} aria-label={`Delete ${f.name}`} className="text-danger-600 hover:text-danger-700">
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                    </div>
                    
                    {(subjectsTaught > 0 || sectionsTaught > 0) && (
                      <div className="mt-3 pt-3 border-t border-secondary-100">
                        <div className="flex flex-wrap gap-2">
                          {withRelations?.subjects?.map((s: any) => (
                            <Badge key={s.id} variant="info">{s.name}</Badge>
                          ))}
                          {withRelations?.sections?.map((s: any) => (
                            <Badge key={s.id} variant="neutral">{s.name}</Badge>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </CardBody>
      </Card>

      <Dialog open={showForm} onOpenChange={setShowForm}>
        <DialogHeader 
          title={editingFaculty ? 'Edit Faculty' : 'Add Faculty'} 
          description={editingFaculty ? 'Update faculty information' : 'Create a new faculty member'}
        />
        <DialogContent className="space-y-4 max-h-[80vh] overflow-y-auto">
          <div className="grid gap-4 md:grid-cols-2">
            <Input label="Name" value={formData.name} onChange={(e) => setFormData(prev => ({ ...prev, name: e.target.value }))} required />
            <Input label="Employee ID" value={formData.employeeId} onChange={(e) => setFormData(prev => ({ ...prev, employeeId: e.target.value }))} />
            <Select label="Department" value={formData.departmentId} onChange={(v) => setFormData(prev => ({ ...prev, departmentId: v }))} options={departmentFormOptions} required />
            <Input
              label="Max Daily Substitutions"
              type="number"
              min={0}
              value={formData.maxDailySubstitutions}
              onChange={(e) => setFormData(prev => ({ ...prev, maxDailySubstitutions: e.target.value }))}
              helperText={
                formData.maxDailySubstitutions === '0'
                  ? '0 = this teacher is never asked to substitute.'
                  : 'Applies per day (default 2).'
              }
            />
            <Input
              label="Priority (lower = higher)"
              type="number"
              value={formData.priority}
              onChange={(e) => setFormData(prev => ({ ...prev, priority: e.target.value }))}
            />
          </div>
          
          <div>
            <label className="block text-sm font-medium text-secondary-700 mb-2">Subjects Qualified to Teach</label>
            <div className="flex flex-wrap gap-2">
              {subjectOptions.map(opt => (
                <label key={opt.value} className="inline-flex items-center gap-2 px-3 py-1.5 border border-secondary-300 rounded-lg cursor-pointer hover:bg-secondary-50 transition-colors">
                  <input
                    type="checkbox"
                    checked={formData.subjectIds.includes(opt.value)}
                    onChange={(e) => setFormData(prev => ({
                      ...prev,
                      subjectIds: e.target.checked 
                        ? [...prev.subjectIds, opt.value] 
                        : prev.subjectIds.filter(id => id !== opt.value)
                    }))}
                    className="h-4 w-4 rounded border-secondary-300 text-primary-600 focus:ring-2 focus:ring-primary-500"
                  />
                  <span className="text-sm">{opt.label}</span>
                </label>
              ))}
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-secondary-700 mb-2">Normally Teaches Sections</label>
            <div className="flex flex-wrap gap-2">
              {sectionOptions.map(opt => (
                <label key={opt.value} className="inline-flex items-center gap-2 px-3 py-1.5 border border-secondary-300 rounded-lg cursor-pointer hover:bg-secondary-50 transition-colors">
                  <input
                    type="checkbox"
                    checked={formData.sectionIds.includes(opt.value)}
                    onChange={(e) => setFormData(prev => ({
                      ...prev,
                      sectionIds: e.target.checked 
                        ? [...prev.sectionIds, opt.value] 
                        : prev.sectionIds.filter(id => id !== opt.value)
                    }))}
                    className="h-4 w-4 rounded border-secondary-300 text-primary-600 focus:ring-2 focus:ring-primary-500"
                  />
                  <span className="text-sm">{opt.label}</span>
                </label>
              ))}
            </div>
          </div>

          <Input label="Notes" value={formData.notes} onChange={(e) => setFormData(prev => ({ ...prev, notes: e.target.value }))} />

          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={formData.isActive}
              onChange={(e) => setFormData(prev => ({ ...prev, isActive: e.target.checked }))}
              className="h-4 w-4 rounded border-secondary-300 text-primary-600 focus:ring-2 focus:ring-primary-500"
            />
            <span className="text-sm text-secondary-700">Active</span>
          </label>
        </DialogContent>
        <DialogFooter>
          <Button variant="secondary" onClick={() => { setShowForm(false); setEditingFaculty(null); resetForm(); }}>Cancel</Button>
          <Button onClick={handleSubmit}>{editingFaculty ? 'Update' : 'Create'}</Button>
        </DialogFooter>
      </Dialog>
    </div>
  )
}