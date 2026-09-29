import { useState, useMemo, useEffect } from 'react'
import { Link } from 'react-router-dom'
import { Plus, Edit, Trash2, Users, Calendar } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Card, CardBody } from '@/components/ui/Card'
import { Badge } from '@/components/ui/Badge'
import { Input } from '@/components/ui/Input'
import { Select, SelectOption } from '@/components/ui/Select'
import { Dialog, DialogHeader, DialogContent, DialogFooter } from '@/components/ui/Dialog'
import { useAppStore } from '@/stores/appStore'
import { sectionRepository, departmentRepository, timetableEntryRepository } from '@/db/repositories'
import { Section } from '@/types'

export function Classes() {
  const { currentAcademicYear } = useAppStore()
  const [searchQuery, setSearchQuery] = useState('')
  const [filterDepartment, setFilterDepartment] = useState('')
  const [showForm, setShowForm] = useState(false)
  const [editingSection, setEditingSection] = useState<Section | null>(null)
  const [formData, setFormData] = useState({
    name: '',
    semester: '1', // raw string while editing (see Faculty form note)
    departmentId: '',
  })

  const departments = useMemo(() => departmentRepository.findAll(), [])

  const [sections, setSections] = useState<Section[]>([])
  useEffect(() => {
    if (currentAcademicYear) {
      setSections(sectionRepository.findByAcademicYear(currentAcademicYear.id))
    }
  }, [currentAcademicYear])

  const filtered = useMemo(() => {
    return sections.filter(s => {
      if (searchQuery && !s.name.toLowerCase().includes(searchQuery.toLowerCase())) return false
      if (filterDepartment && s.departmentId !== filterDepartment) return false
      return true
    })
  }, [sections, searchQuery, filterDepartment])

  const handleSubmit = () => {
    if (!formData.name.trim()) { alert('Name is required'); return }
    if (!currentAcademicYear) { alert('No active academic year'); return }
    if (!formData.departmentId) { alert('Department is required'); return }

    const semester = Number(formData.semester)
    if (!Number.isInteger(semester) || semester < 1 || semester > 8) {
      alert('Semester must be a whole number between 1 and 8.')
      return
    }

    const data = {
      name: formData.name.trim(),
      semester,
      departmentId: formData.departmentId,
      academicYearId: currentAcademicYear.id,
    }

    try {
      if (editingSection) {
        sectionRepository.update(editingSection.id, data)
      } else {
        sectionRepository.create({ id: crypto.randomUUID(), ...data })
      }

      setShowForm(false)
      setEditingSection(null)
      resetForm()
      setSections(sectionRepository.findByAcademicYear(currentAcademicYear.id))
    } catch (error) {
      const raw = error instanceof Error ? error.message : String(error)
      alert(
        /UNIQUE constraint failed: sections.name/i.test(raw)
          ? 'A section with that name already exists in this academic year.'
          : error instanceof Error && !/constraint|SQLITE|database/i.test(raw)
            ? raw
            : 'Could not save the section. Please try again.'
      )
    }
  }

  const handleEdit = (s: Section) => {
    setEditingSection(s)
    setFormData({ name: s.name, semester: String(s.semester), departmentId: s.departmentId })
    setShowForm(true)
  }

  const handleDelete = (id: string) => {
    if (!confirm('Delete this section? This will also remove its timetable entries.')) return
    try {
      sectionRepository.delete(id)
      if (currentAcademicYear) {
        setSections(sectionRepository.findByAcademicYear(currentAcademicYear.id))
      }
    } catch (error) {
      alert(error instanceof Error ? error.message : 'Could not delete the section.')
    }
  }

  const resetForm = () => {
    setFormData({ name: '', semester: '1', departmentId: '' })
  }

  const getTimetableCount = (sectionId: string) => {
    if (!currentAcademicYear) return 0
    return timetableEntryRepository.findWhere({ academic_year_id: currentAcademicYear.id, section_id: sectionId }).length
  }

  const departmentOptions: SelectOption[] = [{ value: '', label: 'All Departments' }, ...departments.map(d => ({ value: d.id, label: d.name }))]
  const departmentFormOptions: SelectOption[] = departments.map(d => ({ value: d.id, label: d.name }))

  if (!currentAcademicYear) {
    return (
      <div className="max-w-4xl mx-auto text-center py-12">
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
          <h1 className="text-2xl font-bold text-secondary-900">Classes / Sections</h1>
          <p className="text-secondary-500">Manage classes and sections for {currentAcademicYear.name}</p>
        </div>
        <Button onClick={() => { resetForm(); setEditingSection(null); setShowForm(true); }}>
          <Plus className="h-4 w-4" />
          Add Section
        </Button>
      </div>

      <Card>
        <CardBody className="flex flex-wrap items-center gap-4">
          <Input placeholder="Search sections..." value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)} className="w-64" />
          <Select value={filterDepartment} onChange={setFilterDepartment} options={departmentOptions} className="w-48" placeholder="Department" />
        </CardBody>
      </Card>

      <Card>
        <CardBody className="p-0">
          {filtered.length === 0 ? (
            <div className="p-8 text-center text-secondary-500">
              <Users className="h-12 w-12 mx-auto text-secondary-300 mb-4" />
              <p>No sections found</p>
            </div>
          ) : (
            <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3 p-4">
              {filtered.map(s => (
                <Card key={s.id} className="hover:shadow-md transition-shadow">
                  <CardBody>
                    <div className="flex items-start justify-between mb-3">
                      <div>
                        <h3 className="font-semibold text-secondary-900 text-lg">{s.name}</h3>
                        <p className="text-sm text-secondary-500">{departments.find(d => d.id === s.departmentId)?.name ?? s.departmentId}</p>
                      </div>
                      <Badge variant="info">Semester {s.semester}</Badge>
                    </div>
                    <div className="flex items-center gap-4 text-sm text-secondary-500 mb-4">
                      <span className="flex items-center gap-1"><Calendar className="h-4 w-4" /> {getTimetableCount(s.id)} classes</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <Button variant="outline" size="sm" onClick={() => handleEdit(s)} className="flex-1">
                        <Edit className="h-4 w-4" />
                        Edit
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => handleDelete(s.id)} className="text-danger-600 hover:text-danger-700">
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  </CardBody>
                </Card>
              ))}
            </div>
          )}
        </CardBody>
      </Card>

      <Dialog open={showForm} onOpenChange={setShowForm}>
        <DialogHeader title={editingSection ? 'Edit Section' : 'Add Section'} />
        <DialogContent className="space-y-4">
          <Input label="Section Name" value={formData.name} onChange={(e) => setFormData(prev => ({ ...prev, name: e.target.value }))} placeholder="e.g., III BCA-B" required />
          <Input label="Semester" type="number" value={formData.semester} onChange={(e) => setFormData(prev => ({ ...prev, semester: e.target.value }))} min={1} max={8} required />
          <Select label="Department" value={formData.departmentId} onChange={(v) => setFormData(prev => ({ ...prev, departmentId: v }))} options={departmentFormOptions} required />
        </DialogContent>
        <DialogFooter>
          <Button variant="secondary" onClick={() => { setShowForm(false); setEditingSection(null); }}>Cancel</Button>
          <Button onClick={handleSubmit}>{editingSection ? 'Update' : 'Create'}</Button>
        </DialogFooter>
      </Dialog>
    </div>
  )
}