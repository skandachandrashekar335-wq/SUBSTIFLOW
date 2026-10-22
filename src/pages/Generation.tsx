import { useState, useMemo, useEffect, useCallback, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import {
  Loader2,
  AlertCircle,
  Zap,
  CheckCircle,
  XCircle,
  Eye,
  FileText,
  RefreshCw,
  AlertTriangle,
  Trash2,
  Upload,
  GripVertical,
  Undo2,
  ArrowLeftRight,
} from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { parseDbTimestamp } from '@/utils/date'
import { Card, CardBody } from '@/components/ui/Card'
import { Badge } from '@/components/ui/Badge'
import { Dialog, DialogFooter } from '@/components/ui/Dialog'
import { Table, TableHeader, TableBody, TableRow, TableCell, TableHead } from '@/components/ui/Table'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/Tabs'
import { useAppStore } from '@/stores/appStore'
import {
  timetableGenerationRepository,
  draftTimetableEntryRepository,
  generationDiagnosticRepository,
  subjectRequirementRepository,
} from '@/db/repositories'
import { timeSlotRepository } from '@/db/repositories/timeSlot'
import { settingsRepository } from '@/db/repositories/settings'
import {
  generateTimetable,
  validateDraftTimetable,
  publishDraftTimetable,
  getGenerationStatus,
  deleteGeneration,
  recoverStaleGenerations,
  moveDraftEntry,
  swapDraftEntries,
} from '@/services/timetableGenerator'
import { resolveCoveredSlots } from '@/services/timetable'
import {
  TimetableGeneration,
  DraftTimetableEntryWithRelations,
  GenerationDiagnostic,
  GenerationResult,
  GenerationStatus,
  DayOfWeek,
  classTypeLabel,
} from '@/types'
import { DraftValidationResult, GenerationStatusInfo, PublishResult } from '@/services/timetableGenerator'
import { cn } from '@/utils/cn'

const ALL_DAYS: DayOfWeek[] = ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY']

type TabId = 'overview' | 'draft' | 'diagnostics' | 'validation'

export function Generation() {
  const { currentAcademicYear } = useAppStore()
  const [generations, setGenerations] = useState<TimetableGeneration[]>([])
  const [activeGenerationId, setActiveGenerationId] = useState<string | null>(null)
  const [activeTab, setActiveTab] = useState<TabId>('overview')
  const [generating, setGenerating] = useState(false)
  const [publishing, setPublishing] = useState(false)
  const [validationResult, setValidationResult] = useState<DraftValidationResult | null>(null)
  const [draftEntries, setDraftEntries] = useState<DraftTimetableEntryWithRelations[]>([])
  const [diagnostics, setDiagnostics] = useState<GenerationDiagnostic[]>([])
  const [statusInfo, setStatusInfo] = useState<GenerationStatusInfo | null>(null)
  const [lastResult, setLastResult] = useState<GenerationResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [publishDialogOpen, setPublishDialogOpen] = useState(false)
  const [deleteDialogId, setDeleteDialogId] = useState<string | null>(null)

  // Draft editing state (drag & drop, accessible move/swap, undo history)
  const [moveDialogOpen, setMoveDialogOpen] = useState(false)
  const [moveTargetEntry, setMoveTargetEntry] = useState<DraftTimetableEntryWithRelations | null>(null)
  const [selectedMoveDay, setSelectedMoveDay] = useState<DayOfWeek>('MONDAY')
  const [selectedMoveSlotId, setSelectedMoveSlotId] = useState<string>('')
  const [selectedSwapEntryId, setSelectedSwapEntryId] = useState<string>('')
  const [moveMode, setMoveMode] = useState<'move' | 'swap'>('move')
  const [moveError, setMoveError] = useState<string | null>(null)
  const [editHistory, setEditHistory] = useState<
    Array<{
      type: 'move' | 'swap'
      entryIdA: string
      dayA: DayOfWeek
      slotIdA: string
      entryIdB?: string
      dayB?: DayOfWeek
      slotIdB?: string
      desc: string
    }>
  >([])

  const activeGeneration = useMemo(
    () => generations.find((g) => g.id === activeGenerationId) ?? null,
    [generations, activeGenerationId]
  )

  const isPublished = useMemo(
    () => statusInfo?.published === true,
    [statusInfo]
  )
  const isEditable = useMemo(
    () => !isPublished && activeGeneration?.status === 'COMPLETED',
    [isPublished, activeGeneration]
  )

  const loadGenerations = useCallback(() => {
    if (!currentAcademicYear) return
    // Crash recovery: flip rows a shutdown left in RUNNING to FAILED before
    // listing. Never touches runs active in this process or terminal rows.
    recoverStaleGenerations()
    const gens = timetableGenerationRepository.findByAcademicYear(currentAcademicYear.id)
    setGenerations(gens)
    return gens
  }, [currentAcademicYear])

  const loadGenerationDetails = useCallback((generationId: string) => {
    setDraftEntries(draftTimetableEntryRepository.findByGenerationWithRelations(generationId))
    setDiagnostics(generationDiagnosticRepository.findByGeneration(generationId))
    setStatusInfo(getGenerationStatus(generationId))
    // Independent validation pass — recomputed from scratch on every view.
    setValidationResult(validateDraftTimetable(generationId))
  }, [])

  const handleMove = useCallback(
    (entryId: string, targetDay: DayOfWeek, targetSlotId: string) => {
      if (!activeGenerationId) return
      const entry = draftEntries.find((e) => e.id === entryId)
      if (!entry) return
      if (entry.dayOfWeek === targetDay && entry.timeSlotId === targetSlotId) return

      const prevDay = entry.dayOfWeek
      const prevSlotId = entry.timeSlotId

      const res = moveDraftEntry(activeGenerationId, entryId, targetDay, targetSlotId)
      if (!res.success) {
        setError(res.error || 'Could not move session.')
        return
      }

      setEditHistory((prev) => [
        {
          type: 'move',
          entryIdA: entryId,
          dayA: prevDay,
          slotIdA: prevSlotId,
          desc: `Moved ${entry.subject?.name ?? 'session'} to ${targetDay}`,
        },
        ...prev.slice(0, 19),
      ])

      // Invalidate previous validation status
      setValidationResult(null)
      setError(null)
      setNotice(
        `Moved ${entry.subject?.name ?? 'session'} to ${targetDay}. Previous validation cleared — re-run validation before publishing.`
      )
      loadGenerationDetails(activeGenerationId)
    },
    [activeGenerationId, draftEntries, loadGenerationDetails]
  )

  const handleSwap = useCallback(
    (entryIdA: string, entryIdB: string) => {
      if (!activeGenerationId) return
      if (entryIdA === entryIdB) return
      const entryA = draftEntries.find((e) => e.id === entryIdA)
      const entryB = draftEntries.find((e) => e.id === entryIdB)
      if (!entryA || !entryB) return

      const prevDayA = entryA.dayOfWeek
      const prevSlotA = entryA.timeSlotId
      const prevDayB = entryB.dayOfWeek
      const prevSlotB = entryB.timeSlotId

      const res = swapDraftEntries(activeGenerationId, entryIdA, entryIdB)
      if (!res.success) {
        setError(res.error || 'Could not swap sessions.')
        return
      }

      setEditHistory((prev) => [
        {
          type: 'swap',
          entryIdA,
          dayA: prevDayA,
          slotIdA: prevSlotA,
          entryIdB,
          dayB: prevDayB,
          slotIdB: prevSlotB,
          desc: `Swapped ${entryA.subject?.name ?? 'class'} and ${entryB.subject?.name ?? 'class'}`,
        },
        ...prev.slice(0, 19),
      ])

      // Invalidate previous validation status
      setValidationResult(null)
      setError(null)
      setNotice(
        `Swapped ${entryA.subject?.name ?? 'class'} and ${entryB.subject?.name ?? 'class'}. Previous validation cleared — re-run validation before publishing.`
      )
      loadGenerationDetails(activeGenerationId)
    },
    [activeGenerationId, draftEntries, loadGenerationDetails]
  )

  const handleUndo = useCallback(() => {
    if (!activeGenerationId || editHistory.length === 0) return
    const [lastEdit, ...rest] = editHistory

    if (lastEdit.type === 'move') {
      const res = moveDraftEntry(activeGenerationId, lastEdit.entryIdA, lastEdit.dayA, lastEdit.slotIdA)
      if (res.success) {
        setEditHistory(rest)
        setValidationResult(null)
        setError(null)
        setNotice(`Undid last move: restored session to ${lastEdit.dayA}. Re-run validation before publishing.`)
        loadGenerationDetails(activeGenerationId)
      } else {
        setError(`Could not undo move: ${res.error}`)
      }
    } else if (lastEdit.type === 'swap' && lastEdit.entryIdB) {
      const res = swapDraftEntries(activeGenerationId, lastEdit.entryIdA, lastEdit.entryIdB)
      if (res.success) {
        setEditHistory(rest)
        setValidationResult(null)
        setError(null)
        setNotice(`Undid last swap. Re-run validation before publishing.`)
        loadGenerationDetails(activeGenerationId)
      } else {
        setError(`Could not undo swap: ${res.error}`)
      }
    }
  }, [activeGenerationId, editHistory, loadGenerationDetails])

  useEffect(() => {
    if (!currentAcademicYear) return
    const gens = loadGenerations()
    if (gens && gens.length > 0 && !activeGenerationId) {
      setActiveGenerationId(gens[0].id)
      loadGenerationDetails(gens[0].id)
    }
  }, [currentAcademicYear, loadGenerations, loadGenerationDetails, activeGenerationId])

  /**
   * Run the real solver. Generation is a synchronous, bounded computation over
   * the local SQLite database (the renderer talks to it through synchronous
   * IPC), so the page briefly yields first to paint the "running" state, then
   * blocks while the search executes — there is no fake progress here.
   */
  const handleGenerate = async () => {
    if (!currentAcademicYear || generating) return
    setError(null)
    setNotice(null)
    setGenerating(true)
    await new Promise((resolve) => setTimeout(resolve, 30))
    try {
      const result = generateTimetable(currentAcademicYear.id)
      setLastResult(result)
      loadGenerations()
      setActiveGenerationId(result.generationId)
      loadGenerationDetails(result.generationId)
      if (result.status === 'COMPLETED') {
        setActiveTab('draft')
        setNotice(
          `Draft generated: ${result.statistics.scheduled}/${result.statistics.totalAllocations} weekly session(s) scheduled` +
            (result.statistics.labs && result.statistics.labs > 0
              ? ` including ${result.statistics.labs} lab session(s)`
              : '') +
            ` in ${result.search?.elapsedMs ?? 0} ms. Review the draft, run validation, then publish.`
        )
      } else {
        setActiveTab('diagnostics')
        setError(
          result.diagnosticsSummary ||
            'Generation failed — see the Diagnostics tab for the activities that could not be scheduled.'
        )
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Generation failed')
    } finally {
      setGenerating(false)
    }
  }

  const handleViewGeneration = (generation: TimetableGeneration) => {
    setError(null)
    setNotice(null)
    setActiveGenerationId(generation.id)
    setActiveTab('overview')
    loadGenerationDetails(generation.id)
  }

  const handleValidate = () => {
    if (!activeGenerationId) return
    setError(null)
    try {
      const result = validateDraftTimetable(activeGenerationId)
      setValidationResult(result)
      setActiveTab('validation')
      if (result.valid) {
        setNotice(`Validation passed: ${result.entries} draft session(s) satisfy every hard constraint.`)
      } else {
        setError(`Validation found ${result.errors.length} problem(s) — publishing is blocked until they are fixed.`)
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Validation failed')
    }
  }

  const handlePublish = async () => {
    if (!activeGenerationId) return
    setPublishDialogOpen(false)
    setPublishing(true)
    setError(null)
    setNotice(null)
    try {
      const result: PublishResult = publishDraftTimetable(activeGenerationId)
      const parts = [
        `Published ${result.publishedEntries} session(s) to the master timetable`,
        `${result.replacedEntries} prior entr(ies) replaced`,
        `${result.untouchedSections} unrelated section(s) kept`,
      ]
      if (result.substitutionRecordsRemapped > 0) {
        parts.push(`${result.substitutionRecordsRemapped} substitution record(s) moved to their replacement period`)
      }
      if (result.substitutionRecordsSuperseded > 0) {
        parts.push(`${result.substitutionRecordsSuperseded} substitution record(s) superseded (runs retained)`)
      }
      setNotice(`${parts.join('; ')}.`)
      loadGenerations()
      loadGenerationDetails(activeGenerationId)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Publishing failed — the previous timetable was left untouched.')
    } finally {
      setPublishing(false)
    }
  }

  const handleDeleteGeneration = () => {
    const generationId = deleteDialogId
    setDeleteDialogId(null)
    if (!generationId) return
    setError(null)
    setNotice(null)
    try {
      deleteGeneration(generationId)
      if (activeGenerationId === generationId) {
        setActiveGenerationId(null)
        setDraftEntries([])
        setDiagnostics([])
        setStatusInfo(null)
        setValidationResult(null)
        setLastResult(null)
        setActiveTab('overview')
      }
      const gens = loadGenerations()
      if (gens && gens.length > 0 && activeGenerationId === generationId) {
        setActiveGenerationId(gens[0].id)
        loadGenerationDetails(gens[0].id)
      }
      setNotice('Generation run deleted. The published timetable was not affected.')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not delete this generation.')
    }
  }

  // ---------------------------------------------------------------------------
  // Draft grid model: day → period → section (span-aware).
  // ---------------------------------------------------------------------------
  const orderedSlots = useMemo(() => timeSlotRepository.getOrdered(), [draftEntries, activeGenerationId])
  const workingDays = useMemo(() => {
    const configured = new Set<string>(settingsRepository.getWorkingDays())
    return ALL_DAYS.filter((day) => configured.has(day))
  }, [draftEntries, activeGenerationId])

  const draftSections = useMemo(() => {
    const byId = new Map<string, string>()
    for (const entry of draftEntries) {
      if (!byId.has(entry.sectionId)) byId.set(entry.sectionId, entry.section?.name ?? entry.sectionId)
    }
    return Array.from(byId, ([id, name]) => ({ id, name })).sort((a, b) => (a.name < b.name ? -1 : 1))
  }, [draftEntries])

  /** `${day}|${slotId}` → entries occupying that period (including continuations). */
  const gridCells = useMemo(() => {
    const cells = new Map<string, { entry: DraftTimetableEntryWithRelations; isStart: boolean }[]>()
    for (const entry of draftEntries) {
      const covered = resolveCoveredSlots(entry.timeSlotId, entry.span)
      if ('error' in covered) continue
      for (const slot of covered.slots) {
        const key = `${entry.dayOfWeek}|${slot.id}`
        const list = cells.get(key) ?? []
        list.push({ entry, isStart: slot.id === entry.timeSlotId })
        cells.set(key, list)
      }
    }
    return cells
  }, [draftEntries])

  const requiredSessions = useMemo(() => {
    if (!currentAcademicYear) return 0
    return subjectRequirementRepository
      .findByAcademicYear(currentAcademicYear.id)
      .reduce((sum, r) => sum + r.requiredSessionsPerWeek, 0)
  }, [currentAcademicYear, draftEntries])

  if (!currentAcademicYear) {
    return (
      <Card className="max-w-2xl mx-auto mt-8">
        <CardBody className="p-8 text-center">
          <span className="h-12 w-12 text-warning-500 mx-auto mb-4 inline-block">
            <AlertTriangle className="h-12 w-12 text-warning-500" />
          </span>
          <h2 className="text-xl font-bold text-secondary-900 mb-2">No Active Academic Year</h2>
          <p className="text-secondary-600 mb-4">Please set up an active academic year first.</p>
          {/* Router navigation, not window.location: the packaged app runs
              from file:// and a bare href would blank the window. */}
          <Link to="/settings">
            <Button variant="outline">Go to Settings</Button>
          </Link>
        </CardBody>
      </Card>
    )
  }

  const statusBadge = (status: GenerationStatus) => {
    switch (status) {
      case 'COMPLETED':
        return <Badge variant="success">COMPLETED</Badge>
      case 'FAILED':
        return <Badge variant="danger">FAILED</Badge>
      case 'RUNNING':
        return <Badge variant="info">RUNNING</Badge>
      case 'CANCELLED':
        return <Badge variant="neutral">CANCELLED</Badge>
      default:
        return <Badge variant="neutral">{status}</Badge>
    }
  }

  const canPublish =
    activeGeneration?.status === 'COMPLETED' &&
    !statusInfo?.published &&
    (validationResult === null || validationResult.valid)

  const renderDiagnosticsList = (list: GenerationDiagnostic[]) => (
    <div className="space-y-3">
      {list.map((diag) => {
        let details: Record<string, unknown> = {}
        try {
          details = diag.details ? JSON.parse(diag.details) : {}
        } catch {
          details = {}
        }
        const search = details.search as Record<string, number | string> | undefined
        return (
          <div
            key={diag.id}
            className={cn(
              'rounded-lg border p-3',
              diag.severity === 'ERROR'
                ? 'border-red-200 bg-red-50/60'
                : diag.severity === 'WARNING'
                  ? 'border-amber-200 bg-amber-50/60'
                  : 'border-secondary-200 bg-secondary-50'
            )}
          >
            <div className="flex items-start gap-2">
              {diag.severity === 'ERROR' ? (
                <XCircle className="h-4 w-4 text-red-600 mt-0.5 flex-shrink-0" />
              ) : diag.severity === 'WARNING' ? (
                <AlertTriangle className="h-4 w-4 text-amber-600 mt-0.5 flex-shrink-0" />
              ) : (
                <FileText className="h-4 w-4 text-secondary-500 mt-0.5 flex-shrink-0" />
              )}
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <Badge variant={diag.severity === 'ERROR' ? 'danger' : diag.severity === 'WARNING' ? 'warning' : 'neutral'}>
                    {diag.severity}
                  </Badge>
                  <span className="font-mono text-xs text-secondary-500">{diag.code}</span>
                </div>
                <p className="text-sm text-secondary-800 mt-1 whitespace-pre-wrap">{diag.message}</p>
                {typeof details.attemptedScope === 'string' && (
                  <p className="text-xs text-secondary-500 mt-1">Scope: {details.attemptedScope}</p>
                )}
                {typeof details.reason === 'string' && (
                  <p className="text-xs text-secondary-700 mt-1">
                    <span className="font-medium">Reason:</span> {details.reason}
                  </p>
                )}
                {typeof details.suggestedAction === 'string' && (
                  <p className="text-xs text-secondary-700 mt-1">
                    <span className="font-medium">Suggested action:</span> {details.suggestedAction}
                  </p>
                )}
                {search && (
                  <p className="text-xs text-secondary-500 mt-1 font-mono">
                    Search: {String(search.attempts)} attempt(s), deepest partial solution{' '}
                    {String(search.deepestPartialSolution)}, stop reason {String(search.stopReason ?? 'success')}
                  </p>
                )}
              </div>
            </div>
          </div>
        )
      })}
    </div>
  )

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-secondary-900">Timetable Generation</h1>
          <p className="text-secondary-600 mt-1">
            Academic Year: <span className="font-medium">{currentAcademicYear.name || '—'}</span>
          </p>
        </div>
        <div className="flex gap-2">
          <Button onClick={handleGenerate} disabled={generating}>
            {generating ? (
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
            ) : (
              <Zap className="h-4 w-4 mr-2" />
            )}
            {generating ? 'Running the solver…' : 'Generate Timetable'}
          </Button>
          {activeGeneration && (
            <Button
              variant="outline"
              onClick={handleValidate}
              disabled={generating || activeGeneration.status !== 'COMPLETED'}
            >
              <CheckCircle className="h-4 w-4 mr-2" />
              Validate Draft
            </Button>
          )}
        </div>
      </div>

      {/* Honest running state: the solver is a bounded synchronous computation. */}
      {generating && (
        <Card className="border-primary-200 bg-primary-50">
          <CardBody className="p-4 flex items-center gap-3">
            <Loader2 className="h-5 w-5 animate-spin text-primary-600" />
            <div className="text-sm text-secondary-700">
              <span className="font-medium">Running the constraint solver…</span>{solvedHint()}
            </div>
          </CardBody>
        </Card>
      )}

      {/* Error / success banners */}
      {error && (
        <div className="p-4 text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg flex items-start gap-3">
          <AlertCircle className="h-5 w-5 text-red-600 flex-shrink-0 mt-0.5" />
          <span className="flex-1 whitespace-pre-wrap">{error}</span>
          <Button variant="ghost" size="sm" onClick={() => setError(null)}>
            Dismiss
          </Button>
        </div>
      )}
      {notice && (
        <div className="p-4 text-sm text-green-700 bg-green-50 border border-green-200 rounded-lg flex items-start gap-3">
          <CheckCircle className="h-5 w-5 text-green-600 flex-shrink-0 mt-0.5" />
          <span className="flex-1 whitespace-pre-wrap">{notice}</span>
          <Button variant="ghost" size="sm" onClick={() => setNotice(null)}>
            Dismiss
          </Button>
        </div>
      )}

      {/* Generation history */}
      <Card>
        <div className="flex flex-row items-center justify-between p-4 border-b border-secondary-200">
          <h3 className="text-lg font-semibold text-secondary-900">Generation History</h3>
          <Button variant="ghost" size="sm" onClick={() => loadGenerations()} title="Refresh">
            <RefreshCw className="h-4 w-4" />
          </Button>
        </div>
        {generations.length === 0 ? (
          <div className="p-8 text-center text-secondary-500">
            <Zap className="h-12 w-12 text-secondary-300 mx-auto mb-4" />
            <p className="text-lg font-medium text-secondary-700 mb-2">No generations yet</p>
            <p className="text-secondary-500 mb-4">
              Define Subject Requirements and Teaching Allocations, then generate your first draft.
            </p>
            <Button onClick={handleGenerate} disabled={generating}>
              <Zap className="h-4 w-4 mr-2" />
              Generate First Timetable
            </Button>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow className="bg-secondary-50">
                  <TableHead className="w-1/4">Date</TableHead>
                  <TableHead className="w-1/5">Status</TableHead>
                  <TableHead className="w-1/5">Summary</TableHead>
                  <TableHead className="w-1/5">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {generations.map((gen, index) => (
                  <TableRow
                    key={gen.id}
                    className={cn(
                      index % 2 === 0 ? 'bg-white' : 'bg-secondary-50/50',
                      gen.id === activeGenerationId && 'ring-1 ring-primary-300'
                    )}
                  >
                    <TableCell className="font-mono text-sm">{parseDbTimestamp(gen.createdAt).toLocaleString()}</TableCell>
                    <TableCell>{statusBadge(gen.status)}</TableCell>
                    <TableCell className="text-sm text-secondary-600 max-w-xs truncate">
                      {gen.diagnosticsSummary || '—'}
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-wrap items-center gap-1.5">
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => handleViewGeneration(gen)}
                          title="View details"
                          aria-label="View details"
                        >
                          <Eye aria-hidden="true" className="h-4 w-4" />
                        </Button>
                        {gen.status === 'COMPLETED' && (
                          <Button
                            variant="ghost"
                            size="icon"
                            className="text-success-600 hover:text-success-700 hover:bg-success-50"
                            onClick={() => {
                              handleViewGeneration(gen)
                              setPublishDialogOpen(true)
                            }}
                            title="Publish to master timetable"
                            aria-label="Publish to master timetable"
                          >
                            <CheckCircle aria-hidden="true" className="h-4 w-4" />
                          </Button>
                        )}
                        <Button
                          variant="ghost"
                          size="icon"
                          className="text-danger-600 hover:text-danger-700 hover:bg-danger-50"
                          onClick={() => setDeleteDialogId(gen.id)}
                          title="Delete generation"
                          aria-label="Delete generation"
                        >
                          <Trash2 aria-hidden="true" className="h-4 w-4" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </Card>

      {/* Active generation detail */}
      {activeGeneration && (
        <Card>
          <div className="p-4 border-b border-secondary-200 flex items-center justify-between flex-wrap gap-2">
            <div className="flex items-center gap-3">
              <h3 className="text-lg font-semibold text-secondary-900">Run Details</h3>
              {statusBadge(activeGeneration.status)}
              {statusInfo?.published && <Badge variant="success">PUBLISHED</Badge>}
              {validationResult &&
                (validationResult.valid ? (
                  <Badge variant="success">Validation: passed</Badge>
                ) : (
                  <Badge variant="danger">Validation: {validationResult.errors.length} problem(s)</Badge>
                ))}
            </div>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={handleValidate} disabled={generating}>
                <CheckCircle className="h-4 w-4 mr-1" />
                Validate
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setPublishDialogOpen(true)}
                disabled={generating || publishing || !canPublish}
                title={
                  !canPublish
                    ? statusInfo?.published
                      ? 'This draft has already been published.'
                      : activeGeneration.status !== 'COMPLETED'
                        ? 'Only a successfully completed run can be published.'
                        : 'Fix the validation problems first.'
                    : 'Publish this draft as the master timetable'
                }
              >
                <Upload className="h-4 w-4 mr-1" />
                {statusInfo?.published ? 'Published' : 'Publish'}
              </Button>
              <Button variant="outline" size="sm" onClick={() => setDeleteDialogId(activeGeneration.id)}>
                <Trash2 className="h-4 w-4 mr-1" />
                Delete Run
              </Button>
            </div>
          </div>

          <CardBody className="p-0">
            <Tabs
              key={`${activeGeneration.id}:${activeTab}`}
              defaultValue={activeTab}
              onValueChange={(value) => setActiveTab(value as TabId)}
            >
              <div className="px-4 pt-4">
                <TabsList>
                  <TabsTrigger value="overview">Overview</TabsTrigger>
                  <TabsTrigger value="draft">Draft Grid</TabsTrigger>
                  <TabsTrigger value="diagnostics">
                    Diagnostics{diagnostics.length > 0 ? ` (${diagnostics.length})` : ''}
                  </TabsTrigger>
                  <TabsTrigger value="validation">Validation</TabsTrigger>
                </TabsList>
              </div>

              {/* ---------- Overview ---------- */}
              <TabsContent value="overview">
                <div className="p-4 space-y-4">
                  <p className="text-sm text-secondary-600 whitespace-pre-wrap">
                    {activeGeneration.diagnosticsSummary || 'No summary recorded for this run.'}
                  </p>
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                    <StatTile label="Required sessions/week" value={String(requiredSessions)} />
                    <StatTile label="Scheduled in draft" value={String(draftEntries.length)} />
                    <StatTile
                      label="Lab sessions"
                      value={String(draftEntries.filter((e) => e.classType === 'LAB').length)}
                    />
                    <StatTile
                      label="Diagnostics"
                      value={`${statusInfo?.diagnostics.errors ?? 0} err / ${statusInfo?.diagnostics.warnings ?? 0} warn`}
                      tone={
                        (statusInfo?.diagnostics.errors ?? 0) > 0
                          ? 'danger'
                          : (statusInfo?.diagnostics.warnings ?? 0) > 0
                            ? 'warning'
                            : 'success'
                      }
                    />
                  </div>
                  {lastResult && lastResult.generationId === activeGeneration.id && lastResult.search && (
                    <div className="text-xs font-mono text-secondary-500 bg-secondary-50 rounded p-2">
                      Search: {lastResult.search.attempts} attempt(s) in {lastResult.search.elapsedMs} ms
                      {lastResult.search.stopReason ? ` — stopped: ${lastResult.search.stopReason}` : ' — completed'}
                      {' · '}limits: {lastResult.search.limitAttempts} attempts / {lastResult.search.limitTimeoutMs} ms
                    </div>
                  )}
                  <div className="text-xs text-secondary-500">
                    Created {parseDbTimestamp(activeGeneration.createdAt).toLocaleString()}
                    {activeGeneration.completedAt ? ` · Completed ${parseDbTimestamp(activeGeneration.completedAt).toLocaleString()}` : ''}
                  </div>
                  <div className="flex items-center gap-2 text-sm">
                    <Button variant="outline" size="sm" onClick={() => setActiveTab('draft')} disabled={draftEntries.length === 0}>
                      <Eye className="h-4 w-4 mr-1" />
                      Review Draft
                    </Button>
                    <Button variant="outline" size="sm" onClick={handleValidate}>
                      <CheckCircle className="h-4 w-4 mr-1" />
                      Run Validation
                    </Button>
                  </div>
                </div>
              </TabsContent>

              {/* ---------- Draft grid: day → period → section ---------- */}
              <TabsContent value="draft">
                <div className="p-4">
                  {draftEntries.length === 0 ? (
                    <div className="p-8 text-center text-secondary-500">
                      <Eye className="h-10 w-10 text-secondary-300 mx-auto mb-3" />
                      <p className="font-medium text-secondary-700">This run produced no draft sessions.</p>
                      <p className="text-sm mt-1">
                        {activeGeneration.status === 'FAILED'
                          ? 'Check the Diagnostics tab to see why activities could not be scheduled.'
                          : 'Run the generator to create a draft.'}
                      </p>
                    </div>
                  ) : (
                    <DraftGrid
                      days={workingDays}
                      slots={orderedSlots}
                      sections={draftSections}
                      cells={gridCells}
                      renderEntry={renderDraftEntry}
                      entryCount={draftEntries.length}
                      isEditable={isEditable}
                      onMove={handleMove}
                      onSwap={handleSwap}
                      onUndo={handleUndo}
                      canUndo={editHistory.length > 0}
                      onOpenMoveDialog={(entry) => {
                        setMoveTargetEntry(entry)
                        setSelectedMoveDay(entry.dayOfWeek)
                        setSelectedMoveSlotId(entry.timeSlotId)
                        setSelectedSwapEntryId('')
                        setMoveMode('move')
                        setMoveError(null)
                        setMoveDialogOpen(true)
                      }}
                    />
                  )}
                </div>
              </TabsContent>

              {/* ---------- Diagnostics ---------- */}
              <TabsContent value="diagnostics">
                <div className="p-4">
                  {diagnostics.length === 0 ? (
                    <div className="p-8 text-center text-secondary-500">
                      <CheckCircle className="h-10 w-10 text-green-400 mx-auto mb-3" />
                      <p className="font-medium text-secondary-700">No diagnostics — nothing went wrong.</p>
                    </div>
                  ) : (
                    <div className="space-y-4">
                      <div className="flex gap-2 flex-wrap">
                        <Badge variant="danger">{diagnostics.filter((d) => d.severity === 'ERROR').length} error(s)</Badge>
                        <Badge variant="warning">
                          {diagnostics.filter((d) => d.severity === 'WARNING').length} warning(s)
                        </Badge>
                        <Badge variant="neutral">{diagnostics.filter((d) => d.severity === 'INFO').length} info</Badge>
                      </div>
                      {renderDiagnosticsList(diagnostics)}
                    </div>
                  )}
                </div>
              </TabsContent>

              {/* ---------- Validation ---------- */}
              <TabsContent value="validation">
                <div className="p-4 space-y-4">
                  <div className="flex items-center justify-between flex-wrap gap-2">
                    <div className="flex items-center gap-2">
                      {validationResult === null ? (
                        <Badge variant="neutral">Not yet validated</Badge>
                      ) : validationResult.valid ? (
                        <Badge variant="success">Valid — ready to publish</Badge>
                      ) : (
                        <Badge variant="danger">Invalid — publishing blocked</Badge>
                      )}
                      {validationResult && (
                        <span className="text-sm text-secondary-500">
                          {validationResult.entries} entr(ies) checked against {validationResult.requiredSessions}{' '}
                          required session(s)
                        </span>
                      )}
                    </div>
                    <Button variant="outline" size="sm" onClick={handleValidate}>
                      <RefreshCw className="h-4 w-4 mr-1" />
                      Re-run validation
                    </Button>
                  </div>

                  {validationResult && (
                    <>
                      {validationResult.errors.length > 0 && (
                        <div>
                          <h4 className="text-sm font-semibold text-red-700 mb-2 flex items-center gap-1">
                            <XCircle className="h-4 w-4" /> Errors (block publishing)
                          </h4>
                          <ul className="list-disc pl-5 space-y-1 text-sm text-red-700">
                            {validationResult.errors.map((message, i) => (
                              <li key={i}>{message}</li>
                            ))}
                          </ul>
                        </div>
                      )}
                      {validationResult.warnings.length > 0 && (
                        <div>
                          <h4 className="text-sm font-semibold text-amber-700 mb-2 flex items-center gap-1">
                            <AlertTriangle className="h-4 w-4" /> Warnings
                          </h4>
                          <ul className="list-disc pl-5 space-y-1 text-sm text-amber-700">
                            {validationResult.warnings.map((message, i) => (
                              <li key={i}>{message}</li>
                            ))}
                          </ul>
                        </div>
                      )}
                      {validationResult.missing.length > 0 && (
                        <div>
                          <h4 className="text-sm font-semibold text-secondary-700 mb-2">Sessions off-target</h4>
                          <Table>
                            <TableHeader>
                              <TableRow>
                                <TableHead>Section</TableHead>
                                <TableHead>Subject</TableHead>
                                <TableHead>Required</TableHead>
                                <TableHead>Scheduled</TableHead>
                              </TableRow>
                            </TableHeader>
                            <TableBody>
                              {validationResult.missing.map((row, i) => (
                                <TableRow key={i}>
                                  <TableCell>{row.sectionName}</TableCell>
                                  <TableCell>
                                    {row.subjectName} ({row.classType})
                                  </TableCell>
                                  <TableCell>{row.required}</TableCell>
                                  <TableCell>{row.scheduled}</TableCell>
                                </TableRow>
                              ))}
                            </TableBody>
                          </Table>
                        </div>
                      )}
                      {validationResult.valid && (
                        <div className="p-3 rounded-lg bg-green-50 border border-green-200 text-sm text-green-800 flex items-start gap-2">
                          <CheckCircle className="h-4 w-4 mt-0.5 flex-shrink-0" />
                          <span>
                            Every hard constraint holds: exact weekly counts, no section/faculty/room double-booking
                            (span-aware), no session across the break, only working days and hours, every faculty member
                            allocated. {validationResult.labsScheduled} lab session(s) checked.
                          </span>
                        </div>
                      )}
                    </>
                  )}
                </div>
              </TabsContent>
            </Tabs>
          </CardBody>
        </Card>
      )}

      {/* Publish confirmation */}
      <Dialog
        open={publishDialogOpen}
        onOpenChange={setPublishDialogOpen}
        title="Publish this draft as the master timetable?"
        description="The draft replaces the current entries of the sections it covers. Entries of other sections, substitution history and audit records are preserved. The timetable is re-validated inside the publish transaction — if anything fails, nothing changes."
      >
        <DialogFooter>
          <Button variant="outline" onClick={() => setPublishDialogOpen(false)}>
            Cancel
          </Button>
          <Button onClick={handlePublish} disabled={publishing || !canPublish}>
            {publishing ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Upload className="h-4 w-4 mr-2" />}
            Publish
          </Button>
        </DialogFooter>
      </Dialog>

      {/* Delete confirmation */}
      <Dialog
        open={deleteDialogId !== null}
        onOpenChange={(open) => !open && setDeleteDialogId(null)}
        title="Delete this generation run?"
        description="The run, its draft entries and diagnostics are removed. The published master timetable is never affected."
      >
        <DialogFooter>
          <Button variant="outline" onClick={() => setDeleteDialogId(null)}>
            Cancel
          </Button>
          <Button variant="danger" onClick={handleDeleteGeneration}>
            <Trash2 className="h-4 w-4 mr-2" />
            Delete Run
          </Button>
        </DialogFooter>
      </Dialog>

      {/* Move / Swap Session Accessible Dialog */}
      <Dialog
        open={moveDialogOpen}
        onOpenChange={(open) => {
          setMoveDialogOpen(open)
          if (!open) setMoveError(null)
        }}
        title="Move or Swap Draft Session"
        description={
          moveTargetEntry
            ? `${moveTargetEntry.subject?.name} (${classTypeLabel(moveTargetEntry.classType)}) · ${moveTargetEntry.section?.name}`
            : undefined
        }
      >
        {moveTargetEntry && (
          <div className="space-y-4 p-6">
            <div className="p-3 bg-secondary-50 border border-secondary-200 rounded-lg text-xs text-secondary-600">
              Current position: <strong className="text-secondary-900">{moveTargetEntry.dayOfWeek}</strong> at{' '}
              <strong className="text-secondary-900">{moveTargetEntry.timeSlot?.name}</strong>{' '}
              ({moveTargetEntry.span} period{moveTargetEntry.span > 1 ? 's' : ''})
              {moveTargetEntry.span > 1 && (
                <div className="text-primary-700 mt-1 font-medium">
                  Note: Multi-period lab moves as one indivisible block across all {moveTargetEntry.span} periods.
                </div>
              )}
            </div>

            {moveError && (
              <div className="p-3 text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg">
                {moveError}
              </div>
            )}

            <div className="flex gap-2 border-b border-secondary-200 pb-2">
              <button
                type="button"
                onClick={() => {
                  setMoveMode('move')
                  setMoveError(null)
                }}
                className={cn(
                  'px-3 py-1.5 text-xs font-medium rounded-md transition-colors',
                  moveMode === 'move' ? 'bg-primary-600 text-white' : 'bg-secondary-100 text-secondary-700 hover:bg-secondary-200'
                )}
              >
                Move to New Period
              </button>
              <button
                type="button"
                onClick={() => {
                  setMoveMode('swap')
                  setMoveError(null)
                }}
                className={cn(
                  'px-3 py-1.5 text-xs font-medium rounded-md transition-colors',
                  moveMode === 'swap' ? 'bg-primary-600 text-white' : 'bg-secondary-100 text-secondary-700 hover:bg-secondary-200'
                )}
              >
                Swap with Another Class
              </button>
            </div>

            {moveMode === 'move' ? (
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-medium text-secondary-700 mb-1">Target Day</label>
                  <select
                    value={selectedMoveDay}
                    onChange={(e) => setSelectedMoveDay(e.target.value as DayOfWeek)}
                    className="w-full rounded-md border border-secondary-300 px-3 py-1.5 text-sm bg-white"
                  >
                    {workingDays.map((d) => (
                      <option key={d} value={d}>
                        {d.charAt(0) + d.slice(1).toLowerCase()}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium text-secondary-700 mb-1">Target Period</label>
                  <select
                    value={selectedMoveSlotId}
                    onChange={(e) => setSelectedMoveSlotId(e.target.value)}
                    className="w-full rounded-md border border-secondary-300 px-3 py-1.5 text-sm bg-white"
                  >
                    {orderedSlots
                      .filter((s) => !s.isBreak)
                      .map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.name} ({s.startTime}–{s.endTime})
                        </option>
                      ))}
                  </select>
                </div>
              </div>
            ) : (
              <div>
                <label className="block text-xs font-medium text-secondary-700 mb-1">
                  Select Another Session to Swap With
                </label>
                <select
                  value={selectedSwapEntryId}
                  onChange={(e) => setSelectedSwapEntryId(e.target.value)}
                  className="w-full rounded-md border border-secondary-300 px-3 py-1.5 text-sm bg-white"
                >
                  <option value="">Select a session...</option>
                  {draftEntries
                    .filter((e) => e.id !== moveTargetEntry.id)
                    .map((e) => (
                      <option key={e.id} value={e.id}>
                        {e.dayOfWeek} {e.timeSlot?.name}: {e.subject?.name} ({e.section?.name})
                      </option>
                    ))}
                </select>
              </div>
            )}

            <DialogFooter>
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setMoveDialogOpen(false)
                  setMoveError(null)
                }}
              >
                Cancel
              </Button>
              <Button
                size="sm"
                onClick={() => {
                  if (moveMode === 'move') {
                    const slotToUse = selectedMoveSlotId || orderedSlots.find((s) => !s.isBreak)?.id || ''
                    const res = moveDraftEntry(activeGenerationId!, moveTargetEntry.id, selectedMoveDay, slotToUse)
                    if (!res.success) {
                      setMoveError(res.error || 'Move could not be performed.')
                    } else {
                      setMoveDialogOpen(false)
                      setMoveError(null)
                      handleMove(moveTargetEntry.id, selectedMoveDay, slotToUse)
                    }
                  } else {
                    if (!selectedSwapEntryId) {
                      setMoveError('Please select a session to swap with.')
                      return
                    }
                    const res = swapDraftEntries(activeGenerationId!, moveTargetEntry.id, selectedSwapEntryId)
                    if (!res.success) {
                      setMoveError(res.error || 'Swap could not be performed.')
                    } else {
                      setMoveDialogOpen(false)
                      setMoveError(null)
                      handleSwap(moveTargetEntry.id, selectedSwapEntryId)
                    }
                  }
                }}
              >
                {moveMode === 'move' ? 'Apply Move' : 'Apply Swap'}
              </Button>
            </DialogFooter>
          </div>
        )}
      </Dialog>
    </div>
  )
}

/** Small honest note shown while the synchronous solver runs. */
function solvedHint() {
  return (
    <span className="text-secondary-500">
      {' '}
      Bounded backtracking search over your Teaching Allocations and Subject Requirements — the page resumes as soon as
      it finishes or the attempt/time limit is reached.
    </span>
  )
}

function StatTile({
  label,
  value,
  tone = 'neutral',
}: {
  label: string
  value: string
  tone?: 'neutral' | 'success' | 'warning' | 'danger'
}) {
  return (
    <div
      className={cn(
        'rounded-lg border p-3',
        tone === 'danger'
          ? 'border-red-200 bg-red-50'
          : tone === 'warning'
            ? 'border-amber-200 bg-amber-50'
            : tone === 'success'
              ? 'border-green-200 bg-green-50'
              : 'border-secondary-200 bg-secondary-50'
      )}
    >
      <div className="text-xs text-secondary-500">{label}</div>
      <div className="text-lg font-semibold text-secondary-900 mt-0.5">{value}</div>
    </div>
  )
}

/**
 * One draft-grid card (or the continuation mark of a multi-period activity).
 * Module-level so the exact rendering contract — one clear room state, a
 * continuation for covered periods — is directly testable.
 */
export function renderDraftEntry(
  slotId: string,
  item: { entry: DraftTimetableEntryWithRelations; isStart: boolean },
  options?: {
    isDraggable?: boolean
    onMoveClick?: (entry: DraftTimetableEntryWithRelations) => void
    onDragStart?: (entry: DraftTimetableEntryWithRelations) => void
    onDragEnd?: () => void
  }
): ReactNode {
  const { entry, isStart } = item
  if (!isStart) {
    // Continuation period of a multi-period activity (e.g. a lab).
    return (
      <div
        key={`${entry.id}-cont-${slotId}`}
        className="text-xs text-secondary-500 border-l-2 border-primary-300 pl-1 py-0.5"
      >
        ↳ {entry.subject?.name ?? entry.subjectId} continues
      </div>
    )
  }
  const facultyNames = (entry.facultyList ?? []).map((f) => f.name)
  const roomNames = (entry.roomList ?? []).map((r) => r.name)
  const isDraggable = Boolean(options?.isDraggable)

  return (
    <div
      key={entry.id}
      draggable={isDraggable}
      onDragStart={(e) => {
        if (!isDraggable) return
        e.dataTransfer.setData('text/plain', entry.id)
        e.dataTransfer.effectAllowed = 'move'
        options?.onDragStart?.(entry)
      }}
      onDragEnd={() => options?.onDragEnd?.()}
      className={cn(
        'group rounded-md border p-1.5 text-xs bg-white shadow-sm transition-all',
        entry.classType === 'LAB' ? 'border-purple-300 bg-purple-50/40' : 'border-secondary-200',
        isDraggable && 'cursor-grab active:cursor-grabbing hover:shadow hover:border-primary-400'
      )}
    >
      <div className="flex items-start justify-between gap-1">
        <span className="font-medium text-secondary-900 leading-tight flex items-center gap-1">
          {isDraggable && (
            <GripVertical className="h-3 w-3 text-secondary-400 group-hover:text-secondary-600 flex-shrink-0" />
          )}
          <span>
            {entry.subject?.name ?? entry.subjectId}
            {entry.subject?.code ? <span className="text-secondary-400 ml-1">{entry.subject.code}</span> : null}
          </span>
        </span>
        <div className="flex items-center gap-1">
          <span
            className={cn(
              'text-[10px] uppercase tracking-wide px-1 rounded',
              entry.classType === 'LAB' ? 'bg-purple-100 text-purple-700' : 'bg-secondary-100 text-secondary-600'
            )}
          >
            {classTypeLabel(entry.classType)}
          </span>
          {isDraggable && options?.onMoveClick && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation()
                options.onMoveClick?.(entry)
              }}
              title="Move or swap this session"
              aria-label="Move or swap this session"
              className="p-0.5 text-secondary-400 hover:text-primary-700 hover:bg-secondary-100 rounded transition-colors"
            >
              <ArrowLeftRight className="h-3 w-3" />
            </button>
          )}
        </div>
      </div>
      <div className="text-secondary-700 mt-1">
        {facultyNames.length > 0 ? facultyNames.join(', ') : <span className="text-secondary-400">No faculty</span>}
        {facultyNames.length > 1 && (
          <Badge variant="info" className="ml-1 text-[10px] px-1.5 py-0">
            Team
          </Badge>
        )}
      </div>
      <div className="text-secondary-500 flex items-center gap-2 mt-0.5">
        {/* Lectures are room-independent in this application: an empty room
            is a legitimate state, not a broken lookup — say so plainly
            instead of the misleading "Room —". A LAB without a room cannot
            pass validation, so that case is flagged as an error. */}
        <span
          className={cn(
            roomNames.length === 0 && entry.classType === 'LAB' && 'text-red-600 font-medium'
          )}
        >
          {roomNames.length > 0
            ? roomNames.join(', ')
            : entry.classType === 'LAB'
              ? 'No room assigned'
              : 'No room'}
        </span>
        <span className="text-secondary-400">
          {entry.span} period{entry.span > 1 ? 's' : ''}
        </span>
      </div>
    </div>
  )
}

/**
 * One horizontal scroll container holds the header AND every day's rows, so
 * all configured section columns stay aligned with their headers and remain
 * reachable (scrolled) on any viewport instead of being clipped.
 */
export function DraftGrid({
  days,
  slots,
  sections,
  cells,
  renderEntry,
  entryCount,
  isEditable = false,
  onMove,
  onSwap,
  onUndo,
  canUndo = false,
  onOpenMoveDialog,
}: {
  days: DayOfWeek[]
  slots: ReturnType<typeof timeSlotRepository.getOrdered>
  sections: { id: string; name: string }[]
  cells: Map<string, { entry: DraftTimetableEntryWithRelations; isStart: boolean }[]>
  renderEntry: (
    slotId: string,
    item: { entry: DraftTimetableEntryWithRelations; isStart: boolean },
    options?: any
  ) => ReactNode
  entryCount: number
  isEditable?: boolean
  onMove?: (entryId: string, day: DayOfWeek, slotId: string) => void
  onSwap?: (entryIdA: string, entryIdB: string) => void
  onUndo?: () => void
  canUndo?: boolean
  onOpenMoveDialog?: (entry: DraftTimetableEntryWithRelations) => void
}) {
  const [draggedEntry, setDraggedEntry] = useState<DraftTimetableEntryWithRelations | null>(null)
  const [dragOverKey, setDragOverKey] = useState<string | null>(null)

  const handleDropCell = (day: DayOfWeek, slotId: string, sectionId: string, targetEntryId?: string) => {
    if (!draggedEntry) return
    if (targetEntryId && targetEntryId !== draggedEntry.id) {
      onSwap?.(draggedEntry.id, targetEntryId)
    } else {
      onMove?.(draggedEntry.id, day, slotId)
    }
  }

  const customRender = (
    slotId: string,
    item: { entry: DraftTimetableEntryWithRelations; isStart: boolean }
  ) => {
    return renderEntry(slotId, item, {
      isDraggable: isEditable,
      onDragStart: (entry: DraftTimetableEntryWithRelations) => setDraggedEntry(entry),
      onDragEnd: () => {
        setDraggedEntry(null)
        setDragOverKey(null)
      },
      onMoveClick: (entry: DraftTimetableEntryWithRelations) => onOpenMoveDialog?.(entry),
    })
  }

  return (
    <div className="space-y-2">
      {isEditable && (
        <div className="flex flex-wrap items-center justify-between gap-2 p-2.5 bg-secondary-50 border border-secondary-200 rounded-lg text-xs">
          <div className="flex items-center gap-2 text-secondary-700">
            <span className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-primary-100 text-primary-700 font-bold text-[10px]">
              i
            </span>
            <span>
              <strong>Draft Grid Editing:</strong> Drag sessions to empty periods or drop onto another session to swap. Multi-period labs move as complete blocks. Edits automatically clear previous validation.
            </span>
          </div>
          {canUndo && onUndo && (
            <Button variant="outline" size="sm" onClick={onUndo} className="h-7 text-xs">
              <Undo2 className="h-3.5 w-3.5 mr-1" />
              Undo Last Edit
            </Button>
          )}
        </div>
      )}

      <div className="overflow-x-auto" data-testid="draft-grid-scroll">
        <table className="min-w-full border-collapse text-sm">
          <thead>
            <tr className="bg-secondary-50">
              <th className="border border-secondary-200 p-2 text-left text-xs font-semibold text-secondary-600 sticky left-0 bg-secondary-50">
                Period
              </th>
              {sections.map((section) => (
                <th
                  key={section.id}
                  className="border border-secondary-200 p-2 text-left text-xs font-semibold text-secondary-700"
                >
                  {section.name}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {days.map((day) => (
              <DayRows
                key={day}
                day={day}
                slots={slots}
                sections={sections}
                cells={cells}
                renderEntry={customRender}
                isEditable={isEditable}
                onDropCell={handleDropCell}
                dragOverKey={dragOverKey}
                setDragOverKey={setDragOverKey}
              />
            ))}
          </tbody>
        </table>
        <p className="text-xs text-secondary-500 mt-2">
          {entryCount} draft session(s). Multi-period activities (e.g. labs) are shown as one card
          with continuation marks — they are never split across the break.
        </p>
      </div>
    </div>
  )
}

/**
 * True when a period's name already contains its own time range (the default
 * periods are named "09:00-10:00"), so rendering `startTime–endTime` beneath
 * it would print the same time label twice in one cell.
 */
function periodNameIncludesTime(slot: {
  name: string
  startTime: string
  endTime: string
}): boolean {
  const norm = (s: string) =>
    s
      .toLowerCase()
      .replace(/\s+/g, '')
      .replace(/[–—]/g, '-')
  return norm(slot.name).includes(`${norm(slot.startTime)}-${norm(slot.endTime)}`)
}

/** One working day's rows: period column + a cell per section. */
export function DayRows({
  day,
  slots,
  sections,
  cells,
  renderEntry,
  isEditable = false,
  onDropCell,
  dragOverKey,
  setDragOverKey,
}: {
  day: DayOfWeek
  slots: ReturnType<typeof timeSlotRepository.getOrdered>
  sections: { id: string; name: string }[]
  cells: Map<string, { entry: DraftTimetableEntryWithRelations; isStart: boolean }[]>
  renderEntry: (slotId: string, item: { entry: DraftTimetableEntryWithRelations; isStart: boolean }) => ReactNode
  isEditable?: boolean
  onDropCell?: (day: DayOfWeek, slotId: string, sectionId: string, targetEntryId?: string) => void
  dragOverKey?: string | null
  setDragOverKey?: (key: string | null) => void
}) {
  const dayHasEntries = slots.some((slot) => cells.get(`${day}|${slot.id}`)?.length)
  return (
    <>
      <tr className="bg-secondary-100/70">
        <td colSpan={sections.length + 1} className="border border-secondary-200 p-1.5 text-xs font-bold text-secondary-700">
          {day.charAt(0) + day.slice(1).toLowerCase()}
          {!dayHasEntries && <span className="font-normal text-secondary-400 ml-2">— no sessions scheduled</span>}
        </td>
      </tr>
      {slots.map((slot) => (
        <tr key={`${day}-${slot.id}`} className={slot.isBreak ? 'bg-amber-50' : undefined}>
          <td className="border border-secondary-200 p-2 text-xs text-secondary-600 whitespace-nowrap sticky left-0 bg-white">
            <div className="font-medium">{slot.name}</div>
            {/* Only when the name does not already carry the range — the
                default periods are named "09:00-10:00", which used to make
                this cell print the same label twice. */}
            {!periodNameIncludesTime(slot) && (
              <div className="text-secondary-400">
                {slot.startTime}–{slot.endTime}
              </div>
            )}
          </td>
          {slot.isBreak ? (
            <td colSpan={sections.length} className="border border-secondary-200 p-2 text-xs text-amber-700 italic">
              Break — sessions are never scheduled across this period
            </td>
          ) : (
            sections.map((section) => {
              const cellKey = `${day}|${slot.id}|${section.id}`
              const isOver = dragOverKey === cellKey
              const items = cells.get(`${day}|${slot.id}`)?.filter((item) => item.entry.sectionId === section.id) ?? []
              return (
                <td
                  key={section.id}
                  onDragOver={(e) => {
                    if (isEditable) {
                      e.preventDefault()
                      e.dataTransfer.dropEffect = 'move'
                      setDragOverKey?.(cellKey)
                    }
                  }}
                  onDragLeave={() => {
                    if (isEditable && dragOverKey === cellKey) {
                      setDragOverKey?.(null)
                    }
                  }}
                  onDrop={(e) => {
                    if (isEditable) {
                      e.preventDefault()
                      const targetEntryId = items[0]?.entry.id
                      onDropCell?.(day, slot.id, section.id, targetEntryId)
                      setDragOverKey?.(null)
                    }
                  }}
                  className={cn(
                    'border border-secondary-200 p-1.5 align-top min-w-[11rem] transition-colors',
                    isOver && 'bg-primary-50 ring-2 ring-primary-500 ring-inset'
                  )}
                >
                  {items.length === 0 ? (
                    <span className="text-secondary-300 text-xs">—</span>
                  ) : (
                    <div className="space-y-1">{items.map((item) => renderEntry(slot.id, item))}</div>
                  )}
                </td>
              )
            })
          )}
        </tr>
      ))}
    </>
  )
}
