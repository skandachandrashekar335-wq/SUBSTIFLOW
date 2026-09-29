import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { academicYearRepository, settingsRepository } from '@/db/repositories'
import { todayISO } from '@/utils/date'
import { AcademicYear } from '@/types'

interface AppState {
  // Setup — `null` means "not checked yet", so the setup wizard is never
  // flashed for a frame on launches where setup has already been completed.
  isSetupComplete: boolean | null
  checkSetup: () => void
  completeSetup: () => void
  
  // Current academic year
  currentAcademicYear: AcademicYear | null
  setCurrentAcademicYear: (year: AcademicYear | null) => void
  loadActiveAcademicYear: () => void
  
  // UI state
  sidebarOpen: boolean
  toggleSidebar: () => void
  setSidebarOpen: (open: boolean) => void
  
  // Current date for attendance/substitution
  currentDate: string
  setCurrentDate: (date: string) => void
}

export const useAppStore = create<AppState>()(
  persist(
    (set, get) => ({
      // Setup
      isSetupComplete: null,
      checkSetup: () => {
        const complete = settingsRepository.isSetupComplete()
        set({ isSetupComplete: complete })
        if (complete) {
          get().loadActiveAcademicYear()
        }
      },
      completeSetup: () => {
        settingsRepository.setSetupComplete(true)
        set({ isSetupComplete: true })
        get().loadActiveAcademicYear()
      },
      
      // Current academic year
      currentAcademicYear: null,
      setCurrentAcademicYear: (year) => set({ currentAcademicYear: year }),
      loadActiveAcademicYear: () => {
        const year = academicYearRepository.getActive()
        set({ currentAcademicYear: year })
      },
      
      // UI state
      sidebarOpen: true,
      toggleSidebar: () => set(state => ({ sidebarOpen: !state.sidebarOpen })),
      setSidebarOpen: (open) => set({ sidebarOpen: open }),
      
      // Current date: always starts on today. It is deliberately *not*
      // persisted — a coordinator opening the app tomorrow must see tomorrow,
      // not the date that happened to be selected on the previous run.
      currentDate: todayISO(),
      setCurrentDate: (date) => set({ currentDate: date }),
    }),
    {
      name: 'substiflow-app-state',
      partialize: (state) => ({
        sidebarOpen: state.sidebarOpen,
      }),
      merge: (persistedState, currentState) => ({
        ...currentState,
        ...((persistedState ?? {}) as Partial<AppState>),
        currentDate: currentState.currentDate,
      }),
    }
  )
)