import { ReactNode, useState, createContext, useContext } from 'react'
import { cn } from '@/utils/cn'

interface TabsContextValue {
  value: string
  onValueChange: (value: string) => void
}

const TabsContext = createContext<TabsContextValue | null>(null)

function useTabsContext() {
  const context = useContext(TabsContext)
  if (!context) {
    throw new Error('Tabs components must be used within Tabs')
  }
  return context
}

interface TabsProps {
  defaultValue: string
  onValueChange?: (value: string) => void
  children: ReactNode
  className?: string
}

export function Tabs({ defaultValue, onValueChange, children, className }: TabsProps) {
  const [value, setValue] = useState(defaultValue)

  return (
    <TabsContext.Provider value={{
      value,
      onValueChange: (newValue: string) => {
        setValue(newValue)
        onValueChange?.(newValue)
      },
    }}>
      <div className={cn(className)}>{children}</div>
    </TabsContext.Provider>
  )
}

interface TabsListProps {
  children: ReactNode
  className?: string
}

export function TabsList({ children, className }: TabsListProps) {
  return (
    <div 
      className={cn('inline-flex h-10 items-center justify-center rounded-lg bg-secondary-100 p-1 text-secondary-500', className)}
      role="tablist"
      aria-orientation="horizontal"
    >
      {children}
    </div>
  )
}

interface TabsTriggerProps {
  value: string
  children: ReactNode
  disabled?: boolean
  className?: string
}

export function TabsTrigger({ value, children, disabled, className }: TabsTriggerProps) {
  const { value: currentValue, onValueChange } = useTabsContext()
  const isActive = currentValue === value

  return (
    <button
      role="tab"
      aria-selected={isActive}
      aria-controls={`tabs-content-${value}`}
      id={`tabs-trigger-${value}`}
      disabled={disabled}
      onClick={() => !disabled && onValueChange(value)}
      className={cn(
        'inline-flex items-center justify-center whitespace-nowrap rounded-md px-3 py-1.5 text-sm font-medium transition-all focus:outline-none focus:ring-2 focus:ring-primary-500 focus:ring-offset-2 disabled:pointer-events-none disabled:opacity-50',
        isActive
          ? 'bg-white text-secondary-900 shadow-sm'
          : 'text-secondary-600 hover:text-secondary-900',
        className
      )}
    >
      {children}
    </button>
  )
}

interface TabsContentProps {
  value: string
  children: ReactNode
  className?: string
}

export function TabsContent({ value, children, className }: TabsContentProps) {
  const { value: currentValue } = useTabsContext()
  const isActive = currentValue === value

  if (!isActive) return null

  return (
    <div
      role="tabpanel"
      id={`tabs-content-${value}`}
      aria-labelledby={`tabs-trigger-${value}`}
      className={cn('mt-4', className)}
    >
      {children}
    </div>
  )
}