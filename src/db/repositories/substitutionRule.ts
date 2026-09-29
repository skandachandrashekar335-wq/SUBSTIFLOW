import { BaseRepository } from './base'
import { SubstitutionRule } from '@/types'

export class SubstitutionRuleRepository extends BaseRepository<SubstitutionRule> {
  protected tableName = 'substitution_rules'

  protected entityFromRow(row: any): SubstitutionRule {
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      weight: row.weight,
      isEnabled: Boolean(row.is_enabled),
      config: JSON.parse(row.config),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }
  }

  getEnabled(): SubstitutionRule[] {
    const rows = this.db().prepare('SELECT * FROM substitution_rules WHERE is_enabled = 1 ORDER BY weight DESC').all() as any[]
    return rows.map(row => this.entityFromRow(row))
  }
}

export const substitutionRuleRepository = new SubstitutionRuleRepository()