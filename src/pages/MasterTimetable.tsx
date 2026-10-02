import { useState, useMemo, useEffect } from 'react'
import { Link } from 'react-router-dom'
import { Plus, Trash2, XCircle, AlertTriangle } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Card, CardBody } from '@/components/ui/Card'
import { Badge } from '@/components/ui/Badge'
import { Input } from '@/components/ui/Input'
import { Select, SelectOption } from '@/components/ui/Select'
import { MultiSelect } from '@/components/ui/MultiSelect'
import { Dialog, DialogHeader, DialogContent, DialogFooter } from '@/components/ui/Dialog'
import { useAppStore } from '@/stores/appStore'
import { timetableEntryRepository, sectionRepository, facultyRepository, subjectRepository, roomRepository, timeSlotRepository, settingsRepository, termRepository } from '@/db/repositories'
import { todayISO } from '@/utils/date'
import {
  createTimetableEntry,
  updateTimetableEntry,
  deleteTimetableEntry,
  resolveCellAction,
  buildQuickEntryInput,
  buildAddEntryDefaults,
  findFreeRoomId,
  subjectsForTeam,
  facultyForSubject,
  reconcileTeamChange,
  TimetableConflictError,
  NO_SUBJECTS_FOR_FACULTY,
  NO_FACULTY_FOR_SUBJECT,
} from '@/services/timetable'
import type { QuickEntryContext, TimetableConflict } from '@/services/timetable'
import { TimetableEntryWithRelations, DayOfWeek, ClassType, CLASS_TYPES, DAYS_OF_WEEK, classTypeLabel } from '@/types'
import { cn } from '@/utils/cn'

const emptyQuickForm = {
  facultyIds: [] as string[],
  subjectId: '',
  roomIds: [] as string[],
  classType: 'LECTURE' as ClassType,
  sectionId: '',
  span: 1,
}

/** Shown when a team (2+ faculty) leaves no subject everyone is linked to. */
const NO_SUBJECTS_FOR_TEAM = 'No subjects are linked to every selected faculty member.'

const emptyFormData = (workingDays: string[]) => ({
  dayOfWeek: (workingDays[0] ?? 'MONDAY') as DayOfWeek,
  timeSlotId: '',
  sectionId: '',
  subjectId: '',
  facultyIds: [] as string[],
  roomIds: [] as string[],
  classType: 'LECTURE' as ClassType,
  span: 1,
})

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
  const [formData, setFormData] = useState(emptyFormData(settingsRepository.getWorkingDays()))
  // Context-aware quick form (clicking an empty cell): day, time and — when a
  // class filter is active — the section come from the cell itself.
  const [quickContext, setQuickContext] = useState<QuickEntryContext | null>(null)
  const [quickError, setQuickError] = useState<string | null>(null)
  const [quickData, setQuickData] = useState(emptyQuickForm)
  // Conflict resolution: never overwrite silently — the coordinator chooses.
  const [conflict, setConflict] = useState<{
    conflicts: TimetableConflict[]
    retry: () => void
  } | null>(null)
  const [conflictError, setConflictError] = useState<string | null>(null)

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
      // Team membership: a member of a multi-faculty activity matches too.
      if (selectedFaculty && !entry.facultyIds.includes(selectedFaculty)) return false
      if (selectedSubject && entry.subjectId !== selectedSubject) return false
      if (searchQuery) {
        const search = searchQuery.toLowerCase()
        const matches = 
          entry.section?.name.toLowerCase().includes(search) ||
          entry.subject?.name.toLowerCase().includes(search) ||
          (entry.facultyList ?? []).some(f => f.name.toLowerCase().includes(search)) ||
          (entry.roomList ?? []).some(r => r.name.toLowerCase().includes(search))
        if (!matches) return false
      }
      return true
    })
  }, [entries, selectedSection, selectedFaculty, selectedSubject, searchQuery])

  // Every entry STARTING in the cell — several sections can run in the same
  // period, so the grid must not silently show only one of them.
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

  // Continuation cells: periods AFTER an activity's start that its span still
  // covers (a 09:00–11:00 lab occupies the 10:00 cell as a continuation).
  const continuationData = useMemo(() => {
    const data: Record<string, Record<string, TimetableEntryWithRelations[]>> = {}
    for (const day of workingDays) {
      data[day] = {}
      for (const slot of allSlots) data[day][slot.id] = []
    }
    const orderIdx = new Map(allSlots.map((s, i) => [s.id, i]))
    for (const entry of filteredEntries) {
      if (entry.timeSlot?.isBreak) continue
      const startIdx = orderIdx.get(entry.timeSlotId)
      if (startIdx === undefined) continue
      for (let i = 1; i < Math.max(1, entry.span); i++) {
        const slot = allSlots[startIdx + i]
        if (!slot || slot.isBreak) break
        if (data[entry.dayOfWeek]?.[slot.id]) data[entry.dayOfWeek][slot.id].push(entry)
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

  // --- Save with conflict resolution ---------------------------------------

  /**
   * Save attempts go through here: friendly validation errors show inline in
   * the dialog that submitted; SPAN-AWARE conflicts open the resolution
   * dialog (Keep existing / Replace existing) — nothing is ever overwritten
   * silently.
   */
  const saveWithConflictHandling = (save: () => void, onError: (msg: string) => void) => {
    try {
      save()
    } catch (error) {
      if (error instanceof TimetableConflictError) {
        setConflictError(null)
        setConflict({ conflicts: error.conflicts, retry: save })
      } else {
        onError(
          error instanceof Error ? error.message : 'Could not save the timetable entry. Please try again.'
        )
      }
    }
  }

  /** Coordinator picked "Replace Existing": drop the clashing entries (and
   *  their substitution history), then retry the exact same save. */
  const handleConflictReplace = () => {
    if (!conflict) return
    const { conflicts, retry } = conflict
    try {
      for (const c of conflicts) {
        try {
          deleteTimetableEntry(c.entryId)
        } catch {
          // Already removed (e.g. duplicate conflicts on one entry) — retry
          // will tell us if anything is actually wrong.
        }
      }
      retry()
      setConflict(null)
      reloadEntries()
    } catch (error) {
      setConflictError(
        error instanceof TimetableConflictError
          ? error.conflicts.map(c => c.message).join('\n')
          : error instanceof Error
            ? error.message
            : 'Could not save the timetable entry. Please try again.'
      )
    }
  }

  /** Keep Existing: existing entries stay untouched; this save is abandoned. */
  const handleConflictKeep = () => {
    setConflict(null)
    setShowForm(false)
    setEditingEntry(null)
    setQuickContext(null)
  }

  /** Cancel: back to the form to adjust the input (nothing was saved). */
  const handleConflictCancel = () => {
    setConflictError(null)
    setConflict(null)
  }

  // --- Full form (Add Entry / edit) ----------------------------------------

  const handleSubmit = () => {
    if (!currentAcademicYear) return
    setFormError(null)
    saveWithConflictHandling(() => {
      if (editingEntry) {
        updateTimetableEntry(editingEntry.id, formData)
      } else {
        createTimetableEntry(formData, currentAcademicYear.id)
      }
      setShowForm(false)
      setEditingEntry(null)
      setFormData(emptyFormData(workingDays))
      reloadEntries()
    }, setFormError)
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
      facultyIds: [...entry.facultyIds],
      roomIds: [...entry.roomIds],
      classType: entry.classType,
      span: entry.span,
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
   * Team changed → a now-unshared subject is cleared (it must be picked again
   * from the list filtered to everyone still selected; an invalid combination
   * is never savable).
   */
  const handleFullFacultyChange = (ids: string[]) => {
    const result = reconcileTeamChange(ids, formData.subjectId)
    setFormData(prev => ({ ...prev, facultyIds: ids, subjectId: result.subjectId }))
  }

  /** Subject changed → drop team members not linked to it (mirror rule). */
  const handleFullSubjectChange = (value: string) => {
    const qualified = new Set(facultyForSubject(value, faculty).map(f => f.id))
    setFormData(prev => ({
      ...prev,
      subjectId: value,
      facultyIds: prev.facultyIds.filter(id => qualified.has(id)),
    }))
  }

  /** Start period changed → duration clamped to what actually fits. */
  const handleFullSlotChange = (value: string) => {
    setFormData(prev => {
      const maxSpan = spanOptionCount(value)
      return { ...prev, timeSlotId: value, span: Math.max(1, Math.min(prev.span, maxSpan)) }
    })
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
      roomIds: (() => {
        const free = findFreeRoomId({ day, timeSlotId: slotId, entries, rooms, allSlots })
        return free ? [free] : []
      })(),
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

  const handleQuickFacultyChange = (ids: string[]) => {
    const result = reconcileTeamChange(ids, quickData.subjectId)
    setQuickData(prev => ({ ...prev, facultyIds: ids, subjectId: result.subjectId }))
  }

  const handleQuickSubjectChange = (value: string) => {
    const qualified = new Set(facultyForSubject(value, faculty).map(f => f.id))
    const subject = subjects.find(s => s.id === value)
    setQuickData(prev => ({
      ...prev,
      subjectId: value,
      // Sensible default: the subject's own class type.
      classType: subject?.defaultClassType ?? prev.classType,
      facultyIds: prev.facultyIds.filter(id => qualified.has(id)),
    }))
  }

  const handleQuickSubmit = () => {
    if (!currentAcademicYear || !quickContext) return
    setQuickError(null)
    const sectionId = quickContext.sectionId || quickData.sectionId
    saveWithConflictHandling(() => {
      const input = buildQuickEntryInput({
        context: quickContext,
        sectionId,
        facultyIds: quickData.facultyIds,
        subjectId: quickData.subjectId,
        roomIds: quickData.roomIds,
        classType: quickData.classType,
        span: quickData.span,
      })
      createTimetableEntry(input, currentAcademicYear.id)
      setQuickContext(null)
      reloadEntries()
    }, setQuickError)
  }

  // --- Select options -------------------------------------------------------

  const sectionFilterOptions: SelectOption[] = [{ value: '', label: 'All Sections' }, ...sections.map(s => ({ value: s.id, label: s.name }))]
  const facultyFilterOptions: SelectOption[] = [{ value: '', label: 'All Faculty' }, ...faculty.map(f => ({ value: f.id, label: f.name }))]
  const subjectFilterOptions: SelectOption[] = [{ value: '', label: 'All Subjects' }, ...subjects.map(s => ({ value: s.id, label: s.name }))]
  const timeSlotOptions: SelectOption[] = teachingSlots.map(s => ({ value: s.id, label: s.name }))
  const sectionFormOptions: SelectOption[] = sections.map(s => ({ value: s.id, label: s.name }))
  const roomFormOptions: SelectOption[] = rooms.map(r => ({ value: r.id, label: r.name }))
  const classTypeOptions: SelectOption[] = CLASS_TYPES.map(c => ({ value: c.value, label: c.label }))

  /** Duration choices that FIT from a start period (stops before the break / end of day). */
  const spanOptionsFor = (startSlotId: string): SelectOption[] => {
    const startIdx = allSlots.findIndex(s => s.id === startSlotId)
    if (startIdx < 0) return [{ value: '1', label: '1 period' }]
    const start = allSlots[startIdx]
    const opts: SelectOption[] = []
    for (let n = 1; n <= 4; n++) {
      const end = allSlots[startIdx + n - 1]
      if (!end || end.isBreak) break
      opts.push({
        value: String(n),
        label: `${n} period${n > 1 ? 's' : ''} (${start.startTime}–${end.endTime})`,
      })
    }
    return opts
  }
  const spanOptionCount = (startSlotId: string) => spanOptionsFor(startSlotId).length
  const fullSpanOptions = spanOptionsFor(formData.timeSlotId)
  const quickSpanOptions = spanOptionsFor(quickContext?.timeSlotId ?? '')

  // Faculty↔subject filtering (both directions) with the current selection
  // kept visible so an existing entry can always be opened for editing.
  const baseSubjectOptions = subjectsForTeam(formData.facultyIds, subjects)
  const subjectFormOptions: SelectOption[] = (() => {
    const current = formData.subjectId && !baseSubjectOptions.some(s => s.id === formData.subjectId)
      ? subjects.find(s => s.id === formData.subjectId)
      : undefined
    return [...baseSubjectOptions, ...(current ? [current] : [])].map(s => ({ value: s.id, label: s.name }))
  })()
  const baseFacultyOptions = facultyForSubject(formData.subjectId, faculty)
  const facultyFormOptions: SelectOption[] = (() => {
    const extras = formData.facultyIds
      .map(id => faculty.find(f => f.id === id))
      .filter((f): f is (typeof faculty)[number] => Boolean(f) && !baseFacultyOptions.some(b => b.id === f!.id))
    return [...baseFacultyOptions, ...extras].map(f => ({ value: f.id, label: f.name }))
  })()
  const fullSubjectMessage =
    formData.facultyIds.length > 0 && subjectFormOptions.length === 0
      ? formData.facultyIds.length === 1
        ? NO_SUBJECTS_FOR_FACULTY
        : NO_SUBJECTS_FOR_TEAM
      : undefined
  const fullFacultyMessage =
    formData.subjectId && facultyFormOptions.length === 0 ? NO_FACULTY_FOR_SUBJECT : undefined

  const quickBaseSubjectOptions = subjectsForTeam(quickData.facultyIds, subjects)
  const quickSubjectOptions: SelectOption[] = quickBaseSubjectOptions.map(s => ({ value: s.id, label: s.name }))
  const quickBaseFacultyOptions = facultyForSubject(quickData.subjectId, faculty)
  const quickFacultyOptions: SelectOption[] = (() => {
    const extras = quickData.facultyIds
      .map(id => faculty.find(f => f.id === id))
      .filter((f): f is (typeof faculty)[number] => Boolean(f) && !quickBaseFacultyOptions.some(b => b.id === f!.id))
    return [...quickBaseFacultyOptions, ...extras].map(f => ({ value: f.id, label: f.name }))
  })()
  const quickSubjectMessage =
    quickData.facultyIds.length > 0 && quickSubjectOptions.length === 0
      ? quickData.facultyIds.length === 1
        ? NO_SUBJECTS_FOR_FACULTY
        : NO_SUBJECTS_FOR_TEAM
      : undefined
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

  // With a single class selected every cell holds at most that class's entry:
  // activities render as TRUE column spans (the lab's second hour is skipped,
  // not duplicated) and rows stay aligned with the header. Unfiltered, several
  // classes share a cell, so spans become continuation chips instead (no
  // column shifting).
  const spanMode = Boolean(selectedSection)

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
          {(() => {
            // Effective-date context: which timetable is active today?
            const term = termRepository.getActive()
            if (!term) return null
            const today = todayISO()
            const inTerm = today >= term.startDate && today <= term.endDate
            return (
              <p className={`text-sm mt-1 ${inTerm ? 'text-primary-700' : 'text-warning-700'}`}>
                {inTerm ? 'Effective' : 'Outside term'}: {term.name}
                <span className="text-secondary-400"> · </span>
                <span className="text-secondary-500">{term.startDate} to {term.endDate}</span>
              </p>
            )
          })()}
        </div>
        <Button onClick={() => {
          // QA-011 + QA-012: every Add Entry open starts a genuinely fresh
          // draft. Team/Subject/Day/Class Type/Duration are reset (a cancelled
          // or edited draft must never leak into the next one) and Time
          // Slot/Section/Room are initialized to exactly what their selects
          // display (first option, or the grid's class filter for Section) —
          // displayed values, form state and submitted values always agree.
          setEditingEntry(null)
          setFormError(null)
          setQuickContext(null)
          setFormData({
            dayOfWeek: (workingDays[0] ?? 'MONDAY') as DayOfWeek,
            ...(() => {
              const d = buildAddEntryDefaults({
                selectedSectionId: selectedSection,
                teachingSlots,
                sections,
                rooms,
              })
              return { timeSlotId: d.timeSlotId, sectionId: d.sectionId, roomIds: d.roomId ? [d.roomId] : [] }
            })(),
            facultyIds: [],
            subjectId: '',
            classType: 'LECTURE',
            span: 1,
          })
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
              <span>— clicking an empty cell adds a class for this section; day and time are filled in for you. Multi-period activities span their full duration.</span>
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
          {/* ONE grid renders header and body, so both share identical track
              definitions and every column boundary lines up from the header
              through every day row. `minmax(140px, 1fr)` keeps all period
              columns equal and content-independent: the fixed minimum cannot
              be widened by long (nowrap, truncated) text, and it preserves a
              useful minimum column width — narrower viewports scroll
              horizontally instead of squashing the columns. No column gap:
              neighbouring cells' borders touch so the grid reads as one
              table rather than a field of floating cards. */}
          <div
            className="grid"
            style={{ gridTemplateColumns: `96px repeat(${allSlots.length}, minmax(140px, 1fr))` }}
          >
            <div className="min-w-0 p-2 border border-secondary-200 bg-secondary-50 font-semibold text-center text-secondary-700 text-xs">Day / Time</div>
            {allSlots.map(slot => (
              <div
                key={slot.id}
                className={cn(
                  'min-w-0 p-2 border font-semibold text-center text-xs',
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
                  <div className="min-w-0 p-2 border border-secondary-200 bg-secondary-50 font-semibold text-center text-secondary-700 text-xs">{day?.label ?? dayValue}</div>
                  {allSlots.map((slot, slotIdx) => {
                    if (slot.isBreak) {
                      return (
                        <div
                          key={`${dayValue}-${slot.id}`}
                          className="min-h-[70px] min-w-0 border border-warning-200 bg-warning-50 flex items-center justify-center text-[10px] font-bold text-warning-700"
                        >
                          BREAK
                        </div>
                      )
                    }
                    const cellEntries = gridData[dayValue]?.[slot.id] ?? []
                    const contEntries = continuationData[dayValue]?.[slot.id] ?? []

                    // Class-filtered: the cell INSIDE a multi-period activity
                    // is skipped entirely — its start cell spans those tracks,
                    // keeping the row exactly (1 + periods) tracks wide.
                    if (spanMode && contEntries.length > 0 && cellEntries.length === 0) {
                      return null
                    }

                    // Rendered span must equal 1 + the continuation cells we
                    // skip: both stop at the break / end of day, so rows stay
                    // exactly (1 + periods) tracks wide even on bad data.
                    let maxSpan = 1
                    if (spanMode && cellEntries.length > 0) {
                      let fit = 1
                      for (
                        let i = slotIdx + 1;
                        i < allSlots.length && !allSlots[i].isBreak;
                        i++
                      ) {
                        fit++
                      }
                      maxSpan = Math.min(
                        Math.max(1, ...cellEntries.map(e => Math.max(1, e.span))),
                        fit
                      )
                    }

                    return (
                      <div
                        key={`${dayValue}-${slot.id}`}
                        style={maxSpan > 1 ? { gridColumn: `span ${maxSpan}` } : undefined}
                        className="min-h-[70px] min-w-0 p-1.5 border border-secondary-200 cursor-pointer hover:bg-secondary-50 transition-colors text-xs bg-white flex flex-col"
                        onClick={() => handleCellClick(dayValue as DayOfWeek, slot.id)}
                      >
                        {/* Entries stack in a centred inner track: the row height
                            comes from the tallest cell of the row, so a lone
                            entry balances instead of leaving a lopsided gap.
                            min-w-0 + truncate keeps long names inside the cell. */}
                        <div className="flex-1 flex flex-col justify-center gap-1">
                          {cellEntries.map(entry => {
                            const teamNames = (entry.facultyList ?? []).map(f => f.name).join(', ')
                            const roomNames = (entry.roomList ?? []).map(r => r.name).join(', ')
                            return (
                              <div
                                key={entry.id}
                                className={cn(
                                  'rounded border px-1.5 py-1 cursor-pointer hover:border-primary-300 transition-colors min-w-0',
                                  entry.classType === 'LAB' ? 'bg-blue-50 border-blue-200' : 'bg-secondary-50 border-secondary-200'
                                )}
                                onClick={(e) => { e.stopPropagation(); handleEdit(entry) }}
                              >
                                <div className="font-medium truncate" title={entry.section?.name}>{entry.section?.name}</div>
                                <div className="truncate text-secondary-600" title={entry.subject?.name}>{entry.subject?.name}</div>
                                <div
                                  className={cn('truncate', teamNames ? 'text-secondary-500' : 'text-secondary-400 italic')}
                                  title={teamNames || 'No faculty'}
                                >
                                  {teamNames || 'No faculty'}
                                </div>
                                {roomNames && (
                                  <div className="truncate text-secondary-400" title={roomNames}>{roomNames}</div>
                                )}
                                <div className="flex flex-wrap gap-1 mt-0.5">
                                  <Badge variant="neutral">{classTypeLabel(entry.classType)}</Badge>
                                  {entry.span > 1 && (
                                    <Badge variant="info">{entry.span} periods</Badge>
                                  )}
                                  {(entry.facultyList?.length ?? 0) > 1 && (
                                    <Badge variant="info">{entry.facultyList!.length} faculty</Badge>
                                  )}
                                </div>
                              </div>
                            )
                          })}
                          {/* Unfiltered: a multi-period activity's later hours
                              show as continuation chips (nothing shifts). */}
                          {!spanMode && contEntries.map(entry => (
                            <div
                              key={`cont-${entry.id}`}
                              className="rounded border border-dashed border-secondary-300 bg-secondary-50/60 px-1.5 py-1 cursor-pointer hover:border-primary-300 transition-colors min-w-0"
                              title={`${entry.section?.name} — ${entry.subject?.name} (continues)`}
                              onClick={(e) => { e.stopPropagation(); handleEdit(entry) }}
                            >
                              <div className="truncate text-[11px] text-secondary-500">
                                ↳ {entry.section?.name} · {entry.subject?.name}{' '}
                                <span className="text-secondary-400">continues</span>
                              </div>
                            </div>
                          ))}
                        </div>
                        {/* One consistent placement for every cell (empty or not):
                            bottom-right, in normal flow, so it can never sit on
                            top of a card. */}
                        <button
                          type="button"
                          title={cellEntries.length > 0 ? 'Add another class to this period' : 'Add class to this period'}
                          aria-label={cellEntries.length > 0 ? 'Add another class to this period' : 'Add class to this period'}
                          className="mt-auto self-end h-5 w-5 shrink-0 rounded-full bg-white/90 border border-secondary-300 text-secondary-500 hover:text-primary-600 hover:border-primary-400 flex items-center justify-center"
                          onClick={(e) => { e.stopPropagation(); openQuickEntry(dayValue as DayOfWeek, slot.id) }}
                        >
                          <Plus className="h-3 w-3" />
                        </button>
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
            <Select label="Time Slot" value={formData.timeSlotId} onChange={handleFullSlotChange} options={timeSlotOptions} />
            <Select label="Duration" value={String(formData.span)} onChange={(v) => setFormData(prev => ({ ...prev, span: parseInt(v, 10) || 1 }))} options={fullSpanOptions} helperText="Consecutive periods (labs occupy their full length)." />
            <Select label="Section" value={formData.sectionId} onChange={(v) => setFormData(prev => ({ ...prev, sectionId: v }))} options={sectionFormOptions} />
            <Select
              label="Subject"
              value={formData.subjectId}
              onChange={handleFullSubjectChange}
              options={subjectFormOptions}
              placeholder={subjectFormOptions.length > 0 ? 'Select subject' : undefined}
              helperText={fullSubjectMessage}
            />
            <Select label="Class Type" value={formData.classType} onChange={(v) => setFormData(prev => ({ ...prev, classType: v as ClassType }))} options={classTypeOptions} />
            <MultiSelect
              label="Teaching Team"
              value={formData.facultyIds}
              onChange={handleFullFacultyChange}
              options={facultyFormOptions}
              helperText={fullFacultyMessage ?? (formData.facultyIds.length === 0 ? 'Faculty optional for library / mentoring / tutorial / skill-build / COE activities.' : undefined)}
              emptyText={fullFacultyMessage ?? 'No faculty available'}
            />
            <MultiSelect
              label="Rooms"
              value={formData.roomIds}
              onChange={(ids) => setFormData(prev => ({ ...prev, roomIds: ids }))}
              options={roomFormOptions}
              helperText={formData.roomIds.length === 0 ? 'Not specified — rooms are optional.' : undefined}
              emptyText="No rooms configured"
            />
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
            label="Duration"
            value={String(quickData.span)}
            onChange={(v) => setQuickData(prev => ({ ...prev, span: parseInt(v, 10) || 1 }))}
            options={quickSpanOptions}
            helperText="Consecutive periods (labs occupy their full length)."
          />
          <MultiSelect
            label="Teaching Team"
            value={quickData.facultyIds}
            onChange={handleQuickFacultyChange}
            options={quickFacultyOptions}
            helperText={quickFacultyMessage ?? (quickData.facultyIds.length === 0 ? 'Faculty optional for library / mentoring / tutorial / skill-build / COE activities.' : undefined)}
            emptyText={quickFacultyMessage ?? 'No faculty available'}
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
            <MultiSelect
              label="Rooms"
              value={quickData.roomIds}
              onChange={(ids) => setQuickData(prev => ({ ...prev, roomIds: ids }))}
              options={roomFormOptions}
              helperText={quickData.roomIds.length === 0 ? 'Not specified — rooms are optional.' : undefined}
              emptyText="No rooms configured"
            />
            <Select label="Class Type" value={quickData.classType} onChange={(v) => setQuickData(prev => ({ ...prev, classType: v as ClassType }))} options={classTypeOptions} />
          </div>
        </DialogContent>
        <DialogFooter>
          <Button variant="secondary" onClick={() => { setQuickContext(null); setQuickError(null) }}>Cancel</Button>
          <Button onClick={handleQuickSubmit}>Add</Button>
        </DialogFooter>
      </Dialog>

      {/* Conflict resolution: the coordinator decides — never a silent overwrite. */}
      <Dialog open={conflict !== null} onOpenChange={(open) => { if (!open) handleConflictCancel() }}>
        <DialogHeader title="Schedule Conflict" />
        <DialogContent className="space-y-4">
          <p className="text-sm text-secondary-700">
            This entry clashes with {conflict?.conflicts.length === 1 ? 'an existing entry' : 'existing entries'}:
          </p>
          <ul className="space-y-2">
            {(conflict?.conflicts ?? []).map((c, i) => (
              <li
                key={`${c.entryId}-${i}`}
                className="flex items-start gap-2 p-3 bg-warning-50 border border-warning-200 rounded-lg text-sm text-warning-800"
              >
                <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0 text-warning-600" />
                <span>{c.message}</span>
              </li>
            ))}
          </ul>
          {conflictError && (
            <div className="p-3 bg-danger-50 border border-danger-200 rounded-lg text-sm text-danger-700 whitespace-pre-line">
              {conflictError}
            </div>
          )}
          <div className="text-sm text-secondary-600 space-y-1">
            <p><strong>Keep Existing</strong> — the entries above stay; this save is cancelled.</p>
            <p><strong>Replace Existing</strong> — the conflicting entries (and their substitution history) are deleted, then this entry is saved.</p>
            <p><strong>Cancel</strong> — back to the form to adjust the time, class or team.</p>
          </div>
        </DialogContent>
        <DialogFooter>
          <div className="flex w-full justify-end gap-3">
            <Button variant="secondary" onClick={handleConflictCancel}>Cancel</Button>
            <Button variant="secondary" onClick={handleConflictKeep}>Keep Existing</Button>
            <Button variant="danger" onClick={handleConflictReplace}>Replace Existing</Button>
          </div>
        </DialogFooter>
      </Dialog>
    </div>
  )
}
