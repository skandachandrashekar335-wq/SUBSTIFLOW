import { LayoutDashboard, Users, Calendar, Clock, BookOpen, Building2, FileText, Settings, Database, CheckSquare, Grid, UsersRound, BookCheck, Zap } from 'lucide-react'
import { useEffect, useState } from 'react'
import { NavLink, useLocation } from 'react-router-dom'
import { useAppStore } from '@/stores/appStore'
import { cn } from '@/utils/cn'

const navigation = [
  { name: 'Dashboard', href: '/dashboard', icon: LayoutDashboard },
  { name: "Today's Attendance", href: '/attendance', icon: CheckSquare },
  { name: 'Substitution Planner', href: '/substitution', icon: Calendar },
  { name: 'Master Timetable', href: '/timetable', icon: Grid },
  { name: 'Teaching Allocations', href: '/teaching', icon: UsersRound },
  { name: 'Subject Requirements', href: '/requirements', icon: BookCheck },
  { name: 'Timetable Generation', href: '/generation', icon: Zap },
  { name: 'Faculty', href: '/faculty', icon: Users },
  { name: 'Subjects', href: '/subjects', icon: BookOpen },
  { name: 'Classes', href: '/classes', icon: Building2 },
  { name: 'Rooms', href: '/rooms', icon: Building2 },
  { name: 'Reports', href: '/reports', icon: FileText },
  { name: 'Settings', href: '/settings', icon: Settings },
  { name: 'Backup & Restore', href: '/backup', icon: Database },
]

export function Sidebar() {
  const { sidebarOpen, toggleSidebar, currentAcademicYear } = useAppStore()
  const location = useLocation()
  // The real version comes from the main process — a hardcoded literal would
  // drift from package.json at the first release after 1.0.0 and mislead
  // every bug report ("I'm on 1.0.0" while running something newer).
  const [appVersion, setAppVersion] = useState<string | null>(null)
  const [isDemo, setIsDemo] = useState(false)
  useEffect(() => {
    window.electron?.app
      .getInfo()
      .then((info) => {
        setAppVersion(info && 'version' in info ? info.version : null)
        setIsDemo(!!(info && 'isDemo' in info && info.isDemo))
      })
      .catch(() => setAppVersion(null))
  }, [])

  return (
    <aside className={cn(
      'fixed left-0 top-0 z-40 h-screen bg-white border-r border-secondary-200 transition-all duration-200',
      sidebarOpen ? 'w-64' : 'w-20'
    )}>
      <div className="flex h-full flex-col">
        {/* Logo */}
        <div className={cn('flex h-16 items-center justify-between px-4 border-b border-secondary-200', !sidebarOpen && 'justify-center')}>
          <div className={cn('flex items-center gap-2', !sidebarOpen && 'justify-center')}>
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary-600">
              <Clock className="h-5 w-5 text-white" />
            </div>
            {sidebarOpen && (
              <span className="text-lg font-semibold text-secondary-900">SubstiFlow</span>
            )}
          </div>
          <button
            onClick={toggleSidebar}
            className={cn('p-1.5 rounded-lg text-secondary-500 hover:bg-secondary-100 transition-colors', !sidebarOpen && 'mx-auto')}
            aria-label={sidebarOpen ? 'Collapse sidebar' : 'Expand sidebar'}
          >
            <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d={sidebarOpen ? 'M11 19l-7-7 7-7' : 'M13 5l7 7-7 7'} />
            </svg>
          </button>
        </div>

        {/* Academic Year indicator */}
        {currentAcademicYear && sidebarOpen && (
          <div className="px-4 py-3 border-b border-secondary-200 bg-secondary-50">
            <p className="text-xs text-secondary-500 uppercase tracking-wider">Active Year</p>
            <p className="text-sm font-medium text-secondary-900 truncate">{currentAcademicYear.name}</p>
          </div>
        )}

        {/* Navigation */}
        <nav className="flex-1 overflow-y-auto py-4 px-3" aria-label="Main navigation">
          <ul className="space-y-1" role="list">
            {navigation.map((item) => {
              const isActive = location.pathname === item.href || location.pathname.startsWith(item.href + '/')
              return (
                <li key={item.name}>
                  <NavLink
                    to={item.href}
                    className={cn(
                      'flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors',
                      isActive
                        ? 'bg-primary-50 text-primary-700'
                        : 'text-secondary-600 hover:bg-secondary-50 hover:text-secondary-900',
                      !sidebarOpen && 'justify-center'
                    )}
                    title={sidebarOpen ? undefined : item.name}
                    aria-current={isActive ? 'page' : undefined}
                  >
                    <item.icon className="h-5 w-5 flex-shrink-0" aria-hidden="true" />
                    {sidebarOpen && <span>{item.name}</span>}
                  </NavLink>
                </li>
              )
            })}
          </ul>
        </nav>

        {/* Footer */}
        <div className={cn('p-4 border-t border-secondary-200', !sidebarOpen && 'hidden')}>
          {isDemo && (
            <div className="mb-2 rounded-md bg-danger-600 px-2 py-1 text-center text-[10px] font-bold uppercase tracking-wider text-white">
              Demo Data
            </div>
          )}
          <div className="text-xs text-secondary-500 text-center">
            SubstiFlow{appVersion ? ` v${appVersion}` : ''}
          </div>
        </div>
      </div>
    </aside>
  )
}