import { twoFactorStartBody, twoFactorVerifyBody, type TwoFactorConfirmDto, type TwoFactorStartDto, type TwoFactorStatusDto } from '@zapas/shared';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { Deps } from '../../lib/context';
import { AppError, badRequest, conflict, forbidden, unauthorized } from '../../lib/errors';
import { asUser, requireUser } from '../../plugins/access';
import { writeAudit } from '../audit/audit';
import { linkOfUser } from '../telegram/links';
import { loadUser } from '../users/users';
import { verifyPassword } from './password';
import { registerFailure } from './service';
import { checkChallenge, clearTwoFactor, createChallenge, isTwoFactorEligible, notifyUser, recoveryCodesLeft, replaceRecoveryCodes } from './two-factor';

/** Управление подтверждением входа: статус, включение, выключение, новые резервные коды. Только для администратора. */
export const twoFactorRoutes =
  (deps: Deps): FastifyPluginAsyncZod =>
  async (app) => {
    const { db } = deps;

    app.get('/auth/2fa', { config: asUser('waiter') }, async (req): Promise<TwoFactorStatusDto> => {
      const principal = requireUser(req);
      const loaded = await loadUser(db, principal.id);
      if (!loaded) throw unauthorized();
      const link = await linkOfUser(db, principal.id);
      return {
        eligible: isTwoFactorEligible(loaded.row.role),
        botConfigured: Boolean(deps.codeSender ?? deps.telegram),
        telegramLinked: link !== null,
        enabled: loaded.row.two_factor_enabled,
        enabledAt: loaded.row.two_factor_enabled_at?.toISOString() ?? null,
        recoveryCodesLeft: loaded.row.two_factor_enabled ? await recoveryCodesLeft(db, principal.id) : 0,
      };
    });

    app.post(
      '/auth/2fa/start',
      { config: { ...asUser('admin'), rateLimit: { max: deps.config.loginRateLimitMax, timeWindow: '1 minute' } }, schema: { body: twoFactorStartBody } },
      async (req): Promise<TwoFactorStartDto> => {
        const principal = requireUser(req);
        const loaded = await loadUser(db, principal.id);
        if (!loaded) throw unauthorized();
        const { row } = loaded;
        if (!isTwoFactorEligible(row.role)) throw forbidden();
        const { purpose, password } = req.body;
        const now = deps.clock();

        if (purpose === 'enable') {
          if (row.two_factor_enabled) throw conflict('Подтверждение входа уже включено', undefined, 'already_enabled');
          if (!(deps.codeSender ?? deps.telegram)) throw conflict('Бот Telegram не настроен на сервере', undefined, 'telegram_not_configured');
          if (!(await linkOfUser(db, row.id))) throw conflict('Сначала привяжите Telegram в профиле: код придёт в чат с ботом', undefined, 'telegram_not_linked');
        } else {
          if (!row.two_factor_enabled) throw conflict('Подтверждение входа не включено', undefined, 'not_enabled');
          // чужая сессия не должна выключить защиту: нужен пароль, и подбор его упирается в блокировку, как при смене пароля
          if (row.locked_until && row.locked_until.getTime() > now.getTime()) throw new AppError(429, 'account_locked', 'Слишком много неудачных попыток. Повторите позже.');
          if (!password || !(await verifyPassword(row.password_hash, password))) {
            await registerFailure(deps, row, req.meta, now);
            throw badRequest('Пароль указан неверно', [{ path: ['password'], message: 'Неверный пароль' }], 'wrong_password');
          }
        }

        const issued = await createChallenge(deps, row, purpose, req.meta.ip);
        if (purpose === 'enable' && !issued.delivered) {
          await db.deleteFrom('login_challenges').where('id', '=', issued.id).execute();
          throw new AppError(502, 'telegram_unavailable', 'Не удалось отправить код в Telegram. Проверьте, что чат с ботом не заблокирован, и повторите.');
        }
        return { challengeId: issued.id, delivered: issued.delivered, expiresIn: issued.expiresIn, resendAfter: issued.resendAfter };
      },
    );

    app.post(
      '/auth/2fa/confirm',
      { config: { ...asUser('admin'), rateLimit: { max: deps.config.loginRateLimitMax, timeWindow: '1 minute' } }, schema: { body: twoFactorVerifyBody } },
      async (req): Promise<TwoFactorConfirmDto> => {
        const principal = requireUser(req);
        const now = deps.clock();
        const result = await checkChallenge(deps, req.body.challengeId, req.body.code, ['enable', 'disable', 'recovery'], principal.id);

        if (!result.ok) {
          if (result.user) {
            await registerFailure(deps, result.user, req.meta, now);
            await writeAudit(db, { action: 'auth.2fa_failed', entity: 'user', entityId: result.user.id, principal, details: { reason: result.reason }, meta: req.meta, at: now });
          }
          if (result.reason === 'exhausted') throw unauthorized('Слишком много неверных кодов. Начните заново.', 'challenge_exhausted');
          if (result.reason === 'wrong') throw unauthorized(`Неверный код. Осталось попыток: ${result.attemptsLeft}`, 'invalid_code');
          throw unauthorized('Запрос устарел или закрыт. Начните заново.', 'invalid_challenge');
        }

        if (result.purpose === 'enable') {
          const codes = await db.transaction().execute(async (trx) => {
            const updated = await trx
              .updateTable('users')
              .set({ two_factor_enabled: true, two_factor_enabled_at: now, updated_at: now })
              .where('id', '=', principal.id)
              .where('two_factor_enabled', '=', false)
              .returning('id')
              .executeTakeFirst();
            if (!updated) throw conflict('Подтверждение входа уже включено', undefined, 'already_enabled');
            const fresh = await replaceRecoveryCodes(deps, trx, principal.id);
            await writeAudit(trx, { action: '2fa.enable', entity: 'user', entityId: principal.id, principal, meta: req.meta, at: now, details: {} });
            return fresh;
          });
          await notifyUser(deps, principal.id, 'Подтверждение входа включено. Теперь при входе в «Запас» сюда будет приходить код. Резервные коды сохраните в надёжном месте.');
          return { enabled: true, recoveryCodes: codes };
        }

        if (result.purpose === 'disable') {
          await db.transaction().execute(async (trx) => {
            await clearTwoFactor(trx, principal.id, now);
            await writeAudit(trx, { action: '2fa.disable', entity: 'user', entityId: principal.id, principal, meta: req.meta, at: now, details: { via: result.via } });
          });
          await notifyUser(deps, principal.id, 'Подтверждение входа выключено. Если это были не вы, срочно смените пароль.');
          return { enabled: false, recoveryCodes: null };
        }

        const codes = await db.transaction().execute(async (trx) => {
          const fresh = await replaceRecoveryCodes(deps, trx, principal.id);
          await writeAudit(trx, { action: '2fa.recovery_codes', entity: 'user', entityId: principal.id, principal, meta: req.meta, at: now, details: {} });
          return fresh;
        });
        await notifyUser(deps, principal.id, 'Выпущен новый набор резервных кодов, прежние больше не действуют.');
        return { enabled: true, recoveryCodes: codes };
      },
    );
  };
