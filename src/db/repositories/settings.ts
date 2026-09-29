import { BaseRepository } from './base'
import { ApplicationSettings, DAYS_OF_WEEK, DayOfWeek } from '@/types'

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
    const existing = this.db().prepare('SELECT id FROM application_settings WHERE key = ?').get(key) as { id: string } | undefined
    if (existing) {
      return this.update(existing.id, { value, description })!
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
    this.set('working_hours_start', config.startTime, 'Working hours start time')
    this.set('working_hours_end', config.endTime, 'Working hours end time')
    this.set('break_start', config.breakStart, 'Break start time')
    this.set('break_end', config.breakEnd, 'Break end time')
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

  isSetupComplete(): boolean {
    return this.get('setup_complete') === 'true'
  }

  setSetupComplete(complete: boolean): void {
    this.set('setup_complete', complete ? 'true' : 'false', 'First-run setup completion flag')
  }
}

export const settingsRepository = new SettingsRepository()