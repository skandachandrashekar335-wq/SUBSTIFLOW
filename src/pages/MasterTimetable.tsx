import { useState, useMemo, useEffect } from 'react'
import { Link } from 'react-router-dom'
import { Plus, Trash2, XCircle, AlertTriangle } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Card, CardBody } from '@/components/ui/Card'
import { Badge } from '@/components/ui/Badge'
import { Input } from '@/components/ui/Input'
import { Select, SelectOption } from '@/components/ui/Select'
import { Dialog, DialogHeader, DialogContent, DialogFooter } from '@/components/ui/Dialog'
import { useAppStore } from '@/stores/appStore'
import { timetableEntryRepository, sectionRepository, facultyRepository, subjectRepository, roomRepository, timeSlotRepository, settingsRepository } from '@/db/repositories'
import {
  createTimetableEntry,
  updateTimetableEntry,
  deleteTimetableEntry,
  resolveCellAction,
  buildQuickEntryInput,
  buildAddEntryDefaults,
  findFreeRoomId,
  subjectsForFaculty,
  facultyForSubject,
  reconcileFacultyChange,
  reconcileSubjectChange,
  NO_SUBJECTS_FOR_FACULTY,
  NO_FACULTY_FOR_SUBJECT,
} from '@/services/timetable'
import type { QuickEntryContext } from '@/services/timetable'
import { TimetableEntryWithRelations, DayOfWeek, ClassType, CLASS_TYPES, DAYS_OF_WEEK } from '@/types'
import { cn } from '@/utils/cn'

const emptyQuickForm = {
  facultyId: '',
  subjectId: '',
  roomId: '',
  classType: 'LECTURE' as ClassType,
  sectionId: '',
}

export function MasterTimetable() {
  const { currentAcademicYear } = useAppStore()
  const [selectedSection, setSelectedSection] = useState<string>('')
  const [selectedFaculty, setSelectedFaculty] = useState<string>('')
  const [selectedSubject, setSelectedSubject] = useState<string>('')
  const [searchQuery, setSearchQuery] = useState('')
  // Full form (Add Entry button + editing an existing entry).
  const [showForm, setShowForm] = useState(false)
  const [editingEntry, setEditingEntry] = useState<TimetableEntryWithRelations | null>(null)
  const [formError, setFormError] = useState<string | null>(null)
  const [formData, setFormData] = useState({
    dayOfWeek: (settingsRepository.getWorkingDays()[0] ?? 'MONDAY') as DayOfWeek,
    timeSlotId: '',
    sectionId: '',
    subjectId: '',
    facultyId: '',
    roomId: '',
    classType: 'LECTURE' as ClassType,
  })
  // Context-aware quick form (clicking an empty cell): day, time and — when a
  // class filter is active — the section come from the cell itself.
  const [quickContext, setQuickContext] = useState<QuickEntryContext | null>(null)
  const [quickError, setQuickError] = useState<string | null>(null)
  const [quickData, setQuickData] = useState(emptyQuickForm)

  const sections = useMemo(() => 
    currentAcademicYear ? sectionRepository.findByAcademicYear(currentAcademicYear.id) : [], 
    [currentAcademicYear]
  )
  const faculty = useMemo(() => facultyRepository.findActive(), [])
  const subjects = useMemo(() => subjectRepository.findAll(), [])
  const rooms = useMemo(() => roomRepository.findAll(), [])
  // Configured periods (including break) and configured working days are the
  // source of truth — nothing about the grid is hardcoded.
  const allSlots = useMemo(() => timeSlotRepository.getOrdered(), [])
  const workingDays = useMemo(() => settingsRepository.getWorkingDays(), [])
  const teachingSlots = useMemo(() => allSlots.filter(s => !s.isBreak), [allSlots])

  const [entries, setEntries] = useState<TimetableEntryWithRelations[]>([])
  useEffect(() => {
    if (currentAcademicYear) {
      setEntries(timetableEntryRepository.getWithRelations(currentAcademicYear.id))
    }
  }, [currentAcademicYear])

  const filteredEntries = useMemo(() => {
    return entries.filter(entry => {
      if (selectedSection && entry.sectionId !== selectedSection) return false
      if (selectedFaculty && entry.facultyId !== selectedFaculty) return false
      if (selectedSubject && entry.subjectId !== selectedSubject) return false
      if (searchQuery) {
        const search = searchQuery.toLowerCase()
        const matches = 
          entry.section?.name.toLowerCase().includes(search) ||
          entry.subject?.name.toLowerCase().includes(search) ||
          entry.faculty?.name.toLowerCase().includes(search) ||
          entry.room?.name.toLowerCase().includes(search)
        if (!matches) return false
      }
      return true
    })
  }, [entries, selectedSection, selectedFaculty, selectedSubject, searchQuery])

  // Every entry for the cell — several sections can run in the same period,
  // so the grid must not silently show only one of them.
  const gridData = useMemo(() => {
    const data: Record<string, Record<string, TimetableEntryWithRelations[]>> = {}
    for (const day of workingDays) {
      data[day] = {}
      for (const slot of allSlots) {
        data[day][slot.id] = []
      }
    }
    for (const entry of filteredEntries) {
      if (entry.timeSlot?.isBreak) continue
      if (data[entry.dayOfWeek]) {
        data[entry.dayOfWeek][entry.timeSlotId].push(entry)
      }
    }
    // Deterministic display order (by class name).
    for (const day of workingDays) {
      for (const slot of allSlots) {
        data[day][slot.id].sort((a, b) => (a.section?.name ?? '').localeCompare(b.section?.name ?? ''))
      }
    }
    return data
  }, [filteredEntries, allSlots, workingDays])

  const offDayEntries = useMemo(
    () => entries.filter(e => !workingDays.includes(e.dayOfWeek)).length,
    [entries, workingDays]
  )

  const reloadEntries = () => {
    if (currentAcademicYear) {
      setEntries(timetableEntryRepository.getWithRelations(currentAcademicYear.id))
    }
  }

  // --- Full form (Add Entry / edit) ----------------------------------------

  const handleSubmit = () => {
    if (!currentAcademicYear) return
    setFormError(null)
    try {
      if (editingEntry) {
        updateTimetableEntry(editingEntry.id, formData)
      } else {
        createTimetableEntry(formData, currentAcademicYear.id)
      }
      setShowForm(false)
      setEditingEntry(null)
      setFormData({
        dayOfWeek: workingDays[0] ?? 'MONDAY',
        timeSlotId: '',
        sectionId: '',
        subjectId: '',
        facultyId: '',
        roomId: '',
        classType: 'LECTURE',
      })
      reloadEntries()
    } catch (error) {
      // The dialog stays open so the coordinator can correct the input.
      setFormError(error instanceof Error ? error.message : 'Could not save the timetable entry. Please try again.')
    }
  }

  const handleEdit = (entry: TimetableEntryWithRelations) => {
    setEditingEntry(entry)
    setFormError(null)
    setQuickContext(null)
    setFormData({
      dayOfWeek: entry.dayOfWeek,
      timeSlotId: entry.timeSlotId,
      sectionId: entry.sectionId,
      subjectId: entry.subjectId,
      facultyId: entry.facultyId,
      roomId: entry.roomId,
      classType: entry.classType,
    })
    setShowForm(true)
  }

  const handleDelete = (id: string) => {
    if (!confirm('Delete this timetable entry? Its substitution history will also be removed.')) return
    try {
      deleteTimetableEntry(id)
      setShowForm(false)
      setEditingEntry(null)
      reloadEntries()
    } catch (error) {
      alert(error instanceof Error ? error.message : 'Could not delete the timetable entry.')
    }
  }

  /**
   * Faculty changed → a now-unlinked subject is cleared (it must be picked
   * again from the filtered list; an invalid combination is never savable).
   */
  const handleFullFacultyChange = (value: string) => {
    const result = reconcileFacultyChange(value, formData.subjectId)
    setFormData(prev => ({ ...prev, facultyId: value, subjectId: result.subjectId }))
  }

  /** Subject changed → mirror rule for subject-first selection. */
  const handleFullSubjectChange = (value: string) => {
    const result = reconcileSubjectChange(formData.facultyId, value)
    setFormData(prev => ({ ...prev, subjectId: value, facultyId: result.facultyId }))
  }

  // --- Context-aware quick entry -------------------------------------------

  const openQuickEntry = (day: DayOfWeek, slotId: string) => {
    setEditingEntry(null)
    setFormError(null)
    setQuickError(null)
    setQuickContext({
      dayOfWeek: day,
      timeSlotId: slotId,
      sectionId: selectedSection || null,
    })
    setQuickData({
      ...emptyQuickForm,
      sectionId: selectedSection || '',
      // Sensible default: a room that is free at this time.
      roomId: findFreeRoomId({ day, timeSlotId: slotId, entries, rooms }),
    })
  }

  const handleCellClick = (day: DayOfWeek, slotId: string) => {
    const slot = allSlots.find(s => s.id === slotId)
    if (!slot) return
    const cellEntries = gridData[day]?.[slotId] ?? []
    const action = resolveCellAction({
      day,
      slot,
      existingEntry: cellEntries.length === 1 ? cellEntries[0] : null,
      sectionFilterId: selectedSection,
    })
    if (action.kind === 'break') return // break cells are not assignable
    if (action.kind === 'edit') {
      handleEdit(action.entry)
      return
    }
    openQuickEntry(action.context.dayOfWeek, action.context.timeSlotId)
  }

  const handleQuickFacultyChange = (value: string) => {
    const result = reconcileFacultyChange(value, quickData.subjectId)
    setQuickData(prev => ({ ...prev, facultyId: value, subjectId: result.subjectId }))
  }

  const handleQuickSubjectChange = (value: string) => {
    const result = reconcileSubjectChange(quickData.facultyId, value)
    const subject = subjects.find(s => s.id === value)
    setQuickData(prev => ({
      ...prev,
      subjectId: value,
      facultyId: result.facultyId,
      // Sensible default: the subject's own class type.
      classType: subject?.defaultClassType ?? prev.classType,
    }))
  }

  const handleQuickSubmit = () => {
    if (!currentAcademicYear || !quickContext) return
    setQuickError(null)
    const sectionId = quickContext.sectionId || quickData.sectionId
    try {
      const input = buildQuickEntryInput({
        context: quickContext,
        sectionId,
        facultyId: quickData.facultyId,
        subjectId: quickData.subjectId,
        roomId: quickData.roomId,
        classType: quickData.classType,
      })
      createTimetableEntry(input, currentAcademicYear.id)
      setQuickContext(null)
      reloadEntries()
    } catch (error) {
      setQuickError(error instanceof Error ? error.message : 'Could not save the timetable entry. Please try again.')
    }
  }

  // --- Select options -------------------------------------------------------

  const sectionFilterOptions: SelectOption[] = [{ value: '', label: 'All Sections' }, ...sections.map(s => ({ value: s.id, label: s.name }))]
  const facultyFilterOptions: SelectOption[] = [{ value: '', label: 'All Faculty' }, ...faculty.map(f => ({ value: f.id, label: f.name }))]
  const subjectFilterOptions: SelectOption[] = [{ value: '', label: 'All Subjects' }, ...subjects.map(s => ({ value: s.id, label: s.name }))]
  const timeSlotOptions: SelectOption[] = teachingSlots.map(s => ({ value: s.id, label: s.name }))
  const sectionFormOptions: SelectOption[] = sections.map(s => ({ value: s.id, label: s.name }))
  const roomFormOptions: SelectOption[] = rooms.map(r => ({ value: r.id, label: r.name }))
  const classTypeOptions: SelectOption[] = CLASS_TYPES.map(c => ({ value: c.value, label: c.label }))

  // Faculty↔subject filtering (both directions) with the current selection
  // kept visible so an existing entry can always be opened for editing.
  const baseSubjectOptions = subjectsForFaculty(formData.facultyId, subjects)
  const subjectFormOptions: SelectOption[] = (() => {
    const current = formData.subjectId && !baseSubjectOptions.some(s => s.id === formData.subjectId)
      ? subjects.find(s => s.id === formData.subjectId)
      : undefined
    return [...baseSubjectOptions, ...(current ? [current] : [])].map(s => ({ value: s.id, label: s.name }))
  })()
  const baseFacultyOptions = facultyForSubject(formData.subjectId, faculty)
  const facultyFormOptions: SelectOption[] = (() => {
    const current = formData.facultyId && !baseFacultyOptions.some(f => f.id === formData.facultyId)
      ? faculty.find(f => f.id === formData.facultyId)
      : undefined
    return [...baseFacultyOptions, ...(current ? [current] : [])].map(f => ({ value: f.id, label: f.name }))
  })()
  const fullSubjectMessage =
    formData.facultyId && subjectFormOptions.length === 0 ? NO_SUBJECTS_FOR_FACULTY : undefined
  const fullFacultyMessage =
    formData.subjectId && facultyFormOptions.length === 0 ? NO_FACULTY_FOR_SUBJECT : undefined

  const quickSubjectOptions: SelectOption[] = subjectsForFaculty(quickData.facultyId, subjects)
    .map(s => ({ value: s.id, label: s.name }))
  const quickFacultyOptions: SelectOption[] = facultyForSubject(quickData.subjectId, faculty)
    .map(f => ({ value: f.id, label: f.name }))
  const quickSubjectMessage =
    quickData.facultyId && quickSubjectOptions.length === 0 ? NO_SUBJECTS_FOR_FACULTY : undefined
  const quickFacultyMessage =
    quickData.subjectId && quickFacultyOptions.length === 0 ? NO_FACULTY_FOR_SUBJECT : undefined

  // Read-only context rows for the quick dialog.
  const quickSlot = quickContext ? allSlots.find(s => s.id === quickContext.timeSlotId) : undefined
  const quickDayLabel = quickContext
    ? (DAYS_OF_WEEK.find(d => d.value === quickContext.dayOfWeek)?.label ?? quickContext.dayOfWeek)
    : ''
  const quickSectionName = quickContext
    ? (sections.find(s => s.id === (quickContext.sectionId || quickData.sectionId))?.name ?? '')
    : ''

  // Days offered in the form: the configured working days, plus the entry's own
  // day if it happens to fall outside them (so existing entries stay editable).
  const dayValues: DayOfWeek[] =
    editingEntry && !workingDays.includes(editingEntry.dayOfWeek)
      ? [editingEntry.dayOfWeek, ...workingDays]
      : workingDays
  const dayOptions: SelectOption[] = dayValues
    .map(v => DAYS_OF_WEEK.find(d => d.value === v))
    .filter((d): d is (typeof DAYS_OF_WEEK)[number] => Boolean(d))
    .map(d => ({ value: d.value, label: d.label }))

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
    <div className="max-w-full mx-auto space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-secondary-900">Master Timetable</h1>
          <p className="text-secondary-500">{currentAcademicYear.name}</p>
        </div>
        <Button onClick={() => {
          // QA-012: Time Slot / Section / Room render without a placeholder,
          // so their first option is always visible. Initialize the state to
          // exactly those displayed values — a save can never contradict what
          // the dialog shows (the grid's class filter wins for Section).
          setEditingEntry(null)
          setFormError(null)
          setQuickContext(null)
          setFormData(prev => ({
            ...prev,
            ...buildAddEntryDefaults({
              selectedSectionId: selectedSection,
              teachingSlots,
              sections,
              rooms,
            }),
          }))
          setShowForm(true)
        }}>
          <Plus className="h-4 w-4" />
          Add Entry
        </Button>
      </div>

      <Card>
        <CardBody className="flex flex-wrap items-center gap-4">
          <Input placeholder="Search..." value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)} className="w-64" />
          <Select value={selectedSection} onChange={setSelectedSection} options={sectionFilterOptions} className="w-48" placeholder="Section" />
          <Select value={selectedFaculty} onChange={setSelectedFaculty} options={facultyFilterOptions} className="w-48" placeholder="Faculty" />
          <Select value={selectedSubject} onChange={setSelectedSubject} options={subjectFilterOptions} className="w-48" placeholder="Subject" />
          {selectedSection && (
            <div className="basis-full flex items-center gap-2 text-sm text-primary-700 bg-primary-50 border border-primary-200 rounded-lg px-3 py-1.5">
              <span className="font-semibold">{sections.find(s => s.id === selectedSection)?.name ?? 'Class selected'}</span>
              <span>— clicking an empty cell adds a class for this section; day and time are filled in for you.</span>
            </div>
          )}
          <div className="flex-1" />
          <Button variant="outline" onClick={() => { setSelectedSection(''); setSelectedFaculty(''); setSelectedSubject(''); setSearchQuery(''); }}>
            <XCircle className="h-4 w-4" />
            Clear
          </Button>
        </CardBody>
      </Card>

      {offDayEntries > 0 && (
        <div className="flex items-start gap-3 p-4 bg-warning-50 border border-warning-200 rounded-lg">
          <AlertTriangle className="h-5 w-5 text-warning-600 mt-0.5 shrink-0" />
          <p className="text-sm text-warning-800">
            {offDayEntries} timetable entr{offDayEntries === 1 ? 'y is' : 'ies are'} scheduled on a day that is not
            configured as a working day, and {offDayEntries === 1 ? 'is' : 'are'} not shown below. Re-enable the day in
            Settings → Working Hours to see {offDayEntries === 1 ? 'it' : 'them'}.
          </p>
        </div>
      )}

      <Card>
        <CardBody className="p-0 overflow-auto">
          <div className="grid" style={{ gridTemplateColumns: `80px repeat(${allSlots.length}, 1fr)`, gap: '2px' }}>
            <div className="p-2 border border-secondary-200 bg-secondary-50 font-semibold text-center text-secondary-700 text-xs">Day / Time</div>
            {allSlots.map(slot => (
              <div
                key={slot.id}
                className={cn(
                  'p-2 border font-semibold text-center text-xs',
                  slot.isBreak
                    ? 'bg-warning-50 border-warning-200 text-warning-700'
                    : 'bg-secondary-50 border-secondary-200 text-secondary-700'
                )}
              >
                {slot.name}
                {slot.isBreak && <span className="block text-[10px] font-bold tracking-wide">BREAK</span>}
              </div>
            ))}

            {workingDays.map(dayValue => {
              const day = DAYS_OF_WEEK.find(d => d.value === dayValue)
              return (
                <div key={dayValue} className="contents">
                  <div className="p-2 border border-secondary-200 bg-secondary-50 font-semibold text-center text-secondary-700 text-xs">{day?.label ?? dayValue}</div>
                  {allSlots.map(slot => {
                    if (slot.isBreak) {
                      return (
                        <div
                          key={`${dayValue}-${slot.id}`}
                          className="min-h-[70px] border border-warning-200 bg-warning-50 flex items-center justify-center text-[10px] font-bold text-warning-700"
                        >
                          BREAK
                        </div>
                      )
                    }
                    const cellEntries = gridData[dayValue]?.[slot.id] ?? []
                    return (
                      <div
                        key={`${dayValue}-${slot.id}`}
                        className="relative min-h-[70px] p-1.5 border border-secondary-200 cursor-pointer hover:bg-secondary-50 transition-colors text-xs bg-white"
                        onClick={() => handleCellClick(dayValue as DayOfWeek, slot.id)}
                      >
                        {cellEntries.map(entry => (
                          <div
                            key={entry.id}
                            className={cn(
                              'mb-1 last:mb-0 rounded border px-1 py-0.5 cursor-pointer hover:border-primary-300 transition-colors',
                              entry.classType === 'LAB' ? 'bg-blue-50 border-blue-200' : 'bg-secondary-50 border-secondary-200'
                            )}
                            onClick={(e) => { e.stopPropagation(); handleEdit(entry) }}
                          >
                            <div className="font-medium truncate">{entry.section?.name}</div>
                            <div className="truncate text-secondary-600">{entry.subject?.name}</div>
                            <div className="truncate text-secondary-500">{entry.faculty?.name}</div>
                            <div className="truncate text-secondary-400">{entry.room?.name}</div>
                            <Badge variant="neutral" className="mt-0.5">{entry.classType}</Badge>
                          </div>
                        ))}
                        {cellEntries.length > 0 && (
                          <button
                            type="button"
                            title="Add another class to this period"
                            aria-label="Add another class to this period"
                            className="absolute top-0.5 right-0.5 h-5 w-5 rounded-full bg-white/90 border border-secondary-300 text-secondary-500 hover:text-primary-600 hover:border-primary-400 flex items-center justify-center"
                            onClick={(e) => { e.stopPropagation(); openQuickEntry(dayValue as DayOfWeek, slot.id) }}
                          >
                            <Plus className="h-3 w-3" />
                          </button>
                        )}
                      </div>
                    )
                  })}
                </div>
              )
            })}
          </div>
        </CardBody>
      </Card>

      {/* Full manual form: Add Entry button and editing an existing entry. */}
      <Dialog open={showForm} onOpenChange={setShowForm}>
        <DialogHeader title={editingEntry ? 'Edit Timetable Entry' : 'Add Timetable Entry'} />
        <DialogContent className="space-y-4 max-h-[70vh] overflow-y-auto">
          {formError && (
            <div className="p-3 bg-danger-50 border border-danger-200 rounded-lg text-sm text-danger-700 whitespace-pre-line">
              {formError}
            </div>
          )}
          <div className="grid gap-4 md:grid-cols-2">
            <Select label="Day" value={formData.dayOfWeek} onChange={(v) => setFormData(prev => ({ ...prev, dayOfWeek: v as DayOfWeek }))} options={dayOptions} />
            <Select label="Time Slot" value={formData.timeSlotId} onChange={(v) => setFormData(prev => ({ ...prev, timeSlotId: v }))} options={timeSlotOptions} />
            <Select label="Section" value={formData.sectionId} onChange={(v) => setFormData(prev => ({ ...prev, sectionId: v }))} options={sectionFormOptions} />
            <Select
              label="Faculty"
              value={formData.facultyId}
              onChange={handleFullFacultyChange}
              options={facultyFormOptions}
              placeholder={facultyFormOptions.length > 0 ? 'Select faculty' : undefined}
              helperText={fullFacultyMessage}
            />
            <Select
              label="Subject"
              value={formData.subjectId}
              onChange={handleFullSubjectChange}
              options={subjectFormOptions}
              placeholder={subjectFormOptions.length > 0 ? 'Select subject' : undefined}
              helperText={fullSubjectMessage}
            />
            <Select label="Room" value={formData.roomId} onChange={(v) => setFormData(prev => ({ ...prev, roomId: v }))} options={roomFormOptions} />
            <Select label="Class Type" value={formData.classType} onChange={(v) => setFormData(prev => ({ ...prev, classType: v as ClassType }))} options={classTypeOptions} />
          </div>
        </DialogContent>
        <DialogFooter>
          <div className="flex w-full items-center justify-between gap-3">
            <div>
              {editingEntry && (
                <Button variant="danger" onClick={() => handleDelete(editingEntry.id)}>
                  <Trash2 className="h-4 w-4" />
                  Delete
                </Button>
              )}
            </div>
            <div className="flex gap-3">
              <Button variant="secondary" onClick={() => { setShowForm(false); setEditingEntry(null); }}>Cancel</Button>
              <Button onClick={handleSubmit}>{editingEntry ? 'Update' : 'Create'}</Button>
            </div>
          </div>
        </DialogFooter>
      </Dialog>

      {/* Quick entry: day/time (and class, when the filter knows it) are read-only. */}
      <Dialog
        open={quickContext !== null}
        onOpenChange={(open) => { if (!open) { setQuickContext(null); setQuickError(null) } }}
      >
        <DialogHeader title="Add Timetable Entry" />
        <DialogContent className="space-y-4">
          {quickError && (
            <div className="p-3 bg-danger-50 border border-danger-200 rounded-lg text-sm text-danger-700 whitespace-pre-line">
              {quickError}
            </div>
          )}
          <div className="rounded-lg border border-secondary-200 bg-secondary-50 divide-y divide-secondary-200 text-sm">
            <div className="flex items-center justify-between px-3 py-2">
              <span className="text-secondary-500">Day</span>
              <span className="font-medium text-secondary-900">{quickDayLabel}</span>
            </div>
            <div className="flex items-center justify-between px-3 py-2">
              <span className="text-secondary-500">Time</span>
              <span className="font-medium text-secondary-900">{quickSlot?.name ?? ''}</span>
            </div>
            {quickContext?.sectionId ? (
              <div className="flex items-center justify-between px-3 py-2">
                <span className="text-secondary-500">Class</span>
                <span className="font-medium text-secondary-900">{quickSectionName}</span>
              </div>
            ) : (
              <div className="px-3 py-2">
                <Select
                  label="Class"
                  value={quickData.sectionId}
                  onChange={(v) => setQuickData(prev => ({ ...prev, sectionId: v }))}
                  options={sectionFormOptions}
                  placeholder="Select class"
                />
              </div>
            )}
          </div>
          <Select
            label="Faculty"
            value={quickData.facultyId}
            onChange={handleQuickFacultyChange}
            options={quickFacultyOptions}
            placeholder="Select faculty"
            helperText={quickFacultyMessage}
          />
          <Select
            label="Subject"
            value={quickData.subjectId}
            onChange={handleQuickSubjectChange}
            options={quickSubjectOptions}
            placeholder="Select subject"
            disabled={Boolean(quickSubjectMessage)}
            helperText={quickSubjectMessage}
          />
          <div className="grid gap-4 md:grid-cols-2">
            <Select label="Room" value={quickData.roomId} onChange={(v) => setQuickData(prev => ({ ...prev, roomId: v }))} options={roomFormOptions} />
            <Select label="Class Type" value={quickData.classType} onChange={(v) => setQuickData(prev => ({ ...prev, classType: v as ClassType }))} options={classTypeOptions} />
          </div>
        </DialogContent>
        <DialogFooter>
          <Button variant="secondary" onClick={() => { setQuickContext(null); setQuickError(null) }}>Cancel</Button>
          <Button onClick={handleQuickSubmit}>Add</Button>
        </DialogFooter>
      </Dialog>
    </div>
  )
}
