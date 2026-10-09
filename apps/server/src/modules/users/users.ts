import { seesAllLocations, type Role, type UserDto } from '@zapas/shared';
import type { Selectable } from 'kysely';
import type { Db } from '../../db/client';
import type { UsersTable } from '../../db/types';
import type { Principal } from '../../lib/context';

export type UserRow = Selectable<UsersTable>;

export function toUserDto(row: UserRow, locationIds: string[], now: Date = new Date()): UserDto {
  return {
    id: row.id,
    email: row.email,
    fullName: row.full_name,
    role: row.role,
    isActive: row.is_active,
    locationIds,
    lastLoginAt: row.last_login_at?.toISOString() ?? null,
    lockedUntil: row.locked_until && row.locked_until.getTime() > now.getTime() ? row.locked_until.toISOString() : null,
    createdAt: row.created_at.toISOString(),
  };
}

export async function loadLocationIds(db: Db, userId: string): Promise<string[]> {
  const rows = await db.selectFrom('user_locations').select('location_id').where('user_id', '=', userId).execute();
  return rows.map((r) => r.location_id);
}

export async function loadUser(db: Db, id: string): Promise<{ row: UserRow; locationIds: string[] } | null> {
  const row = await db.selectFrom('users').selectAll().where('id', '=', id).executeTakeFirst();
  if (!row) return null;
  return { row, locationIds: await loadLocationIds(db, id) };
}

export function userPrincipal(row: UserRow, locationIds: string[]): Principal {
  return {
    kind: 'user',
    id: row.id,
    email: row.email,
    fullName: row.full_name,
    role: row.role as Role,
    locationIds: seesAllLocations(row.role as Role) ? 'all' : locationIds,
  };
}
