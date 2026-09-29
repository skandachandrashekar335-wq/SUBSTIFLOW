import React, { useEffect } from 'react'
import { Routes, Route, Navigate } from 'react-router-dom'
import { Layout } from '@/components/layout/Layout'
import { Dashboard } from '@/pages/Dashboard'
import { Attendance } from '@/pages/Attendance'
import { SubstitutionPlanner } from '@/pages/SubstitutionPlanner'
import { MasterTimetable } from '@/pages/MasterTimetable'
import { Faculty } from '@/pages/Faculty'
import { Subjects } from '@/pages/Subjects'
import { Classes } from '@/pages/Classes'
import { Rooms } from '@/pages/Rooms'
import { Reports } from '@/pages/Reports'
import { Settings } from '@/pages/Settings'
import { BackupRestore } from '@/pages/BackupRestore'
import { FirstRunSetup } from '@/pages/FirstRunSetup'
import { ErrorBoundary } from '@/components/ErrorBoundary'
import { useAppStore } from '@/stores/appStore'

function App() {
  const { isSetupComplete, checkSetup } = useAppStore()

  useEffect(() => {
    checkSetup()
  }, [checkSetup])

  // `null` = setup status not read from the database yet. Rendering nothing
  // for that single tick avoids flashing the first-run wizard on every launch.
  if (isSetupComplete === null) {
    return null
  }

  if (!isSetupComplete) {
    return <FirstRunSetup />
  }

  return (
    <ErrorBoundary>
      <Routes>
        <Route path="/" element={<Layout />}>
          <Route index element={<Navigate to="/dashboard" replace />} />
          <Route path="dashboard" element={<Dashboard />} />
          <Route path="attendance" element={<Attendance />} />
          <Route path="substitution" element={<SubstitutionPlanner />} />
          <Route path="timetable" element={<MasterTimetable />} />
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