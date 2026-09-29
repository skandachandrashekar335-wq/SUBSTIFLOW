import { BaseRepository } from './base'
import { Room } from '@/types'

export class RoomRepository extends BaseRepository<Room> {
  protected tableName = 'rooms'

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