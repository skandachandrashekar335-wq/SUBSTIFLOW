/**
 * Regression: invisible action icons in table Actions columns.
 *
 * Three pages (Teaching Allocations, Subject Requirements, Generation) built
 * icon buttons as `size="sm" className="h-7 w-7 p-0"`. Tailwind emits
 * `.px-3`/`.py-1.5` AFTER `.p-0` in the stylesheet, so the caller's `p-0`
 * silently lost: a fixed 28px border-box kept 12px side padding, leaving a
 * 4px content strip that crushed the 14px icon (flex-shrink) into a sliver.
 *
 * The fix is `size="icon"` on the shared Button — one source of truth for a
 * 36×36 square with no competing padding utilities — plus 16px icons.
 * These tests assert the rendered markup of that contract.
 */
import { describe, it, expect } from 'vitest'
import { createElement, ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { Button } from '@/components/ui/Button'

function render(el: ReactElement): string {
  return renderToStaticMarkup(el)
}

describe('icon action buttons (invisible-icon regression)', () => {
  it('size="icon" renders a 36×36 shrink-proof box with no padding utilities to fight', () => {
    const html = render(createElement(Button, { size: 'icon' }, 'X'))
    expect(html).toContain('h-9') // 36px ≥ the 32–36px hit-target floor
    expect(html).toContain('w-9')
    expect(html).toContain('p-0')
    expect(html).toContain('shrink-0') // stays 36px inside tight table cells
    // The exact bug: any px/py from another size would out-cascade p-0.
    expect(html).not.toMatch(/px-\d/)
    expect(html).not.toMatch(/py-\d/)
  })

  it('keeps visible hover and keyboard focus affordances', () => {
    const html = render(
      createElement(Button, { size: 'icon', variant: 'ghost' }, 'X')
    )
    expect(html).toContain('focus:ring-2')
    expect(html).toContain('focus:ring-offset-2')
    expect(html).toContain('hover:bg-secondary-100')
  })

  it('passes through accessible names (aria-label) and tooltips (title)', () => {
    const html = render(
      createElement(
        Button,
        { size: 'icon', title: "Edit Dr. Asha's allocation", 'aria-label': "Edit Dr. Asha's allocation" },
        'X'
      )
    )
    expect(html).toContain('title="Edit Dr. Asha&#x27;s allocation"')
    expect(html).toContain('aria-label="Edit Dr. Asha&#x27;s allocation"')
  })

  it('leaves the normal sm button unchanged (no regression for labelled buttons)', () => {
    const html = render(createElement(Button, { size: 'sm' }, 'Save'))
    expect(html).toContain('px-3')
    expect(html).toContain('py-1.5')
    expect(html).toContain('text-xs')
  })
})
