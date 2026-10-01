import { useState, useMemo, useEffect } from 'react'
import { Plus, Edit, Trash2, BookOpen } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Card, CardBody } from '@/components/ui/Card'
import { Badge } from '@/components/ui/Badge'
import { Input } from '@/components/ui/Input'
import { Select, SelectOption } from '@/components/ui/Select'
import { Dialog, DialogHeader, DialogContent, DialogFooter } from '@/components/ui/Dialog'
import { useAppStore } from '@/stores/appStore'
import { subjectRepository, departmentRepository, facultyRepository } from '@/db/repositories'
import { Subject, ClassType, CLASS_TYPES } from '@/types'

export function Subjects() {
  const { currentAcademicYear } = useAppStore()
  const [searchQuery, setSearchQuery] = useState('')
  const [filterDepartment, setFilterDepartment] = useState('')
  const [showForm, setShowForm] = useState(false)
  const [editingSubject, setEditingSubject] = useState<Subject | null>(null)
  const [formData, setFormData] = useState({
    name: '',
    code: '',
    departmentId: '',
    defaultClassType: 'LECTURE' as ClassType,
  })

  const departments = useMemo(() => departmentRepository.findAll(), [])
  const faculty = useMemo(() => facultyRepository.findActive(), [])

  const [subjects, setSubjects] = useState<Subject[]>([])
  useEffect(() => {
    setSubjects(subjectRepository.findAll())
  }, [])

  const filtered = useMemo(() => {
    return subjects.filter(s => {
      if (searchQuery && !s.name.toLowerCase().includes(searchQuery.toLowerCase()) && !s.code.toLowerCase().includes(searchQuery.toLowerCase())) return false
      if (filterDepartment && s.departmentId !== filterDepartment) return false
      return true
    })
  }, [subjects, searchQuery, filterDepartment])

  const handleSubmit = () => {
    if (!formData.name.trim()) { alert('Name is required'); return }
    if (!formData.code.trim()) { alert('Code is required'); return }
    if (!formData.departmentId) { alert('Department is required'); return }

    const data = {
      name: formData.name.trim(),
      code: formData.code.trim(),
      departmentId: formData.departmentId,
      defaultClassType: formData.defaultClassType,
    }

    try {
      if (editingSubject) {
        subjectRepository.update(editingSubject.id, data)
      } else {
        subjectRepository.create({ id: crypto.randomUUID(), ...data })
      }

      setShowForm(false)
      setEditingSubject(null)
      resetForm()
      setSubjects(subjectRepository.findAll())
    } catch (error) {
      const raw = error instanceof Error ? error.message : String(error)
      alert(
        /UNIQUE constraint failed: subjects.code/i.test(raw)
          ? 'Another subject already uses that code.'
          : /FOREIGN KEY constraint failed/i.test(raw)
            ? 'The selected department no longer exists. Refresh the page and try again.'
            : error instanceof Error && !/constraint|SQLITE|database/i.test(raw)
              ? raw
              : 'Could not save the subject. Please try again.'
      )
    }
  }

  const handleEdit = (s: Subject) => {
    setEditingSubject(s)
    setFormData({ name: s.name, code: s.code, departmentId: s.departmentId, defaultClassType: s.defaultClassType })
    setShowForm(true)
  }

  const handleDelete = (id: string) => {
    if (!confirm('Delete this subject? Faculty subject mappings will also be removed. A subject used in the timetable cannot be deleted.')) return
    try {
      subjectRepository.delete(id)
      setSubjects(subjectRepository.findAll())
    } catch (error) {
      alert(
        /FOREIGN KEY constraint failed/i.test(String(error))
          ? 'This subject is still referenced and cannot be deleted.'
          : error instanceof Error ? error.message : 'Could not delete the subject.'
      )
    }
  }

  const resetForm = () => {
    setFormData({ name: '', code: '', departmentId: '', defaultClassType: 'LECTURE' })
  }

  const departmentFilterOptions: SelectOption[] = [{ value: '', label: 'All Departments' }, ...departments.map(d => ({ value: d.id, label: d.name }))]
  const departmentFormOptions: SelectOption[] = departments.map(d => ({ value: d.id, label: d.name }))
  const classTypeOptions: SelectOption[] = CLASS_TYPES.map(c => ({ value: c.value, label: c.label }))

  const getFacultyCount = (subjectId: string) => {
    return faculty.filter(f => facultyRepository.isQualifiedForSubject(f.id, subjectId)).length
  }

  return (
    <div className="max-w-7xl mx-auto space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-secondary-900">Subjects</h1>
          <p className="text-secondary-500">Manage subjects offered by your college</p>
        </div>
        <Button onClick={() => { resetForm(); setEditingSubject(null); setShowForm(true); }}>
          <Plus className="h-4 w-4" />
          Add Subject
        </Button>
      </div>

      <Card>
        <CardBody className="flex flex-wrap items-center gap-4">
          <Input placeholder="Search subjects..." value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)} className="w-64" />
          <Select value={filterDepartment} onChange={setFilterDepartment} options={departmentFilterOptions} className="w-48" placeholder="Department" />
        </CardBody>
      </Card>

      <Card>
        <CardBody className="p-0">
          {filtered.length === 0 ? (
            <div className="p-8 text-center text-secondary-500">
              <BookOpen className="h-12 w-12 mx-auto text-secondary-300 mb-4" />
              <p>No subjects found</p>
            </div>
          ) : (
            <div className="divide-y divide-secondary-200">
              {filtered.map(s => (
                <div key={s.id} className="p-4 hover:bg-secondary-50 transition-colors flex items-center justify-between">
                  <div className="flex items-center gap-4">
                    <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary-50 text-primary-600">
                      <BookOpen className="h-5 w-5" />
                    </div>
                    <div>
                      <div className="flex items-center gap-2">
                        <h3 className="font-medium text-secondary-900">{s.name}</h3>
                        <Badge variant="neutral">{s.code}</Badge>
                        <Badge variant={s.defaultClassType === 'LAB' ? 'info' : 'neutral'}>{s.defaultClassType}</Badge>
                      </div>
                      <p className="text-sm text-secondary-500 mt-0.5">
                        {departments.find(d => d.id === s.departmentId)?.name ?? s.departmentId} • {getFacultyCount(s.id)} qualified faculty
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <Button variant="ghost" size="sm" onClick={() => handleEdit(s)} aria-label={`Edit ${s.name}`}><Edit className="h-4 w-4" /></Button>
                    <Button variant="ghost" size="sm" onClick={() => handleDelete(s.id)} aria-label={`Delete subject ${s.name}`} className="text-danger-600 hover:text-danger-700"><Trash2 className="h-4 w-4" /></Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardBody>
      </Card>

      <Dialog open={showForm} onOpenChange={setShowForm}>
        <DialogHeader title={editingSubject ? 'Edit Subject' : 'Add Subject'} />
        <DialogContent className="space-y-4">
          <Input label="Subject Name" value={formData.name} onChange={(e) => setFormData(prev => ({ ...prev, name: e.target.value }))} required />
          <Input label="Code" value={formData.code} onChange={(e) => setFormData(prev => ({ ...prev, code: e.target.value }))} required />
          <Select label="Department" value={formData.departmentId} onChange={(v) => setFormData(prev => ({ ...prev, departmentId: v }))} options={departmentFormOptions} required />
          <Select label="Default Class Type" value={formData.defaultClassType} onChange={(v) => setFormData(prev => ({ ...prev, defaultClassType: v as ClassType }))} options={classTypeOptions} />
        </DialogContent>
        <DialogFooter>
          <Button variant="secondary" onClick={() => { setShowForm(false); setEditingSubject(null); }}>Cancel</Button>
          <Button onClick={handleSubmit}>{editingSubject ? 'Update' : 'Create'}</Button>
        </DialogFooter>
      </Dialog>
    </div>
  )
}