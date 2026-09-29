import { forwardRef, InputHTMLAttributes } from 'react'
import { Check } from 'lucide-react'
import { cn } from '@/utils/cn'

export interface CheckboxProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string
}

export const Checkbox = forwardRef<HTMLInputElement, CheckboxProps>(
  ({ className, label, id, ...props }, ref) => {
    const checkboxId = id || label?.toLowerCase().replace(/\s+/g, '-')

    return (
      <div className="flex items-center gap-2">
        <input
          ref={ref}
          type="checkbox"
          id={checkboxId}
          className={cn(
            'h-4 w-4 rounded border-secondary-300 text-primary-600 focus:ring-2 focus:ring-primary-500 focus:ring-offset-2 transition-colors',
            'checked:bg-primary-600 checked:border-primary-600',
            className
          )}
          {...props}
        />
        {label && (
          <label htmlFor={checkboxId} className="text-sm text-secondary-700 cursor-pointer">
            {label}
          </label>
        )}
      </div>
    )
  }
)

Checkbox.displayName = 'Checkbox'