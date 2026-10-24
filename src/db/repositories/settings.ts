import { BaseRepository } from './base'
import { withTransaction } from '../transaction'
import { ApplicationSettings, DAYS_OF_WEEK, DayOfWeek, MultiFacultyAbsencePolicy } from '@/types'

export class SettingsRepository extends BaseRepository<ApplicationSettings> {
  protected tableName = 'application_settings'

  protected entityFromRow(row: any): ApplicationSettings {
    return {
      id: row.id,
      key: row.key,
      value: row.value,
      description: row.description,
      updatedAt: row.updated_at,
    }
  }

  get(key: string, defaultValue?: string): string | undefined {
    const row = this.db().prepare('SELECT value FROM application_settings WHERE key = ?').get(key) as { value: string } | undefined
    return row?.value ?? defaultValue
  }

  set(key: string, value: string, description?: string): ApplicationSettings {
    const existing = this.db()
      .prepare('SELECT id, description FROM application_settings WHERE key = ?')
      .get(key) as { id: string | null; description: string | null } | undefined
    if (existing) {
      // A v2 migration inserted one settings row without an id (SQLite permits
      // NULL in a TEXT PRIMARY KEY). BaseRepository.update targets `WHERE id = ?`,
      // which never matches NULL — the UPDATE affected 0 rows and the save
      // silently vanished while the UI still showed "Saved!". Stamp a real id
      // first so the update lands, then proceed normally.
      if (existing.id === null || existing.id === undefined) {
        const repairedId = crypto.randomUUID()
        this.db()
          .prepare('UPDATE application_settings SET id = ? WHERE key = ? AND id IS NULL')
          .run(repairedId, key)
        return this.update(repairedId, {
          value,
          description: description !== undefined ? description : existing.description ?? undefined,
        })!
      }
      // A plain set(key, value) must not wipe the row's description
      // (the base update writes undefined/omitted columns as NULL).
      return this.update(existing.id, {
        value,
        description: description !== undefined ? description : existing.description ?? undefined,
      })!
    }
    return this.create({
      id: crypto.randomUUID(),
      key,
      value,
      description,
    })
  }

  getAll(): Record<string, string> {
    const rows = this.db().prepare('SELECT key, value FROM application_settings').all() as { key: string; value: string }[]
    return rows.reduce((acc: Record<string, string>, row) => {
      acc[row.key] = row.value
      return acc
    }, {})
  }

  getWorkingHours(): { startTime: string; endTime: string; breakStart: string; breakEnd: string } {
    return {
      startTime: this.get('working_hours_start') || '09:00',
      endTime: this.get('working_hours_end') || '16:00',
      breakStart: this.get('break_start') || '13:00',
      breakEnd: this.get('break_end') || '14:00',
    }
  }

  setWorkingHours(config: { startTime: string; endTime: string; breakStart: string; breakEnd: string }): void {
    // One transaction: four independent writes must land together, never as
    // a half-updated working-hours configuration.
    withTransaction(() => {
      this.set('working_hours_start', config.startTime, 'Working hours start time')
      this.set('working_hours_end', config.endTime, 'Working hours end time')
      this.set('break_start', config.breakStart, 'Break start time')
      this.set('break_end', config.breakEnd, 'Break end time')
    })
  }

  /**
   * Working days are stored as a comma-separated list of day values in
   * `application_settings`, so no schema/migration is needed. Defaults to
   * every day in DAYS_OF_WEEK when unset or invalid.
   */
  getWorkingDays(): DayOfWeek[] {
    const raw = this.get('working_days')
    if (!raw) return DAYS_OF_WEEK.map(d => d.value)
    const valid = raw
      .split(',')
      .map(v => v.trim().toUpperCase())
      .filter((v): v is DayOfWeek =>
        Boolean(v) && DAYS_OF_WEEK.some(d => d.value === v)
      )
    return valid.length > 0 ? valid : DAYS_OF_WEEK.map(d => d.value)
  }

  setWorkingDays(days: DayOfWeek[]): void {
    if (days.length === 0) throw new Error('At least one working day is required.')
    const deduped = DAYS_OF_WEEK.filter(d => days.includes(d.value)).map(d => d.value)
    this.set('working_days', deduped.join(','), 'Configured working days')
  }

  /**
   * Whether the substitution engine may consider "unrelated" faculty (P5):
   * candidates with no class, semester, department or subject relationship to
   * the affected class. Defaults to true (permitted) when unset, preserving
   * historical behaviour; turn it off to restrict substitution to related
   * candidates only.
   */
  getAllowUnrelatedSubstitutions(): boolean {
    return this.get('allow_unrelated_substitutions') !== 'false'
  }

  setAllowUnrelatedSubstitutions(value: boolean): void {
    this.set(
      'allow_unrelated_substitutions',
      value ? 'true' : 'false',
      'Allow substitutions to faculty unrelated to the affected class (P5)'
    )
  }

  getMaxDailySubstitutions(): number {
    return parseInt(this.get('max_daily_substitutions') || '2', 10)
  }

  setMaxDailySubstitutions(value: number): void {
    this.set('max_daily_substitutions', value.toString(), 'Maximum daily substitutions per faculty')
  }

  /**
   * What happens when SOME (but not all) faculty of a multi-faculty activity
   * are absent:
   *  - TEAM_SUFFICIENT (default): the remaining team continues — no
   *    substitution is generated for the activity.
   *  - REPLACE_ABSENT: a substitution is generated for the absent member(s).
   * An entry where ALL faculty are absent is always affected, regardless.
   */
  getMultiFacultyAbsencePolicy(): MultiFacultyAbsencePolicy {
    const raw = this.get('multi_faculty_absence_policy')
    return raw === 'REPLACE_ABSENT' ? 'REPLACE_ABSENT' : 'TEAM_SUFFICIENT'
  }

  setMultiFacultyAbsencePolicy(policy: MultiFacultyAbsencePolicy): void {
    this.set(
      'multi_faculty_absence_policy',
      policy,
      'Multi-faculty absence policy: TEAM_SUFFICIENT or REPLACE_ABSENT'
    )
  }

  getSubstitutionWeights(): Record<string, number> {
    const defaults: Record<string, number> = {
      sameClass: 100,
      sameSemester: 60,
      sameDepartment: 40,
      subjectQualified: 30,
      teachesSameSubject: 20,
      freeDuringSlot: 20,
      lowSubCount: 15,
      taughtSectionBefore: 10,
      penaltyHighSubCount: -30,
      penaltyConsecutive: -20,
      penaltyCrossDepartment: -50,
    }
    const saved = this.get('substitution_weights')
    if (saved) {
      try {
        return { ...defaults, ...JSON.parse(saved) }
      } catch {
        return defaults
      }
    }
    return defaults
  }

  setSubstitutionWeights(weights: Record<string, number>): void {
    this.set('substitution_weights', JSON.stringify(weights), 'Substitution algorithm weights')
  }

  getInstitutionName(): string {
    return this.get('institution_name') || 'College'
  }

  setInstitutionName(name: string): void {
    this.set('institution_name', name, 'Institution name')
  }

  getInstitutionAddress(): string {
    return this.get('institution_address') || ''
  }

  setInstitutionAddress(address: string): void {
    this.set('institution_address', address, 'Institution address')
  }

  /**
   * Generation search bound — maximum number of placement attempts the
   * timetable solver may make before giving up (seeded by migration 4).
   */
  getMaxGenerationAttempts(): number {
    const parsed = parseInt(this.get('max_generation_attempts') || '1000', 10)
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 1000
  }

  setMaxGenerationAttempts(value: number): void {
    if (!Number.isInteger(value) || value < 1) {
      throw new Error('Maximum generation attempts must be a positive whole number.')
    }
    this.set(
      'max_generation_attempts',
      value.toString(),
      'Maximum number of placement attempts per activity during timetable generation.'
    )
  }

  /** Wall-clock budget for one generation run, in milliseconds. */
  getGenerationTimeoutMs(): number {
    const parsed = parseInt(this.get('generation_timeout_ms') || '30000', 10)
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 30000
  }

  setGenerationTimeoutMs(value: number): void {
    if (!Number.isInteger(value) || value < 100) {
      throw new Error('Generation timeout must be a whole number of milliseconds (at least 100).')
    }
    this.set(
      'generation_timeout_ms',
      value.toString(),
      'Maximum time in milliseconds to spend on a single generation run.'
    )
  }

  /** Soft preference: spread a subject's weekly sessions across days. */
  getPreferSpread(): boolean {
    return this.get('prefer_spread') !== 'false'
  }

  setPreferSpread(value: boolean): void {
    this.set(
      'prefer_spread',
      value ? 'true' : 'false',
      'When true, the generator tries to spread sessions across the week rather than cluster them.'
    )
  }

  /**
   * Hard constraint: whether common Indian Language sessions must be scheduled
   * at the exact same time slot across all sections of each semester.
   * Enabled by default (true).
   */
  getSyncIndianLanguages(): boolean {
    return this.get('sync_indian_languages') !== 'false'
  }

  setSyncIndianLanguages(value: boolean): void {
    this.set(
      'sync_indian_languages',
      value ? 'true' : 'false',
      'Synchronize Indian Language sessions across sections of each semester'
    )
  }

  isSetupComplete(): boolean {
    return this.get('setup_complete') === 'true'
  }

  setSetupComplete(complete: boolean): void {
    this.set('setup_complete', complete ? 'true' : 'false', 'First-run setup completion flag')
  }
}

export const settingsRepository = new SettingsRepository()