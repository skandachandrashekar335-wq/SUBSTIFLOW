import { X } from 'lucide-react'
import { cn } from '@/utils/cn'

export interface MultiSelectOption {
  value: string
  label: string
}

export interface MultiSelectProps {
  label?: string
  /** All options; the caller keeps currently-selected values present so they always render. */
  options: MultiSelectOption[]
  /** Selected values, in order (order = team order / room order). */
  value: string[]
  onChange: (value: string[]) => void
  helperText?: string
  /** Shown when `options` is empty. */
  emptyText?: string
  className?: string
}

/**
 * Multi-value picker: selected values appear as removable chips, and every
 * option is a toggle button below them. Used for teaching teams (several
 * faculty can share one activity) and for an entry's rooms (0..N — zero means
 * "Not specified", which is a valid state).
 *
 * Plain buttons (not a custom dropdown) so the control is keyboard- and
 * test-friendly: each option is a real <button> whose text is the label.
 */
export function MultiSelect({
  label,
  options,
  value,
  onChange,
  helperText,
  emptyText = 'No options available',
  className,
}: MultiSelectProps) {
  const remove = (v: string) => onChange(value.filter(x => x !== v))
  const toggle = (v: string) => (value.includes(v) ? remove(v) : onChange([...value, v]))

  return (
    <div className={cn('w-full', className)}>
      {label && (
        <div className="block text-sm font-medium text-secondary-700 mb-1">{label}</div>
      )}
      <div className="rounded-lg border border-secondary-300 bg-white p-2 space-y-2">
        {value.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {value.map(v => {
              const chipLabel = options.find(o => o.value === v)?.label ?? v
              return (
                <span
                  key={v}
                  className="inline-flex items-center gap-1 rounded-full bg-primary-50 border border-primary-200 text-primary-700 px-2.5 py-0.5 text-xs font-medium"
                >
                  {chipLabel}
                  <button
                    type="button"
                    aria-label={`Remove ${chipLabel}`}
                    onClick={() => remove(v)}
                    className="rounded-full hover:bg-primary-100"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </span>
              )
            })}
          </div>
        )}
        <div className="flex flex-wrap gap-1.5">
          {options.length === 0 && (
            <span className="text-xs text-secondary-400">{emptyText}</span>
          )}
          {options.map(o => {
            const on = value.includes(o.value)
            return (
              <button
                type="button"
                key={o.value}
                aria-pressed={on}
                onClick={() => toggle(o.value)}
                className={cn(
                  'rounded border px-2 py-1 text-xs font-medium transition-colors',
                  on
                    ? 'bg-primary-600 border-primary-600 text-white'
                    : 'bg-white border-secondary-300 text-secondary-600 hover:border-primary-400 hover:text-primary-600'
                )}
              >
                {o.label}
              </button>
            )
          })}
        </div>
      </div>
      {helperText && <p className="mt-1 text-sm text-secondary-500">{helperText}</p>}
    </div>
  )
}
