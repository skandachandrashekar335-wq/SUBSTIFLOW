import { Menu, User } from 'lucide-react'
import { useAppStore } from '@/stores/appStore'
import { cn } from '@/utils/cn'

export function Header() {
  const { sidebarOpen, toggleSidebar } = useAppStore()

  return (
    <header className={cn(
      'fixed top-0 right-0 z-30 h-16 bg-white border-b border-secondary-200 transition-all duration-200',
      sidebarOpen ? 'left-64' : 'left-20'
    )}>
      <div className="flex h-full items-center justify-between px-4">
        <div className="flex items-center gap-4">
          <button
            onClick={toggleSidebar}
            className="lg:hidden p-2 rounded-lg text-secondary-500 hover:bg-secondary-100"
            aria-label="Toggle menu"
          >
            <Menu className="h-6 w-6" />
          </button>
        </div>

        {/* Static identity badge — deliberately not a button: there is no
            account menu, and a non-functional control is worse than none. */}
        <div className="flex items-center gap-2 p-1.5" aria-label="Signed in as coordinator">
          <div className="h-8 w-8 rounded-full bg-primary-100 flex items-center justify-center">
            <User className="h-5 w-5 text-primary-600" />
          </div>
          <span className="hidden sm:block text-sm font-medium text-secondary-700">Coordinator</span>
        </div>
      </div>
    </header>
  )
}