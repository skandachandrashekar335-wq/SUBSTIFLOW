import { useState, useMemo, useEffect } from 'react'
import { Plus, Edit, Trash2, Building2, Users } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Card, CardBody } from '@/components/ui/Card'
import { Badge } from '@/components/ui/Badge'
import { Input } from '@/components/ui/Input'
import { Select, SelectOption } from '@/components/ui/Select'
import { Dialog, DialogHeader, DialogContent, DialogFooter } from '@/components/ui/Dialog'
import { useAppStore } from '@/stores/appStore'
import { roomRepository, departmentRepository, timetableEntryRepository } from '@/db/repositories'
import { Room } from '@/types'

export function Rooms() {
  const { currentAcademicYear } = useAppStore()
  const [searchQuery, setSearchQuery] = useState('')
  const [showForm, setShowForm] = useState(false)
  const [editingRoom, setEditingRoom] = useState<Room | null>(null)
  const [formData, setFormData] = useState({
    name: '',
    capacity: '40', // raw string while editing (see Faculty form note)
    type: 'CLASSROOM' as Room['type'],
    departmentId: '',
  })

  const departments = useMemo(() => departmentRepository.findAll(), [])

  const [rooms, setRooms] = useState<Room[]>([])
  useEffect(() => {
    setRooms(roomRepository.findAll())
  }, [])

  const filtered = useMemo(() => {
    return rooms.filter(r => !searchQuery || r.name.toLowerCase().includes(searchQuery.toLowerCase()))
  }, [rooms, searchQuery])

  const handleSubmit = () => {
    if (!formData.name.trim()) { alert('Room name is required'); return }
    const capacity = Number(formData.capacity)
    if (!Number.isInteger(capacity) || capacity < 0) {
      alert('Capacity must be a whole number of 0 or more.')
      return
    }
    const data = {
      name: formData.name.trim(),
      capacity,
      type: formData.type,
      departmentId: formData.departmentId || undefined,
    }
    try {
      if (editingRoom) {
        roomRepository.update(editingRoom.id, data)
      } else {
        roomRepository.create({ id: crypto.randomUUID(), ...data })
      }
      setShowForm(false)
      setEditingRoom(null)
      resetForm()
      setRooms(roomRepository.findAll())
    } catch (error) {
      const raw = error instanceof Error ? error.message : String(error)
      alert(
        /UNIQUE constraint failed: rooms.name/i.test(raw)
          ? 'Another room already uses that name.'
          : error instanceof Error && !/constraint|SQLITE|database/i.test(raw)
            ? raw
            : 'Could not save the room. Please try again.'
      )
    }
  }

  const handleEdit = (r: Room) => {
    setEditingRoom(r)
    setFormData({ name: r.name, capacity: String(r.capacity), type: r.type, departmentId: r.departmentId || '' })
    setShowForm(true)
  }

  const handleDelete = (id: string) => {
    const usage = getUsage(id)
    if (usage > 0) {
      alert(`This room is used by ${usage} timetable entr${usage === 1 ? 'y' : 'ies'} and cannot be deleted.`)
      return
    }
    if (!confirm('Delete this room?')) return
    try {
      roomRepository.delete(id)
      setRooms(roomRepository.findAll())
    } catch (error) {
      alert(
        /FOREIGN KEY constraint failed/i.test(String(error))
          ? 'This room is still referenced by timetable entries and cannot be deleted.'
          : error instanceof Error ? error.message : 'Could not delete the room.'
      )
    }
  }

  const resetForm = () => setFormData({ name: '', capacity: '40', type: 'CLASSROOM', departmentId: '' })

  const getUsage = (roomId: string) => {
    if (!currentAcademicYear) return 0
    return timetableEntryRepository.findWhere({ academic_year_id: currentAcademicYear.id, room_id: roomId }).length
  }

  const typeOptions: SelectOption[] = [
    { value: 'CLASSROOM', label: 'Classroom' },
    { value: 'LAB', label: 'Lab' },
    { value: 'AUDITORIUM', label: 'Auditorium' },
    { value: 'OTHER', label: 'Other' },
  ]
  const departmentFormOptions: SelectOption[] = [{ value: '', label: 'General (No department)' }, ...departments.map(d => ({ value: d.id, label: d.name }))]

  return (
    <div className="max-w-7xl mx-auto space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-secondary-900">Rooms</h1>
          <p className="text-secondary-500">Manage classrooms and laboratories</p>
        </div>
        <Button onClick={() => { resetForm(); setEditingRoom(null); setShowForm(true); }}>
          <Plus className="h-4 w-4" />
          Add Room
        </Button>
      </div>

      <Card>
        <CardBody>
          <Input placeholder="Search rooms..." value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)} className="w-64" />
        </CardBody>
      </Card>

      <Card>
        <CardBody className="p-0">
          {filtered.length === 0 ? (
            <div className="p-8 text-center text-secondary-500">
              <Building2 className="h-12 w-12 mx-auto text-secondary-300 mb-4" />
              <p>No rooms found</p>
            </div>
          ) : (
            <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3 p-4">
              {filtered.map(r => (
                <Card key={r.id} className="hover:shadow-md transition-shadow">
                  <CardBody>
                    <div className="flex items-start justify-between mb-3">
                      <div>
                        <h3 className="font-semibold text-secondary-900 text-lg">{r.name}</h3>
                        <Badge variant="neutral">{r.type}</Badge>
                      </div>
                      <div className="flex items-center gap-1 text-sm text-secondary-500">
                        <Users className="h-4 w-4" />
                        {r.capacity}
                      </div>
                    </div>
                    <p className="text-sm text-secondary-500 mb-4">{getUsage(r.id)} scheduled classes</p>
                    <div className="flex items-center gap-2">
                      <Button variant="outline" size="sm" onClick={() => handleEdit(r)} className="flex-1">
                        <Edit className="h-4 w-4" /> Edit
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => handleDelete(r.id)} className="text-danger-600">
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
        <DialogHeader title={editingRoom ? 'Edit Room' : 'Add Room'} />
        <DialogContent className="space-y-4">
          <Input label="Room Name" value={formData.name} onChange={(e) => setFormData(prev => ({ ...prev, name: e.target.value }))} placeholder="e.g., Room 208" required />
          <Input label="Capacity" type="number" value={formData.capacity} onChange={(e) => setFormData(prev => ({ ...prev, capacity: e.target.value }))} />
          <Select label="Type" value={formData.type} onChange={(v) => setFormData(prev => ({ ...prev, type: v as Room['type'] }))} options={typeOptions} />
          <Select label="Department (optional)" value={formData.departmentId} onChange={(v) => setFormData(prev => ({ ...prev, departmentId: v }))} options={departmentFormOptions} />
        </DialogContent>
        <DialogFooter>
          <Button variant="secondary" onClick={() => { setShowForm(false); setEditingRoom(null); }}>Cancel</Button>
          <Button onClick={handleSubmit}>{editingRoom ? 'Update' : 'Create'}</Button>
        </DialogFooter>
      </Dialog>
    </div>
  )
}