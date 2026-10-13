import { settingsBody, type SettingsBody } from '@zapas/shared';
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

const KEY = 'app';

export async function getSettings(db: Db): Promise<SettingsBody> {
  const row = await db.selectFrom('settings').select('value').where('key', '=', KEY).executeTakeFirst();
  if (!row) return DEFAULT_SETTINGS;
  const parsed = settingsBody.safeParse({ ...DEFAULT_SETTINGS, ...(row.value as object) });
  return parsed.success ? parsed.data : DEFAULT_SETTINGS;
}

export async function saveSettings(db: Db | Transaction<Database>, value: SettingsBody, userId: string | null): Promise<void> {
  await db
    .insertInto('settings')
    .values({ key: KEY, value: JSON.stringify(value), updated_by: userId, updated_at: new Date() })
    .onConflict((oc) =>
      oc.column('key').doUpdateSet({ value: JSON.stringify(value), updated_by: userId, updated_at: new Date() }),
    )
    .execute();
}
