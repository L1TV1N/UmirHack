import { DEFAULT_ORG_ID, settingsBody, type SettingsBody } from '@zapas/shared';
import type { Transaction } from 'kysely';
import type { Db } from '../../db/client';
import type { Database } from '../../db/types';

export const DEFAULT_SETTINGS: SettingsBody = {
  expiringSoonDays: 3,
  criticalDays: 1,
  forecastWindowDays: 28,
  reorderCoverDays: 7,
  lowPortionThreshold: 3,
  digestHour: 8,
  useDemandModel: true,
  autoWriteoffExpired: false,
};

// Настройки у каждой организации свои. У организации по умолчанию прежний ключ, чтобы не переносить данные
const keyOf = (orgId: string): string => (orgId === DEFAULT_ORG_ID ? 'app' : `app:${orgId}`);

export async function getSettings(db: Db, orgId: string = DEFAULT_ORG_ID): Promise<SettingsBody> {
  const row = await db.selectFrom('settings').select('value').where('key', '=', keyOf(orgId)).executeTakeFirst();
  if (!row) return DEFAULT_SETTINGS;
  const parsed = settingsBody.safeParse({ ...DEFAULT_SETTINGS, ...(row.value as object) });
  return parsed.success ? parsed.data : DEFAULT_SETTINGS;
}

export async function saveSettings(db: Db | Transaction<Database>, value: SettingsBody, userId: string | null, orgId: string = DEFAULT_ORG_ID): Promise<void> {
  await db
    .insertInto('settings')
    .values({ key: keyOf(orgId), value: JSON.stringify(value), updated_by: userId, updated_at: new Date() })
    .onConflict((oc) =>
      oc.column('key').doUpdateSet({ value: JSON.stringify(value), updated_by: userId, updated_at: new Date() }),
    )
    .execute();
}
