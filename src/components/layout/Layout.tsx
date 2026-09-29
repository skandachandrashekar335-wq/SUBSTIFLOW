import { Outlet } from 'react-router-dom'
import { Sidebar } from './Sidebar'
import { Header } from './Header'
import { cn } from '@/utils/cn'
import { useAppStore } from '@/stores/appStore'

export function Layout() {
  const { sidebarOpen } = useAppStore()

  return (
    <div className="min-h-screen bg-secondary-50">
      <Sidebar />
      <Header />
      <main className={cn(
        'pt-16 min-h-screen transition-all duration-200',
        sidebarOpen ? 'lg:pl-64' : 'lg:pl-20'
      )}>
        <div className="p-6">
          <Outlet />
        </div>
      </main>
    </div>
  )
}