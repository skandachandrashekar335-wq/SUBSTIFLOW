import { cn } from '@/utils/cn'

export interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  variant?: 'success' | 'warning' | 'danger' | 'info' | 'neutral'
}

export function Badge({ className, variant = 'neutral', children, ...props }: BadgeProps) {
  const variantClasses = {
    success: 'bg-success-50 text-success-700',
    warning: 'bg-warning-50 text-warning-700',
    danger: 'bg-danger-50 text-danger-700',
    info: 'bg-primary-50 text-primary-700',
    neutral: 'bg-secondary-100 text-secondary-700',
  }

  return (
    <span
      className={cn('inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium', variantClasses[variant], className)}
      {...props}
    >
      {children}
    </span>
  )
}