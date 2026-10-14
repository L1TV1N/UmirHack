import { seesAllLocations, type Role, type UserDto } from '@zapas/shared';
import type { Selectable } from 'kysely';
import type { Db } from '../../db/client';
import type { UsersTable } from '../../db/types';
import type { Principal } from '../../lib/context';

export type UserRow = Selectable<UsersTable>;

export function toUserDto(row: UserRow, locationIds: string[], now: Date = new Date(), organizationName: string | null = null): UserDto {
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
    organizationId: row.org_id,
    organizationName,
    mustChangePassword: row.must_change_password,
  };
}

export async function loadLocationIds(db: Db, userId: string): Promise<string[]> {
  const rows = await db.selectFrom('user_locations').select('location_id').where('user_id', '=', userId).execute();
  return rows.map((r) => r.location_id);
}

export interface LoadedUser {
  row: UserRow;
  /** Назначенные точки. */
  locationIds: string[];
  /** Точки, которые пользователь видит: у admin и manager все точки организации. */
  scopeIds: string[];
  organizationName: string;
}

export async function loadUser(db: Db, id: string): Promise<LoadedUser | null> {
  const row = await db.selectFrom('users').selectAll().where('id', '=', id).executeTakeFirst();
  if (!row) return null;
  const org = await db.selectFrom('organizations').select('name').where('id', '=', row.org_id).executeTakeFirstOrThrow();
  const locationIds = await loadLocationIds(db, id);
  const scopeIds = seesAllLocations(row.role as Role)
    ? (await db.selectFrom('locations').select('id').where('org_id', '=', row.org_id).execute()).map((l) => l.id)
    : locationIds;
  return { row, locationIds, scopeIds, organizationName: org.name };
}

export function userPrincipal(loaded: LoadedUser): Principal {
  const { row } = loaded;
  return {
    kind: 'user',
    id: row.id,
    email: row.email,
    fullName: row.full_name,
    role: row.role as Role,
    orgId: row.org_id,
    mustChangePassword: row.must_change_password,
    locationIds: loaded.scopeIds,
  };
}
