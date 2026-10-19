import React, { useEffect, useState } from 'react'
import { Routes, Route, Navigate } from 'react-router-dom'
import { AlertTriangle, RefreshCw } from 'lucide-react'
import { Layout } from '@/components/layout/Layout'
import { Dashboard } from '@/pages/Dashboard'
import { Attendance } from '@/pages/Attendance'
import { SubstitutionPlanner } from '@/pages/SubstitutionPlanner'
import { RevisedTimetable } from '@/pages/RevisedTimetable'
import { MasterTimetable } from '@/pages/MasterTimetable'
import { Faculty } from '@/pages/Faculty'
import { Subjects } from '@/pages/Subjects'
import { Classes } from '@/pages/Classes'
import { Rooms } from '@/pages/Rooms'
import { Reports } from '@/pages/Reports'
import { Settings } from '@/pages/Settings'
import { BackupRestore } from '@/pages/BackupRestore'
import { FirstRunSetup } from '@/pages/FirstRunSetup'
import { TeachingAllocations } from '@/pages/TeachingAllocations'
import { SubjectRequirements } from '@/pages/SubjectRequirements'
import { Generation } from '@/pages/Generation'
import { ErrorBoundary } from '@/components/ErrorBoundary'
import { Button } from '@/components/ui/Button'
import { useAppStore } from '@/stores/appStore'

function App() {
  const { isSetupComplete, checkSetup } = useAppStore()
  const [setupError, setSetupError] = useState<string | null>(null)

  useEffect(() => {
    // Reading the setup flag touches the database. If that fails (locked,
    // corrupt or unreadable file) the app must show WHY instead of dying
    // silently in the effect — the main process also logs + shows a native
    // error box and quits when first-init itself failed.
    try {
      checkSetup()
    } catch (error) {
      console.error('[App] setup check failed:', error)
      setSetupError(error instanceof Error ? error.message : String(error))
    }
  }, [checkSetup])

  // `null` = setup status not read from the database yet. Rendering nothing
  // for that single tick avoids flashing the first-run wizard on every launch.
  if (isSetupComplete === null && !setupError) {
    return null
  }

  if (setupError) {
    return (
      <div className="min-h-screen flex items-center justify-center p-6 bg-secondary-50">
        <div className="max-w-xl w-full bg-white border border-danger-200 rounded-xl p-6 space-y-4">
          <div className="flex items-center gap-3">
            <AlertTriangle className="h-6 w-6 text-danger-600" />
            <h1 className="text-lg font-semibold text-secondary-900">
              SubstiFlow could not open its database
            </h1>
          </div>
          <p className="text-sm text-secondary-600">
            The local database could not be read, so the app cannot start safely.
            Your saved data is untouched on disk. Try reloading; if the problem
            persists, close SubstiFlow, then restore your most recent backup from
            the Backup &amp; Restore screen of a working install.
          </p>
          <pre className="text-xs bg-secondary-50 border border-secondary-200 rounded-lg p-3 overflow-auto max-h-40 whitespace-pre-wrap">
            {setupError}
          </pre>
          <div className="flex gap-3">
            <Button onClick={() => window.location.reload()}>
              <RefreshCw className="h-4 w-4" />
              Reload app
            </Button>
          </div>
        </div>
      </div>
    )
  }

  if (!isSetupComplete) {
    // The wizard writes the first data — a render crash here used to leave a
    // blank window with no way forward.
    return (
      <ErrorBoundary>
        <FirstRunSetup />
      </ErrorBoundary>
    )
  }

  return (
    <ErrorBoundary>
      <Routes>
        <Route path="/" element={<Layout />}>
          <Route index element={<Navigate to="/dashboard" replace />} />
          <Route path="dashboard" element={<Dashboard />} />
          <Route path="attendance" element={<Attendance />} />
          <Route path="substitution" element={<SubstitutionPlanner />} />
          <Route path="revised" element={<RevisedTimetable />} />
          <Route path="timetable" element={<MasterTimetable />} />
          <Route path="teaching" element={<TeachingAllocations />} />
          <Route path="requirements" element={<SubjectRequirements />} />
          <Route path="generation" element={<Generation />} />
          <Route path="faculty" element={<Faculty />} />
          <Route path="subjects" element={<Subjects />} />
          <Route path="classes" element={<Classes />} />
          <Route path="rooms" element={<Rooms />} />
          <Route path="reports" element={<Reports />} />
          <Route path="settings" element={<Settings />} />
          <Route path="backup" element={<BackupRestore />} />
        </Route>
        <Route path="*" element={<Navigate to="/dashboard" replace />} />
      </Routes>
    </ErrorBoundary>
  )
}

export default App