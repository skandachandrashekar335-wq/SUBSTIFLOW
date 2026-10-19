import { BaseRepository } from './base'
import { Room } from '@/types'

export class RoomRepository extends BaseRepository<Room> {
  protected tableName = 'rooms'

  /** Room pickers need a stable, human-friendly order even for fast inserts. */
  findAll(): Room[] {
    const rows = this.db()
      .prepare('SELECT * FROM rooms ORDER BY name COLLATE NOCASE ASC, id ASC')
      .all() as any[]
    return rows.map((row) => this.entityFromRow(row))
  }

  protected entityFromRow(row: any): Room {
    return {
      id: row.id,
      name: row.name,
      capacity: row.capacity,
      type: row.type,
      departmentId: row.department_id,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }
  }
}

export const roomRepository = new RoomRepository()
