import { loginBody } from '@zapas/shared';
import { loadEnvFile, parseConfig } from '../config';
import { writeAudit } from '../modules/audit/audit';
import { createDb } from './client';

/**
 * Сброс подтверждения входа администратору, который потерял и Telegram, и резервные коды, а коллег-администраторов
 * в системе нет (или они тоже не могут войти). Выполняется на сервере под владельцем базы: тот, кто до этого дошёл,
 * и так управляет всем. Все сессии пользователя закрываются, действие попадает в журнал аудита.
 *
 * Пример: npm run 2fa:reset -w @zapas/server -- admin@example.ru
 */
async function main(): Promise<void> {
  loadEnvFile();
  const config = parseConfig();
  const email = (process.argv[2] ?? process.env.ADMIN_EMAIL ?? '').trim().toLowerCase();
  if (!loginBody.shape.email.safeParse(email).success) throw new Error('Укажите почту пользователя: npm run 2fa:reset -w @zapas/server -- адрес@почта');

  const handle = createDb(config.migrationDatabaseUrl, 2);
  try {
    const now = new Date();
    await handle.db.transaction().execute(async (trx) => {
      const user = await trx.selectFrom('users').select(['id', 'two_factor_enabled']).where('email', '=', email).forUpdate().executeTakeFirst();
      if (!user) throw new Error('Пользователь с такой почтой не найден');
      if (!user.two_factor_enabled) throw new Error('У пользователя подтверждение входа не включено');
      await trx.updateTable('users').set({ two_factor_enabled: false, two_factor_enabled_at: null, failed_attempts: 0, locked_until: null, updated_at: now }).where('id', '=', user.id).execute();
      await trx.deleteFrom('recovery_codes').where('user_id', '=', user.id).execute();
      await trx.deleteFrom('login_challenges').where('user_id', '=', user.id).execute();
      await trx.updateTable('refresh_tokens').set({ revoked_at: now }).where('user_id', '=', user.id).where('revoked_at', 'is', null).execute();
      await writeAudit(trx, { action: '2fa.reset', entity: 'user', entityId: user.id, email, details: { source: 'cli' }, at: now });
    });
    console.log(`Подтверждение входа для ${email} сброшено, сессии закрыты`);
  } finally {
    await handle.close();
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
