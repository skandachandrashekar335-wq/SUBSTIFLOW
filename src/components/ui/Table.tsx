import { ReactNode } from 'react'
import { cn } from '@/utils/cn'

export interface TableProps {
  children: ReactNode
  className?: string
}

export function Table({ children, className }: TableProps) {
  return (
    <div className={cn('overflow-x-auto', className)}>
      <table className="w-full text-sm text-left">{children}</table>
    </div>
  )
}

export function TableHeader({ children, className }: { children: ReactNode; className?: string }) {
  return <thead className={cn('[&_tr]:border-b', className)}>{children}</thead>
}

export function TableBody({ children, className }: { children: ReactNode; className?: string }) {
  return <tbody className={cn('[&_tr:last-child]:border-0', className)}>{children}</tbody>
}

export function TableRow({ children, className, ...props }: React.HTMLAttributes<HTMLTableRowElement>) {
  return (
    <tr className={cn('border-b border-secondary-100 hover:bg-secondary-50 transition-colors', className)} {...props}>
      {children}
    </tr>
  )
}

export function TableHead({ children, className, ...props }: React.ThHTMLAttributes<HTMLTableCellElement>) {
  return (
    <th className={cn('px-4 py-3 font-medium text-secondary-600 bg-secondary-50 border-b border-secondary-200', className)} {...props}>
      {children}
    </th>
  )
}

export function TableCell({ children, className, ...props }: React.TdHTMLAttributes<HTMLTableCellElement>) {
  return (
    <td className={cn('px-4 py-3 border-b border-secondary-100', className)} {...props}>
      {children}
    </td>
  )
}

export function TableCaption({ children, className }: React.HTMLAttributes<HTMLTableCaptionElement>) {
  return <caption className={cn('px-4 py-3 text-sm text-secondary-500', className)}>{children}</caption>
}