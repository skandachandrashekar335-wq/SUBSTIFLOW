import { Fragment, ReactNode, useEffect } from 'react'
import { X } from 'lucide-react'
import { cn } from '@/utils/cn'

interface DialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  title?: string
  description?: string
  children: ReactNode
  className?: string
}

export function Dialog({ open, onOpenChange, title, description, children, className }: DialogProps) {
  // Escape closes the dialog (QA-040). The overlay makes dialogs mutually
  // exclusive, so only one listener is ever active for the visible dialog.
  useEffect(() => {
    if (!open) return
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        onOpenChange(false)
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [open, onOpenChange])

  if (!open) return null

  return (
    <Fragment>
      <div 
        className="fixed inset-0 bg-black/50 z-50 animate-fade-in"
        onClick={() => onOpenChange(false)}
        aria-hidden="true"
      />
      <div 
        className={cn(
          'fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 z-50 w-full max-w-2xl bg-white rounded-xl shadow-xl animate-slide-up',
          className
        )}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby={title ? 'dialog-title' : undefined}
        aria-describedby={description ? 'dialog-description' : undefined}
      >
        {(title || description) && (
          <div className="flex items-start justify-between p-6 border-b border-secondary-200">
            <div>
              {title && (
                <h2 id="dialog-title" className="text-lg font-semibold text-secondary-900">
                  {title}
                </h2>
              )}
              {description && (
                <p id="dialog-description" className="mt-1 text-sm text-secondary-500">
                  {description}
                </p>
              )}
            </div>
            <button
              onClick={() => onOpenChange(false)}
              className="text-secondary-400 hover:text-secondary-600 transition-colors p-1"
              aria-label="Close dialog"
            >
              <X className="h-5 w-5" />
            </button>
          </div>
        )}
        <div className="p-6">
          {children}
        </div>
      </div>
    </Fragment>
  )
}

interface DialogHeaderProps {
  title: string
  description?: string
}

export function DialogHeader({ title, description }: DialogHeaderProps) {
  return (
    <div>
      <h3 className="text-lg font-semibold text-secondary-900">{title}</h3>
      {description && (
        <p className="mt-1 text-sm text-secondary-500">{description}</p>
      )}
    </div>
  )
}

export function DialogContent({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={className}>{children}</div>
}

export function DialogFooter({ children }: { children: ReactNode }) {
  return (
    <div className="mt-6 flex justify-end gap-3">
      {children}
    </div>
  )
}