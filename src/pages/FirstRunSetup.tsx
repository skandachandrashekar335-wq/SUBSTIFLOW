import { useState, useEffect } from 'react'
import { 
  CheckCircle, ArrowRight, ArrowLeft, Building2, Calendar, Clock, 
  Users, BookOpen, CheckSquare, Settings, Sparkles 
} from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Card, CardHeader, CardBody } from '@/components/ui/Card'
import { Input } from '@/components/ui/Input'
import { Select, SelectOption } from '@/components/ui/Select'
import { useAppStore } from '@/stores/appStore'
import { 
  settingsRepository, 
  academicYearRepository, 
  departmentRepository, 
  facultyRepository, 
  subjectRepository, 
  sectionRepository,
  roomRepository,
  timeSlotRepository
} from '@/db/repositories'
import { DEFAULT_WORKING_HOURS } from '@/types'
import { cn } from '@/utils/cn'

const STEPS = [
  { id: 1, title: 'Welcome', description: 'Get started with SubstiFlow', icon: Sparkles },
  { id: 2, title: 'Institution', description: 'Create your institution', icon: Building2 },
  { id: 3, title: 'Academic Year', description: 'Set up academic year', icon: Calendar },
  { id: 4, title: 'Working Hours', description: 'Configure schedule', icon: Clock },
  { id: 5, title: 'Department', description: 'Create a department', icon: Building2 },
  { id: 6, title: 'Faculty', description: 'Add first faculty', icon: Users },
  { id: 7, title: 'Subjects', description: 'Add subjects', icon: BookOpen },
  { id: 8, title: 'Sections', description: 'Create sections', icon: Users },
  { id: 9, title: 'Rooms', description: 'Add rooms', icon: Building2 },
  { id: 10, title: 'Finish', description: 'Complete setup', icon: CheckSquare },
]

export function FirstRunSetup() {
  const [currentStep, setCurrentStep] = useState(1)
  const { completeSetup, loadActiveAcademicYear } = useAppStore()

  // Form states
  const [institutionName, setInstitutionName] = useState('')
  const [institutionAddress, setInstitutionAddress] = useState('')
  const [yearName, setYearName] = useState('2024-2025')
  const [yearStart, setYearStart] = useState('2024-06-01')
  const [yearEnd, setYearEnd] = useState('2025-05-31')
  const [workingHours, setWorkingHours] = useState(DEFAULT_WORKING_HOURS)
  const [deptName, setDeptName] = useState('')
  const [deptCode, setDeptCode] = useState('')
  const [facultyName, setFacultyName] = useState('')
  const [subjectName, setSubjectName] = useState('')
  const [subjectCode, setSubjectCode] = useState('')
  const [sectionName, setSectionName] = useState('')
  const [roomName, setRoomName] = useState('')
  const [semester, setSemester] = useState('1') // raw string while editing

  const [createdDeptId, setCreatedDeptId] = useState('')
  const [createdYearId, setCreatedYearId] = useState('')
  const [createdFacultyId, setCreatedFacultyId] = useState('')
  const [createdSubjectId, setCreatedSubjectId] = useState('')
  const [createdSectionId, setCreatedSectionId] = useState('')
  const [createdRoomId, setCreatedRoomId] = useState('')

  const [saving, setSaving] = useState(false)

  const canProceed = () => {
    switch (currentStep) {
      case 1: return true
      case 2: return institutionName.trim().length > 0
      case 3: return yearName.trim().length > 0 && yearStart && yearEnd
      case 4: return true
      case 5: return deptName.trim().length > 0 && deptCode.trim().length > 0
      case 6: return facultyName.trim().length > 0
      case 7: return subjectName.trim().length > 0 && subjectCode.trim().length > 0
      case 8: {
        const sem = Number(semester)
        return sectionName.trim().length > 0 && Number.isInteger(sem) && sem >= 1 && sem <= 8
      }
      case 9: return roomName.trim().length > 0
      case 10: return true
      default: return true
    }
  }

  const handleNext = async () => {
    if (!canProceed()) return
    setSaving(true)

    try {
      switch (currentStep) {
        case 2:
          settingsRepository.setInstitutionName(institutionName.trim())
          settingsRepository.setInstitutionAddress(institutionAddress.trim())
          break
        case 3: {
          // Idempotent: going Back and pressing Next again updates the year
          // created earlier instead of creating (and activating) a duplicate.
          const payload = { name: yearName.trim(), startDate: yearStart, endDate: yearEnd }
          const existing = createdYearId ? academicYearRepository.findById(createdYearId) : null
          const year = existing
            ? academicYearRepository.update(existing.id, payload)!
            : academicYearRepository.create({ id: crypto.randomUUID(), ...payload, isActive: false })
          academicYearRepository.setActive(year.id)
          setCreatedYearId(year.id)
          break
        }
        case 4:
          settingsRepository.setWorkingHours(workingHours)
          timeSlotRepository.initializeDefaults()
          // Make the configured hours real: regenerate the periods so they
          // match (repeat presses are a no-op when nothing changed).
          timeSlotRepository.rebuildFromWorkingHours(workingHours)
          break
        case 5: {
          const payload = { name: deptName.trim(), code: deptCode.trim().toUpperCase() }
          const existing = createdDeptId ? departmentRepository.findById(createdDeptId) : null
          const dept = existing
            ? departmentRepository.update(existing.id, payload)!
            : departmentRepository.create({ id: crypto.randomUUID(), ...payload })
          setCreatedDeptId(dept.id)
          break
        }
        case 6: {
          if (!createdDeptId) break
          const payload = { name: facultyName.trim(), departmentId: createdDeptId, isActive: true }
          const existing = createdFacultyId ? facultyRepository.findById(createdFacultyId) : null
          const fac = existing
            ? facultyRepository.update(existing.id, payload)!
            : facultyRepository.create({
                id: crypto.randomUUID(),
                ...payload,
                maxDailySubstitutions: 2,
                priority: 0,
              })
          setCreatedFacultyId(fac.id)
          break
        }
        case 7: {
          if (!createdDeptId) break
          const payload = {
            name: subjectName.trim(),
            code: subjectCode.trim().toUpperCase(),
            departmentId: createdDeptId,
            defaultClassType: 'LECTURE' as const,
          }
          const existing = createdSubjectId ? subjectRepository.findById(createdSubjectId) : null
          const subj = existing
            ? subjectRepository.update(existing.id, payload)!
            : subjectRepository.create({ id: crypto.randomUUID(), ...payload })
          setCreatedSubjectId(subj.id)
          if (createdFacultyId) {
            facultyRepository.setSubjects(createdFacultyId, [
              { facultyId: createdFacultyId, subjectId: subj.id, proficiency: 3 }
            ])
          }
          break
        }
        case 8: {
          if (!createdDeptId || !createdYearId) break
          const payload = {
            name: sectionName.trim(),
            semester: Number(semester),
            departmentId: createdDeptId,
            academicYearId: createdYearId,
          }
          const existing = createdSectionId ? sectionRepository.findById(createdSectionId) : null
          const sec = existing
            ? sectionRepository.update(existing.id, payload)!
            : sectionRepository.create({ id: crypto.randomUUID(), ...payload })
          setCreatedSectionId(sec.id)
          if (createdFacultyId) {
            facultyRepository.setSections(createdFacultyId, [sec.id])
          }
          break
        }
        case 9: {
          const payload = { name: roomName.trim(), capacity: 40, type: 'CLASSROOM' as const }
          if (createdRoomId && roomRepository.findById(createdRoomId)) {
            roomRepository.update(createdRoomId, payload)
          } else {
            const room = roomRepository.create({ id: crypto.randomUUID(), ...payload })
            setCreatedRoomId(room.id)
          }
          break
        }
        case 10:
          settingsRepository.setSetupComplete(true)
          loadActiveAcademicYear()
          completeSetup()
          return
      }

      setCurrentStep(prev => Math.min(prev + 1, 10))
    } catch (error) {
      alert('Error: ' + (error as Error).message)
    } finally {
      setSaving(false)
    }
  }

  const handleBack = () => {
    setCurrentStep(prev => Math.max(prev - 1, 1))
  }

  const renderStep = () => {
    switch (currentStep) {
      case 1:
        return (
          <div className="text-center py-8">
            <div className="flex justify-center mb-6">
              <div className="flex h-20 w-20 items-center justify-center rounded-2xl bg-primary-600">
                <Sparkles className="h-10 w-10 text-white" />
              </div>
            </div>
            <h2 className="text-3xl font-bold text-secondary-900 mb-3">Welcome to SubstiFlow</h2>
            <p className="text-lg text-secondary-600 mb-6">
              Faculty Timetable & Automatic Substitution Manager
            </p>
            <p className="text-secondary-500 max-w-xl mx-auto">
              Configure your college in a few simple steps. Once set up, you'll only need to:
            </p>
            <ul className="mt-4 text-left max-w-md mx-auto space-y-2 text-secondary-600">
              <li className="flex items-center gap-2"><CheckCircle className="h-4 w-4 text-success-500" /> Mark daily attendance</li>
              <li className="flex items-center gap-2"><CheckCircle className="h-4 w-4 text-success-500" /> Generate substitutions</li>
              <li className="flex items-center gap-2"><CheckCircle className="h-4 w-4 text-success-500" /> Print revised timetable</li>
            </ul>
          </div>
        )

      case 2:
        return (
          <div className="space-y-4">
            <h2 className="text-xl font-semibold text-secondary-900">Your Institution</h2>
            <Input label="Institution Name" value={institutionName} onChange={(e) => setInstitutionName(e.target.value)} placeholder="e.g., ABC College of Arts & Science" autoFocus />
            <Input label="Address" value={institutionAddress} onChange={(e) => setInstitutionAddress(e.target.value)} placeholder="Full address" />
          </div>
        )

      case 3:
        return (
          <div className="space-y-4">
            <h2 className="text-xl font-semibold text-secondary-900">Academic Year</h2>
            <Input label="Year Name" value={yearName} onChange={(e) => setYearName(e.target.value)} placeholder="e.g., 2024-2025" autoFocus />
            <div className="grid grid-cols-2 gap-4">
              <Input label="Start Date" type="date" value={yearStart} onChange={(e) => setYearStart(e.target.value)} />
              <Input label="End Date" type="date" value={yearEnd} onChange={(e) => setYearEnd(e.target.value)} />
            </div>
          </div>
        )

      case 4:
        return (
          <div className="space-y-4">
            <h2 className="text-xl font-semibold text-secondary-900">Working Hours</h2>
            <div className="grid grid-cols-2 gap-4">
              <Input label="Start Time" type="time" value={workingHours.startTime} onChange={(e) => setWorkingHours(prev => ({ ...prev, startTime: e.target.value }))} />
              <Input label="End Time" type="time" value={workingHours.endTime} onChange={(e) => setWorkingHours(prev => ({ ...prev, endTime: e.target.value }))} />
              <Input label="Break Start" type="time" value={workingHours.breakStart} onChange={(e) => setWorkingHours(prev => ({ ...prev, breakStart: e.target.value }))} />
              <Input label="Break End" type="time" value={workingHours.breakEnd} onChange={(e) => setWorkingHours(prev => ({ ...prev, breakEnd: e.target.value }))} />
            </div>
            <div className="p-4 bg-primary-50 border border-primary-200 rounded-lg text-sm text-primary-800">
              Default: 09:00 – 16:00 with lunch break 13:00 – 14:00
            </div>
          </div>
        )

      case 5:
        return (
          <div className="space-y-4">
            <h2 className="text-xl font-semibold text-secondary-900">Department</h2>
            <Input label="Department Name" value={deptName} onChange={(e) => setDeptName(e.target.value)} placeholder="e.g., Computer Science" autoFocus />
            <Input label="Department Code" value={deptCode} onChange={(e) => setDeptCode(e.target.value)} placeholder="e.g., BCA" />
          </div>
        )

      case 6:
        return (
          <div className="space-y-4">
            <h2 className="text-xl font-semibold text-secondary-900">First Faculty Member</h2>
            <p className="text-sm text-secondary-500">Add at least one faculty member. You can add more later.</p>
            <Input label="Faculty Name" value={facultyName} onChange={(e) => setFacultyName(e.target.value)} placeholder="e.g., Mrs. Ranjini" autoFocus />
          </div>
        )

      case 7:
        return (
          <div className="space-y-4">
            <h2 className="text-xl font-semibold text-secondary-900">First Subject</h2>
            <Input label="Subject Name" value={subjectName} onChange={(e) => setSubjectName(e.target.value)} placeholder="e.g., Artificial Intelligence" autoFocus />
            <Input label="Subject Code" value={subjectCode} onChange={(e) => setSubjectCode(e.target.value)} placeholder="e.g., BCA-301" />
          </div>
        )

      case 8:
        return (
          <div className="space-y-4">
            <h2 className="text-xl font-semibold text-secondary-900">First Section</h2>
            <Input label="Section Name" value={sectionName} onChange={(e) => setSectionName(e.target.value)} placeholder="e.g., I BCA-A" autoFocus />
            <Input label="Semester" type="number" value={semester} onChange={(e) => setSemester(e.target.value)} min={1} max={8} />
          </div>
        )

      case 9:
        return (
          <div className="space-y-4">
            <h2 className="text-xl font-semibold text-secondary-900">First Room</h2>
            <Input label="Room Name" value={roomName} onChange={(e) => setRoomName(e.target.value)} placeholder="e.g., Room 101" autoFocus />
          </div>
        )

      case 10:
        return (
          <div className="text-center py-8">
            <div className="flex justify-center mb-6">
              <div className="flex h-16 w-16 items-center justify-center rounded-full bg-success-100">
                <CheckCircle className="h-8 w-8 text-success-600" />
              </div>
            </div>
            <h2 className="text-2xl font-bold text-secondary-900 mb-3">Setup Complete!</h2>
            <p className="text-secondary-600 mb-6">
              Your SubstiFlow is ready. Next steps:
            </p>
            <ol className="text-left max-w-md mx-auto space-y-3 text-secondary-600">
              <li className="flex gap-3"><span className="font-bold text-primary-600">1.</span> Add all your faculty</li>
              <li className="flex gap-3"><span className="font-bold text-primary-600">2.</span> Add subjects and sections</li>
              <li className="flex gap-3"><span className="font-bold text-primary-600">3.</span> Enter the master timetable</li>
              <li className="flex gap-3"><span className="font-bold text-primary-600">4.</span> Start marking daily attendance</li>
            </ol>
          </div>
        )

      default:
        return null
    }
  }

  return (
    <div className="min-h-screen bg-secondary-50 flex items-center justify-center p-4">
      <div className="w-full max-w-2xl">
        {/* Progress Steps */}
        <div className="mb-8">
          <div className="flex items-center justify-between mb-2">
            <span className="text-sm font-medium text-secondary-600">
              Step {currentStep} of {STEPS.length}
            </span>
            <span className="text-sm text-secondary-500">{STEPS[currentStep - 1]?.title}</span>
          </div>
          <div className="h-2 bg-secondary-200 rounded-full overflow-hidden">
            <div 
              className="h-full bg-primary-600 rounded-full transition-all duration-300"
              style={{ width: `${(currentStep / STEPS.length) * 100}%` }}
            />
          </div>
          <div className="flex justify-between mt-4">
            {STEPS.map((step, index) => (
              <div key={step.id} className={cn('flex flex-col items-center', index > 5 ? 'hidden' : '')}>
                <div className={cn(
                  'flex h-8 w-8 items-center justify-center rounded-full border-2 text-xs font-medium',
                  currentStep > step.id ? 'bg-success-500 border-success-500 text-white' :
                  currentStep === step.id ? 'bg-primary-600 border-primary-600 text-white' :
                  'bg-white border-secondary-300 text-secondary-400'
                )}>
                  {currentStep > step.id ? <CheckCircle className="h-4 w-4" /> : step.id}
                </div>
                <span className="text-xs text-secondary-500 mt-1 hidden sm:block">{step.title}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Step Content */}
        <Card>
          <CardBody>
            {renderStep()}
          </CardBody>
        </Card>

        {/* Navigation */}
        <div className="flex justify-between mt-6">
          <Button 
            variant="ghost" 
            onClick={handleBack} 
            disabled={currentStep === 1}
          >
            <ArrowLeft className="h-4 w-4" />
            Back
          </Button>
          <Button 
            onClick={handleNext} 
            disabled={!canProceed() || saving}
            loading={saving}
          >
            {currentStep === STEPS.length ? 'Finish' : 'Next'}
            {currentStep !== STEPS.length && <ArrowRight className="h-4 w-4" />}
          </Button>
        </div>
      </div>
    </div>
  )
}