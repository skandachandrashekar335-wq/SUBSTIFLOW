/**
 * Draft-grid rendering regressions.
 *
 * Three defects found in the running app, fixed at the source:
 *
 *  1. DUPLICATE TIME LABELS — every default period is named after its own
 *     time range ("09:00-10:00"), and the period cell rendered the name AND
 *     `startTime–endTime`, printing the same label twice in one cell.
 *  2. MISLEADING ROOM STATE — lectures (room-independent in this app) showed
 *     "Room —", which reads like a broken lookup rather than a valid state.
 *  3. HORIZONTAL CLIPPING — every configured section must stay reachable in
 *     one horizontal scroll container with headers aligned to their columns.
 *
 * Rendered with react-dom/server (already used by iconButton.test.ts) — no
 * browser, no new dependencies, no database.
 */
import { describe, it, expect } from 'vitest'
import { createElement, ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { DayRows, DraftGrid, renderDraftEntry } from '@/pages/Generation'
import type { DayOfWeek, DraftTimetableEntryWithRelations, Faculty, Room, Subject, TimeSlot } from '@/types'

function render(el: ReactElement): string {
  return renderToStaticMarkup(el)
}

function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1
}

const DEFAULT_SLOTS: TimeSlot[] = [
  { id: 'slot-1', name: '09:00-10:00', startTime: '09:00', endTime: '10:00', order: 1, isBreak: false },
  { id: 'slot-2', name: '10:00-11:00', startTime: '10:00', endTime: '11:00', order: 2, isBreak: false },
  { id: 'break', name: '13:00-14:00', startTime: '13:00', endTime: '14:00', order: 5, isBreak: true },
]

const SECTIONS = [
  { id: 'sec-a', name: 'I BCA A' },
  { id: 'sec-b', name: 'I BCA B' },
  { id: 'sec-c', name: 'III BCA A' },
  { id: 'sec-d', name: 'III BCA B' },
  { id: 'sec-e', name: 'V BCA A' },
  { id: 'sec-f', name: 'V BCA B' },
]

function makeEntry(overrides: Partial<DraftTimetableEntryWithRelations> = {}): DraftTimetableEntryWithRelations {
  return {
    id: 'entry-1',
    generationId: 'gen-1',
    academicYearId: 'year-1',
    dayOfWeek: 'MONDAY' as DayOfWeek,
    timeSlotId: 'slot-1',
    sectionId: 'sec-a',
    subjectId: 'sub-1',
    classType: 'LECTURE',
    span: 1,
    status: 'DRAFT',
    createdAt: '2026-10-13T00:00:00',
    updatedAt: '2026-10-13T00:00:00',
    subject: { id: 'sub-1', name: 'DMS', code: '24BCA31' } as Subject,
    facultyList: [{ id: 'fac-1', name: 'Demo Faculty 01' } as Faculty],
    roomList: [],
    ...overrides,
  }
}

describe('period cell time labels (duplicate-label regression)', () => {
  it('renders the time exactly once when the period name already is the range', () => {
    const html = render(
      createElement(DayRows, {
        day: 'MONDAY' as DayOfWeek,
        slots: DEFAULT_SLOTS,
        sections: [{ id: 'sec-a', name: 'I BCA A' }],
        cells: new Map(),
        renderEntry: () => null,
      })
    )
    // Default period name "09:00-10:00" carries the range itself; the old
    // markup printed it again underneath as "09:00–10:00" (en-dash line).
    expect(count(html, '09:00')).toBe(1)
    expect(html).not.toContain('09:00–10:00')
  })

  it('still shows the range once when the period has a descriptive name', () => {
    const slots: TimeSlot[] = [
      { id: 'slot-1', name: 'Period 1', startTime: '09:00', endTime: '10:00', order: 1, isBreak: false },
    ]
    const html = render(
      createElement(DayRows, {
        day: 'MONDAY' as DayOfWeek,
        slots,
        sections: [{ id: 'sec-a', name: 'I BCA A' }],
        cells: new Map(),
        renderEntry: () => null,
      })
    )
    expect(html).toContain('Period 1')
    expect(count(html, '09:00')).toBe(1) // shown once, as the range line
  })

  it('does not duplicate a name that only differs by spacing or dash style', () => {
    const slots: TimeSlot[] = [
      { id: 'slot-1', name: '09:00 – 10:00', startTime: '09:00', endTime: '10:00', order: 1, isBreak: false },
    ]
    const html = render(
      createElement(DayRows, {
        day: 'MONDAY' as DayOfWeek,
        slots,
        sections: [{ id: 'sec-a', name: 'I BCA A' }],
        cells: new Map(),
        renderEntry: () => null,
      })
    )
    expect(count(html, '09:00')).toBe(1)
  })
})

describe('draft grid layout (horizontal reachability + rendering)', () => {
  it('puts every configured section in one horizontal scroll container', () => {
    const html = render(
      createElement(DraftGrid, {
        days: ['MONDAY'] as DayOfWeek[],
        slots: DEFAULT_SLOTS,
        sections: SECTIONS,
        cells: new Map(),
        renderEntry: () => null,
        entryCount: 0,
      })
    )
    expect(html).toContain('overflow-x-auto')
    // Header lists every section …
    for (const s of SECTIONS) expect(html).toContain(s.name)
    // … and each day row renders exactly one body cell per section
    // (header = sections + "Period" column).
    const headers = html.match(/<th[\s>]/g)?.length ?? 0
    expect(headers).toBe(SECTIONS.length + 1)
    // One row per working day shown + header row.
    expect(html).toContain('Monday')
  })

  it('renders a multi-period activity as one card with a continuation mark', () => {
    const lab = makeEntry({ classType: 'LAB', span: 2 })
    const cells = new Map([
      ['MONDAY|slot-1', [{ entry: lab, isStart: true }]],
      ['MONDAY|slot-2', [{ entry: lab, isStart: false }]],
    ])
    const html = render(
      createElement(DraftGrid, {
        days: ['MONDAY'] as DayOfWeek[],
        slots: DEFAULT_SLOTS,
        sections: [{ id: 'sec-a', name: 'I BCA A' }],
        cells,
        renderEntry: renderDraftEntry,
        entryCount: 1,
      })
    )
    expect(html).toContain('DMS')
    expect(html).toContain('continues')
    // The card itself appears once (the second cell is only a continuation).
    expect(count(html, '>DMS')).toBe(1)
  })

  it('renders the break row as a single spanning row, not per-section cells', () => {
    const html = render(
      createElement(DraftGrid, {
        days: ['MONDAY'] as DayOfWeek[],
        slots: DEFAULT_SLOTS,
        sections: SECTIONS,
        cells: new Map(),
        renderEntry: () => null,
        entryCount: 0,
      })
    )
    expect(html).toContain('sessions are never scheduled across this period')
    // Break row: period cell + ONE cell spanning every section column.
    expect(count(html, `colSpan="${SECTIONS.length}"`)).toBe(1)
  })
})

describe('entry card room state (Room — regression)', () => {
  // renderDraftEntry takes (slotId, item) — invoke it directly inside a
  // wrapper component rather than using it as a React component.
  const card = (entry: DraftTimetableEntryWithRelations) => {
    const Card = () => renderDraftEntry('slot-1', { entry, isStart: true })
    return render(createElement(Card))
  }

  it('says "No room" for a room-independent lecture instead of the broken-looking dash', () => {
    const html = card(makeEntry({ roomList: [] }))
    expect(html).not.toContain('Room —')
    expect(html).toContain('No room')
  })

  it('renders the assigned room name for a lecture that has one', () => {
    const html = card(makeEntry({ roomList: [{ id: 'room-1', name: 'Demo Room 103' } as Room] }))
    expect(html).toContain('Demo Room 103')
    expect(html).not.toContain('Room —')
  })

  it('flags a LAB without a room as an error state, never a silent dash', () => {
    const html = card(makeEntry({ classType: 'LAB', roomList: [] }))
    expect(html).not.toContain('Room —')
    expect(html).toContain('No room assigned')
    expect(html).toContain('text-red-600')
  })
})
