import { useState, useEffect } from 'react'
import { Settings as SettingsIcon, Clock, Calendar, Users, CheckCircle, Save, Plus, Trash2, Edit, Building2, Award, AlertTriangle, ArrowUp, ArrowDown } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Card, CardHeader, CardBody } from '@/components/ui/Card'
import { Input } from '@/components/ui/Input'
import { Select, SelectOption } from '@/components/ui/Select'
import { Checkbox } from '@/components/ui/Checkbox'
import { Dialog, DialogHeader, DialogContent, DialogFooter } from '@/components/ui/Dialog'
import { useAppStore } from '@/stores/appStore'
import { settingsRepository, academicYearRepository, departmentRepository, timeSlotRepository } from '@/db/repositories'
import { SubstitutionWeights, DEFAULT_SUBSTITUTION_WEIGHTS, AcademicYear, Department, TimeSlot, DayOfWeek, DAYS_OF_WEEK } from '@/types'
import { cn } from '@/utils/cn'

type WorkingHours = { startTime: string; endTime: string; breakStart: string; breakEnd: string }

const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/
function minutes(time: string): number {
  const [h, m] = time.split(':').map(Number)
  return h * 60 + m
}
function friendlyMessage(error: unknown, fallback: string): string {
  const raw = error instanceof Error ? error.message : String(error)
  if (error instanceof Error && !/constraint|SQLITE|database/i.test(raw)) return raw
  console.error('[settings]', raw)
  if (/UNIQUE constraint failed: departments.code/i.test(raw)) return 'A department with that code already exists.'
  if (/UNIQUE constraint failed/i.test(raw)) return 'A record with those details already exists.'
  if (/FOREIGN KEY constraint failed/i.test(raw)) return 'This record is still in use and cannot be deleted.'
  return fallback
}

export function Settings() {
  const { currentAcademicYear, loadActiveAcademicYear } = useAppStore()
  const [activeTab, setActiveTab] = useState<'general' | 'hours' | 'academic' | 'rules'>('general')

  const [institutionName, setInstitutionName] = useState('')
  const [institutionAddress, setInstitutionAddress] = useState('')

  const [workingHours, setWorkingHours] = useState<WorkingHours>({ startTime: '09:00', endTime: '16:00', breakStart: '13:00', breakEnd: '14:00' })
  const [maxDailySubsDraft, setMaxDailySubsDraft] = useState('2')
  const [hoursError, setHoursError] = useState<string | null>(null)

  // Periods are read from (and written to) the time_slots table — the single
  // source of truth for the grid, the engine and substitution rules.
  const [slots, setSlots] = useState<TimeSlot[]>([])
  const [slotError, setSlotError] = useState<string | null>(null)
  const [showSlotForm, setShowSlotForm] = useState(false)
  const [editingSlot, setEditingSlot] = useState<TimeSlot | null>(null)
  const [slotForm, setSlotForm] = useState({ name: '', startTime: '', endTime: '', isBreak: false })

  const [workingDays, setWorkingDays] = useState<DayOfWeek[]>(DAYS_OF_WEEK.map(d => d.value))

  // Kept as raw strings while editing so that clearing a field or typing a
  // negative penalty (e.g. -50) is not silently coerced by parseInt(x) || 0.
  const [weightDraft, setWeightDraft] = useState<Record<string, string>>({})
  // P5 toggle: may substitutions go to faculty unrelated to the affected class?
  const [allowUnrelatedDraft, setAllowUnrelatedDraft] = useState(true)
  const [rulesError, setRulesError] = useState<string | null>(null)

  const [academicYears, setAcademicYears] = useState<AcademicYear[]>([])
  const [showYearForm, setShowYearForm] = useState(false)
  const [editingYear, setEditingYear] = useState<AcademicYear | null>(null)
  const [yearForm, setYearForm] = useState({ name: '', startDate: '', endDate: '' })

  const [departments, setDepartments] = useState<Department[]>([])
  const [showDeptForm, setShowDeptForm] = useState(false)
  const [editingDept, setEditingDept] = useState<Department | null>(null)
  const [deptForm, setDeptForm] = useState({ name: '', code: '', description: '' })

  const [saved, setSaved] = useState(false)

  useEffect(() => {
    setInstitutionName(settingsRepository.getInstitutionName())
    setInstitutionAddress(settingsRepository.getInstitutionAddress())
    const wh = settingsRepository.getWorkingHours()
    setWorkingHours({
      startTime: wh.startTime,
      endTime: wh.endTime,
      breakStart: wh.breakStart,
      breakEnd: wh.breakEnd,
    })
    setMaxDailySubsDraft(String(settingsRepository.getMaxDailySubstitutions()))
    timeSlotRepository.initializeDefaults()
    setSlots(timeSlotRepository.getOrdered())
    setWorkingDays(settingsRepository.getWorkingDays())
    const savedWeights = { ...DEFAULT_SUBSTITUTION_WEIGHTS, ...settingsRepository.getSubstitutionWeights() }
    setWeightDraft(
      Object.fromEntries(Object.entries(savedWeights).map(([key, value]) => [key, String(value)]))
    )
    setAllowUnrelatedDraft(settingsRepository.getAllowUnrelatedSubstitutions())
    setAcademicYears(academicYearRepository.findAll())
    setDepartments(departmentRepository.findAll())
  }, [])

  const showSaved = () => {
    setSaved(true)
    setTimeout(() => setSaved(false), 2000)
  }

  const reloadSlots = () => setSlots(timeSlotRepository.getOrdered())

  const validateHours = (): string[] => {
    const errors: string[] = []
    const { startTime, endTime, breakStart, breakEnd } = workingHours
    if (!TIME_PATTERN.test(startTime) || !TIME_PATTERN.test(endTime)) {
      errors.push('Start and end time must be in HH:mm format (e.g. 09:00).')
      return errors
    }
    if (minutes(endTime) <= minutes(startTime)) errors.push('End time must be after start time.')
    if (breakStart || breakEnd) {
      if (!TIME_PATTERN.test(breakStart) || !TIME_PATTERN.test(breakEnd)) {
        errors.push('Break times must be in HH:mm format (e.g. 13:00).')
      } else {
        if (minutes(breakEnd) <= minutes(breakStart)) errors.push('Break end must be after break start.')
        if (minutes(breakStart) < minutes(startTime) || minutes(breakEnd) > minutes(endTime)) {
          errors.push('Break must lie within working hours.')
        }
      }
    }
    const md = Number(maxDailySubsDraft)
    if (!Number.isInteger(md) || md < 1 || md > 10) {
      errors.push('Max daily substitutions must be a whole number between 1 and 10.')
    }
    return errors
  }

  const saveGeneral = () => {
    try {
      settingsRepository.setInstitutionName(institutionName.trim() || 'College')
      settingsRepository.setInstitutionAddress(institutionAddress.trim())
      showSaved()
    } catch (error) {
      alert(friendlyMessage(error, 'Could not save institution details. Please try again.'))
    }
  }

  const saveHours = () => {
    const errors = validateHours()
    if (errors.length > 0) {
      setHoursError(errors.join('\n'))
      return
    }
    try {
      settingsRepository.setWorkingHours(workingHours)
      settingsRepository.setMaxDailySubstitutions(Number(maxDailySubsDraft))
      setHoursError(null)
      showSaved()
    } catch (error) {
      setHoursError(friendlyMessage(error, 'Could not save working hours. Please try again.'))
    }
  }

  /**
   * Rebuild the day's periods from the working-hours form. Explicit action —
   * saving working hours alone never touches existing periods, and periods
   * referenced by timetable entries are protected (the repository refuses).
   */
  const rebuildPeriods = () => {
    const errors = validateHours()
    if (errors.length > 0) {
      setHoursError(errors.join('\n'))
      return
    }
    if (
      !confirm(
        'Rebuild all periods from the working hours above?\n\nPeriods with the same start/end times are kept (timetable entries stay intact). Others are replaced.'
      )
    ) {
      return
    }
    try {
      settingsRepository.setWorkingHours(workingHours)
      settingsRepository.setMaxDailySubstitutions(Number(maxDailySubsDraft))
      timeSlotRepository.rebuildFromWorkingHours(workingHours)
      reloadSlots()
      setHoursError(null)
      showSaved()
    } catch (error) {
      setHoursError(friendlyMessage(error, 'Could not rebuild periods. Please try again.'))
    }
  }

  const saveWorkingDays = () => {
    try {
      settingsRepository.setWorkingDays(workingDays)
      showSaved()
    } catch (error) {
      alert(friendlyMessage(error, 'Could not save working days. Please try again.'))
    }
  }

  const toggleWorkingDay = (day: DayOfWeek) => {
    setWorkingDays(prev => (prev.includes(day) ? prev.filter(d => d !== day) : DAYS_OF_WEEK.filter(d => prev.includes(d.value) || d.value === day).map(d => d.value)))
  }

  const saveWeights = () => {
    const parsed: Record<string, number> = {}
    for (const [key, raw] of Object.entries(weightDraft)) {
      const value = Number(raw)
      if (raw.trim() === '' || !Number.isInteger(value)) {
        setRulesError(`"${key}" must be a whole number (negative values are penalties).`)
        return
      }
      parsed[key] = value
    }
    try {
      settingsRepository.setSubstitutionWeights(parsed)
      settingsRepository.setAllowUnrelatedSubstitutions(allowUnrelatedDraft)
      setRulesError(null)
      showSaved()
    } catch (error) {
      setRulesError(friendlyMessage(error, 'Could not save weights. Please try again.'))
    }
  }

  const resetWeights = () => {
    setWeightDraft(
      Object.fromEntries(Object.entries(DEFAULT_SUBSTITUTION_WEIGHTS).map(([key, value]) => [key, String(value)]))
    )
    setAllowUnrelatedDraft(true)
    setRulesError(null)
  }

  // --- Period (time slot) management ---------------------------------------
  const openNewSlot = () => {
    setEditingSlot(null)
    setSlotForm({ name: '', startTime: '', endTime: '', isBreak: false })
    setSlotError(null)
    setShowSlotForm(true)
  }

  const openEditSlot = (slot: TimeSlot) => {
    setEditingSlot(slot)
    setSlotForm({ name: slot.name, startTime: slot.startTime, endTime: slot.endTime, isBreak: slot.isBreak })
    setSlotError(null)
    setShowSlotForm(true)
  }

  const handleSaveSlot = () => {
    const name = slotForm.name.trim() || `${slotForm.startTime}-${slotForm.endTime}`
    const payload = {
      name,
      startTime: slotForm.startTime,
      endTime: slotForm.endTime,
      isBreak: slotForm.isBreak,
    }
    try {
      if (editingSlot) {
        timeSlotRepository.update(editingSlot.id, payload)
      } else {
        timeSlotRepository.create({ id: crypto.randomUUID(), ...payload })
      }
      setShowSlotForm(false)
      setEditingSlot(null)
      reloadSlots()
    } catch (error) {
      // Dialog stays open; the repository message explains what to fix.
      setSlotError(friendlyMessage(error, 'Could not save the period. Please try again.'))
    }
  }

  const handleDeleteSlot = (id: string) => {
    if (!confirm('Delete this period?')) return
    try {
      timeSlotRepository.delete(id)
      setSlotError(null)
      reloadSlots()
    } catch (error) {
      setSlotError(friendlyMessage(error, 'Could not delete the period. Please try again.'))
    }
  }

  const handleMoveSlot = (id: string, direction: -1 | 1) => {
    try {
      timeSlotRepository.move(id, direction)
      setSlotError(null)
      reloadSlots()
    } catch (error) {
      setSlotError(friendlyMessage(error, 'Could not reorder the period. Please try again.'))
    }
  }

  const handleSaveYear = () => {
    if (!yearForm.name.trim() || !yearForm.startDate || !yearForm.endDate) {
      alert('Please fill all fields')
      return
    }
    if (yearForm.endDate < yearForm.startDate) {
      alert('End date must be after start date')
      return
    }
    try {
      if (editingYear) {
        academicYearRepository.update(editingYear.id, yearForm)
      } else {
        academicYearRepository.create({ id: crypto.randomUUID(), ...yearForm, isActive: false })
      }
      setShowYearForm(false)
      setEditingYear(null)
      setYearForm({ name: '', startDate: '', endDate: '' })
      setAcademicYears(academicYearRepository.findAll())
    } catch (error) {
      alert(friendlyMessage(error, 'Could not save the academic year. Please try again.'))
    }
  }

  const handleSetActiveYear = (id: string) => {
    try {
      academicYearRepository.setActive(id)
      loadActiveAcademicYear()
      setAcademicYears(academicYearRepository.findAll())
    } catch (error) {
      alert(friendlyMessage(error, 'Could not change the active academic year.'))
    }
  }

  const handleDeleteYear = (id: string) => {
    if (!confirm('Delete this academic year? This will remove its timetable and sections.')) return
    try {
      academicYearRepository.delete(id)
      setAcademicYears(academicYearRepository.findAll())
      loadActiveAcademicYear()
    } catch (error) {
      alert(friendlyMessage(error, 'Could not delete the academic year. It may still be referenced by other data.'))
    }
  }

  const handleSaveDept = () => {
    if (!deptForm.name.trim() || !deptForm.code.trim()) {
      alert('Name and code are required')
      return
    }
    try {
      if (editingDept) {
        departmentRepository.update(editingDept.id, deptForm)
      } else {
        departmentRepository.create({ id: crypto.randomUUID(), ...deptForm })
      }
      setShowDeptForm(false)
      setEditingDept(null)
      setDeptForm({ name: '', code: '', description: '' })
      setDepartments(departmentRepository.findAll())
    } catch (error) {
      alert(friendlyMessage(error, 'Could not save the department. Please try again.'))
    }
  }

  const handleDeleteDept = (id: string) => {
    if (!confirm('Delete this department?')) return
    try {
      departmentRepository.delete(id)
      setDepartments(departmentRepository.findAll())
    } catch (error) {
      alert(friendlyMessage(error, 'Could not delete the department. Faculty, subjects or classes still use it.'))
    }
  }

  const tabs = [
    { id: 'general', label: 'General', icon: Building2 },
    { id: 'hours', label: 'Working Hours', icon: Clock },
    { id: 'academic', label: 'Academic Year', icon: Calendar },
    { id: 'rules', label: 'Substitution Rules', icon: Award },
  ]

  const weightFields: { key: keyof SubstitutionWeights; label: string; description: string }[] = [
    { key: 'sameClass', label: 'Same Class/Section (+)', description: 'Teacher normally teaches the affected section' },
    { key: 'sameSemester', label: 'Same Semester/Year (+)', description: 'Teacher teaches the same semester' },
    { key: 'sameDepartment', label: 'Same Department (+)', description: 'Teacher belongs to same department' },
    { key: 'subjectQualified', label: 'Subject Qualified (+)', description: 'Teacher qualified to teach the subject' },
    { key: 'teachesSameSubject', label: 'Teaches Same Subject (+)', description: 'Teacher normally teaches this subject' },
    { key: 'freeDuringSlot', label: 'Free During Slot (+)', description: 'Teacher is free at this time' },
    { key: 'lowSubCount', label: 'Low Substitution Count (+)', description: 'Fewer substitutions today' },
    { key: 'taughtSectionBefore', label: 'Taught Section Before (+)', description: 'Has taught this section previously' },
    { key: 'penaltyHighSubCount', label: 'Near Daily Limit (-)', description: 'Close to max daily substitutions' },
    { key: 'penaltyConsecutive', label: 'Consecutive Burden (-)', description: 'Already teaching consecutive slots' },
    { key: 'penaltyCrossDepartment', label: 'Cross-Department (-)', description: 'From a different department' },
  ]

  return (
    <div className="max-w-5xl mx-auto space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-secondary-900">Settings</h1>
          <p className="text-secondary-500">Configure your college and substitution rules</p>
        </div>
        {saved && (
          <div className="flex items-center gap-2 text-success-700">
            <CheckCircle className="h-5 w-5" />
            <span className="text-sm font-medium">Saved!</span>
          </div>
        )}
      </div>

      <div className="flex gap-1 border-b border-secondary-200 overflow-x-auto">
        {tabs.map(tab => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id as any)}
            className={cn(
              'flex items-center gap-2 px-4 py-3 text-sm font-medium border-b-2 -mb-px whitespace-nowrap transition-colors',
              activeTab === tab.id
                ? 'border-primary-600 text-primary-700'
                : 'border-transparent text-secondary-500 hover:text-secondary-700'
            )}
          >
            <tab.icon className="h-4 w-4" />
            {tab.label}
          </button>
        ))}
      </div>

      {activeTab === 'general' && (
        <Card>
          <CardHeader>
            <h3 className="text-lg font-semibold text-secondary-900">Institution Details</h3>
          </CardHeader>
          <CardBody className="space-y-4">
            <Input label="Institution Name" value={institutionName} onChange={(e) => setInstitutionName(e.target.value)} placeholder="e.g., XYZ College of Arts & Science" />
            <Input label="Institution Address" value={institutionAddress} onChange={(e) => setInstitutionAddress(e.target.value)} placeholder="Full address" />
            <div className="pt-2">
              <Button onClick={saveGeneral}>
                <Save className="h-4 w-4" />
                Save Changes
              </Button>
            </div>
          </CardBody>
        </Card>
      )}

      {activeTab === 'hours' && (
        <div className="space-y-4">
          <Card>
            <CardHeader>
              <h3 className="text-lg font-semibold text-secondary-900">Working Hours</h3>
              <p className="text-sm text-secondary-500">College working day schedule — periods below are the source of truth</p>
            </CardHeader>
            <CardBody className="space-y-4">
              {hoursError && (
                <div className="p-3 bg-danger-50 border border-danger-200 rounded-lg text-sm text-danger-700 whitespace-pre-line">
                  {hoursError}
                </div>
              )}
              <div className="grid gap-4 md:grid-cols-2">
                <Input label="Start Time" type="time" value={workingHours.startTime} onChange={(e) => setWorkingHours(prev => ({ ...prev, startTime: e.target.value }))} />
                <Input label="End Time" type="time" value={workingHours.endTime} onChange={(e) => setWorkingHours(prev => ({ ...prev, endTime: e.target.value }))} />
                <Input label="Break Start" type="time" value={workingHours.breakStart} onChange={(e) => setWorkingHours(prev => ({ ...prev, breakStart: e.target.value }))} />
                <Input label="Break End" type="time" value={workingHours.breakEnd} onChange={(e) => setWorkingHours(prev => ({ ...prev, breakEnd: e.target.value }))} />
              </div>
              <div className="p-4 bg-warning-50 border border-warning-200 rounded-lg">
                <div className="flex items-start gap-3">
                  <AlertTriangle className="h-5 w-5 text-warning-600 mt-0.5" />
                  <div className="text-sm text-warning-800">
                    <p className="font-medium">Break time must be respected</p>
                    <p>No teaching or substitution assignments are allowed between {workingHours.breakStart} and {workingHours.breakEnd}.</p>
                  </div>
                </div>
              </div>
              <div>
                <Input
                  label="Max Daily Substitutions per Faculty"
                  type="number"
                  value={maxDailySubsDraft}
                  onChange={(e) => setMaxDailySubsDraft(e.target.value)}
                  min={1}
                  max={10}
                  helperText="Applies to every faculty member unless overridden on the Faculty page (1–10)."
                />
              </div>
              <div className="pt-2 flex flex-wrap gap-3">
                <Button onClick={saveHours}>
                  <Save className="h-4 w-4" />
                  Save Working Hours
                </Button>
                <Button variant="outline" onClick={rebuildPeriods}>
                  <Clock className="h-4 w-4" />
                  Rebuild Periods From These Hours
                </Button>
              </div>
            </CardBody>
          </Card>

          <Card>
            <CardHeader className="flex items-center justify-between">
              <div>
                <h3 className="text-lg font-semibold text-secondary-900">Periods (Time Slots)</h3>
                <p className="text-sm text-secondary-500">The timetable grid and substitution engine use exactly these periods</p>
              </div>
              <Button size="sm" onClick={openNewSlot}>
                <Plus className="h-4 w-4" />
                Add Period
              </Button>
            </CardHeader>
            <CardBody className="p-0">
              {slotError && (
                <div className="mx-6 mt-4 p-3 bg-danger-50 border border-danger-200 rounded-lg text-sm text-danger-700">
                  {slotError}
                </div>
              )}
              <div className="divide-y divide-secondary-200">
                {slots.length === 0 ? (
                  <div className="p-8 text-center text-secondary-500">No periods configured yet. Add a period to get started.</div>
                ) : slots.map((slot, index) => (
                  <div key={slot.id} className={cn('flex items-center justify-between px-6 py-3', slot.isBreak && 'bg-secondary-50')}>
                    <div className="flex items-center gap-3">
                      <span className="text-sm font-medium text-secondary-700">{slot.name}</span>
                      <span className="text-xs text-secondary-400">{slot.startTime} – {slot.endTime}</span>
                      {slot.isBreak && <span className="badge bg-warning-50 text-warning-700">BREAK</span>}
                    </div>
                    <div className="flex items-center gap-1">
                      <span className="text-xs text-secondary-400 mr-2">Period {slot.order}</span>
                      <Button variant="ghost" size="sm" onClick={() => handleMoveSlot(slot.id, -1)} disabled={index === 0} aria-label="Move up">
                        <ArrowUp className="h-4 w-4" />
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => handleMoveSlot(slot.id, 1)} disabled={index === slots.length - 1} aria-label="Move down">
                        <ArrowDown className="h-4 w-4" />
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => openEditSlot(slot)}>
                        <Edit className="h-4 w-4" />
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => handleDeleteSlot(slot.id)} className="text-danger-600" aria-label="Delete period">
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            </CardBody>
          </Card>

          <Card>
            <CardHeader>
              <h3 className="text-lg font-semibold text-secondary-900">Working Days</h3>
              <p className="text-sm text-secondary-500">Days shown in the timetable grid and offered in the entry form</p>
            </CardHeader>
            <CardBody className="space-y-4">
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                {DAYS_OF_WEEK.map(day => (
                  <Checkbox
                    key={day.value}
                    label={day.label}
                    checked={workingDays.includes(day.value)}
                    onChange={() => toggleWorkingDay(day.value)}
                  />
                ))}
              </div>
              <div className="pt-2">
                <Button onClick={saveWorkingDays}>
                  <Save className="h-4 w-4" />
                  Save Working Days
                </Button>
              </div>
            </CardBody>
          </Card>
        </div>
      )}

      {activeTab === 'academic' && (
        <div className="space-y-4">
          <Card>
            <CardHeader className="flex items-center justify-between">
              <div>
                <h3 className="text-lg font-semibold text-secondary-900">Academic Years</h3>
                <p className="text-sm text-secondary-500">Manage academic years</p>
              </div>
              <Button size="sm" onClick={() => { setShowYearForm(true); setEditingYear(null); setYearForm({ name: '', startDate: '', endDate: '' }) }}>
                <Plus className="h-4 w-4" />
                Add Year
              </Button>
            </CardHeader>
            <CardBody className="p-0">
              <div className="divide-y divide-secondary-200">
                {academicYears.length === 0 ? (
                  <div className="p-8 text-center text-secondary-500">No academic years</div>
                ) : academicYears.map(y => (
                  <div key={y.id} className="flex items-center justify-between px-6 py-4">
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="font-medium text-secondary-900">{y.name}</span>
                        {y.isActive && <span className="badge bg-success-50 text-success-700">ACTIVE</span>}
                      </div>
                      <p className="text-sm text-secondary-500">{y.startDate} to {y.endDate}</p>
                    </div>
                    <div className="flex items-center gap-2">
                      {!y.isActive && (
                        <Button variant="outline" size="sm" onClick={() => handleSetActiveYear(y.id)}>Set Active</Button>
                      )}
                      <Button variant="ghost" size="sm" onClick={() => { setEditingYear(y); setYearForm({ name: y.name, startDate: y.startDate, endDate: y.endDate }); setShowYearForm(true) }}>
                        <Edit className="h-4 w-4" />
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => handleDeleteYear(y.id)} className="text-danger-600">
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            </CardBody>
          </Card>

          <Card>
            <CardHeader className="flex items-center justify-between">
              <div>
                <h3 className="text-lg font-semibold text-secondary-900">Departments</h3>
                <p className="text-sm text-secondary-500">Manage departments</p>
              </div>
              <Button size="sm" onClick={() => { setShowDeptForm(true); setEditingDept(null); setDeptForm({ name: '', code: '', description: '' }) }}>
                <Plus className="h-4 w-4" />
                Add Department
              </Button>
            </CardHeader>
            <CardBody className="p-0">
              <div className="divide-y divide-secondary-200">
                {departments.length === 0 ? (
                  <div className="p-8 text-center text-secondary-500">No departments</div>
                ) : departments.map(d => (
                  <div key={d.id} className="flex items-center justify-between px-6 py-4">
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="font-medium text-secondary-900">{d.name}</span>
                        <span className="badge bg-secondary-100 text-secondary-700">{d.code}</span>
                      </div>
                      {d.description && <p className="text-sm text-secondary-500">{d.description}</p>}
                    </div>
                    <div className="flex items-center gap-2">
                      <Button variant="ghost" size="sm" onClick={() => { setEditingDept(d); setDeptForm({ name: d.name, code: d.code, description: d.description || '' }); setShowDeptForm(true) }}>
                        <Edit className="h-4 w-4" />
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => handleDeleteDept(d.id)} className="text-danger-600">
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            </CardBody>
          </Card>
        </div>
      )}

      {activeTab === 'rules' && (
        <Card>
          <CardHeader>
            <h3 className="text-lg font-semibold text-secondary-900">Substitution Priority Weights</h3>
            <p className="text-sm text-secondary-500">Higher positive values increase priority. Negative values are penalties.</p>
          </CardHeader>
          <CardBody className="space-y-3">
            {rulesError && (
              <div className="p-3 bg-danger-50 border border-danger-200 rounded-lg text-sm text-danger-700">
                {rulesError}
              </div>
            )}
            <div className="rounded-lg border border-secondary-200 bg-secondary-50 p-3">
              <p className="text-sm font-medium text-secondary-700 mb-1">Priority hierarchy (applied after the hard constraints)</p>
              <ul className="text-xs text-secondary-500 space-y-0.5 list-disc list-inside">
                <li>P1 — normally teaches the affected class/section</li>
                <li>P2 — normally teaches the same semester/year</li>
                <li>P3 — same department and normally teaches another section</li>
                <li>P4 — otherwise related (subject, class history, department)</li>
                <li>P5 — unrelated faculty (only when allowed below and no P1–P4 is available)</li>
              </ul>
              <p className="text-xs text-secondary-500 mt-2">
                Within a priority level, the weights below decide the ranking — class familiarity deliberately
                outranks subject qualification across levels.
              </p>
            </div>
            <label className="flex items-start gap-3 rounded-lg border border-secondary-200 p-3 cursor-pointer hover:bg-secondary-50">
              <input
                type="checkbox"
                checked={allowUnrelatedDraft}
                onChange={(e) => setAllowUnrelatedDraft(e.target.checked)}
                className="mt-0.5 h-4 w-4 text-primary-600 border-secondary-300 rounded focus:ring-primary-500"
              />
              <span>
                <span className="text-sm font-medium text-secondary-700">Allow substitutions to unrelated faculty (P5)</span>
                <p className="text-xs text-secondary-500">
                  When off, only faculty related to the affected class (its teachers, semester, department or subject)
                  are considered. If none of them are free, the class shows &quot;NO SUBSTITUTE FOUND&quot;.
                </p>
              </span>
            </label>
            {weightFields.map(field => (
              <div key={field.key} className="flex items-center justify-between gap-4">
                <div className="flex-1">
                  <label className="text-sm font-medium text-secondary-700">{field.label}</label>
                  <p className="text-xs text-secondary-500">{field.description}</p>
                </div>
                <input
                  type="number"
                  value={weightDraft[field.key] ?? ''}
                  onChange={(e) => setWeightDraft(prev => ({ ...prev, [field.key]: e.target.value }))}
                  className="w-24 px-3 py-2 border border-secondary-300 rounded-lg text-sm text-right focus:border-primary-500 focus:ring-1 focus:ring-primary-500"
                />
              </div>
            ))}
            <div className="flex gap-3 pt-4">
              <Button onClick={saveWeights}>
                <Save className="h-4 w-4" />
                Save Substitution Rules
              </Button>
              <Button variant="outline" onClick={resetWeights}>
                Reset to Defaults
              </Button>
            </div>
          </CardBody>
        </Card>
      )}

      <Dialog open={showYearForm} onOpenChange={setShowYearForm}>
        <DialogHeader title={editingYear ? 'Edit Academic Year' : 'Add Academic Year'} />
        <DialogContent className="space-y-4">
          <Input label="Year Name" value={yearForm.name} onChange={(e) => setYearForm(prev => ({ ...prev, name: e.target.value }))} placeholder="e.g., 2024-2025" required />
          <div className="grid grid-cols-2 gap-4">
            <Input label="Start Date" type="date" value={yearForm.startDate} onChange={(e) => setYearForm(prev => ({ ...prev, startDate: e.target.value }))} required />
            <Input label="End Date" type="date" value={yearForm.endDate} onChange={(e) => setYearForm(prev => ({ ...prev, endDate: e.target.value }))} required />
          </div>
        </DialogContent>
        <DialogFooter>
          <Button variant="secondary" onClick={() => { setShowYearForm(false); setEditingYear(null); }}>Cancel</Button>
          <Button onClick={handleSaveYear}>{editingYear ? 'Update' : 'Create'}</Button>
        </DialogFooter>
      </Dialog>

      <Dialog open={showDeptForm} onOpenChange={setShowDeptForm}>
        <DialogHeader title={editingDept ? 'Edit Department' : 'Add Department'} />
        <DialogContent className="space-y-4">
          <Input label="Department Name" value={deptForm.name} onChange={(e) => setDeptForm(prev => ({ ...prev, name: e.target.value }))} placeholder="e.g., Computer Science" required />
          <Input label="Code" value={deptForm.code} onChange={(e) => setDeptForm(prev => ({ ...prev, code: e.target.value }))} placeholder="e.g., CSE" required />
          <Input label="Description" value={deptForm.description} onChange={(e) => setDeptForm(prev => ({ ...prev, description: e.target.value }))} placeholder="Optional description" />
        </DialogContent>
        <DialogFooter>
          <Button variant="secondary" onClick={() => { setShowDeptForm(false); setEditingDept(null); }}>Cancel</Button>
          <Button onClick={handleSaveDept}>{editingDept ? 'Update' : 'Create'}</Button>
        </DialogFooter>
      </Dialog>

      <Dialog open={showSlotForm} onOpenChange={setShowSlotForm}>
        <DialogHeader title={editingSlot ? 'Edit Period' : 'Add Period'} />
        <DialogContent className="space-y-4">
          {slotError && (
            <div className="p-3 bg-danger-50 border border-danger-200 rounded-lg text-sm text-danger-700">
              {slotError}
            </div>
          )}
          <Input
            label="Period Name"
            value={slotForm.name}
            onChange={(e) => setSlotForm(prev => ({ ...prev, name: e.target.value }))}
            placeholder="e.g., 16:00-17:00 (defaults from the times)"
          />
          <div className="grid grid-cols-2 gap-4">
            <Input label="Start Time" type="time" value={slotForm.startTime} onChange={(e) => setSlotForm(prev => ({ ...prev, startTime: e.target.value }))} required />
            <Input label="End Time" type="time" value={slotForm.endTime} onChange={(e) => setSlotForm(prev => ({ ...prev, endTime: e.target.value }))} required />
          </div>
          <Checkbox
            label="This is a break period (no classes or substitutions)"
            checked={slotForm.isBreak}
            onChange={(e) => setSlotForm(prev => ({ ...prev, isBreak: e.target.checked }))}
          />
        </DialogContent>
        <DialogFooter>
          <Button variant="secondary" onClick={() => { setShowSlotForm(false); setEditingSlot(null); }}>Cancel</Button>
          <Button onClick={handleSaveSlot}>{editingSlot ? 'Update' : 'Create'}</Button>
        </DialogFooter>
      </Dialog>
    </div>
  )
}