import { ReactNode } from 'react'
import { cn } from '@/utils/cn'

export interface CardProps {
  children: ReactNode
  className?: string
  /** Extra attributes (e.g. data-testid) are forwarded to the wrapper div. */
  [key: string]: unknown
}

export function Card({ children, className, ...rest }: CardProps) {
  return (
    <div className={cn('bg-white rounded-xl border border-secondary-200 shadow-sm', className)} {...rest}>
      {children}
    </div>
  )
}

export function CardHeader({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn('px-6 py-4 border-b border-secondary-200', className)}>
      {children}
    </div>
  )
}

export function CardBody({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn('p-6', className)}>
      {children}
    </div>
  )
}

export function CardFooter({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn('px-6 py-4 border-t border-secondary-200 bg-secondary-50 rounded-b-xl', className)}>
      {children}
    </div>
  )
}