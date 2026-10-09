import type { TelegramLinkCodeDto, TelegramStatusDto } from '@zapas/shared';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { Deps } from '../../lib/context';
import { conflict } from '../../lib/errors';
import { asUser, requireUser } from '../../plugins/access';
import { createLinkCode, linkOfUser, unlink } from './links';

export const telegramRoutes =
  (deps: Deps): FastifyPluginAsyncZod =>
  async (app) => {
    // имя бота нужно для ссылки «открыть бота»; спрашиваем у Telegram один раз и запоминаем
    let username: string | null | undefined;
    const botName = async (): Promise<string | null> => {
      if (username !== undefined) return username;
      try {
        username = deps.telegram ? ((await deps.telegram.getMe()).username || null) : null;
      } catch {
        return null; // не запоминаем: следующий запрос попробует снова
      }
      return username;
    };

    app.get('/telegram', { config: asUser() }, async (req): Promise<TelegramStatusDto> => {
      const principal = requireUser(req);
      const link = await linkOfUser(deps.db, principal.id);
      return {
        enabled: Boolean(deps.telegram),
        botUsername: deps.telegram ? await botName() : null,
        linked: link !== null,
        linkedAt: link?.linkedAt.toISOString() ?? null,
        chatUsername: link?.username ?? null,
      };
    });

    app.post('/telegram/link-code', { config: { ...asUser(), rateLimit: { max: deps.config.loginRateLimitMax, timeWindow: '1 minute' } } }, async (req, reply): Promise<TelegramLinkCodeDto> => {
      const principal = requireUser(req);
      if (!deps.telegram) throw conflict('Бот Telegram не настроен администратором', undefined, 'telegram_not_configured');
      const { code, expiresAt } = await createLinkCode(deps, principal.id);
      const bot = await botName();
      void reply.status(201);
      return { code, expiresAt: expiresAt.toISOString(), deepLink: bot ? `https://t.me/${bot}?start=${code}` : null };
    });

    app.delete('/telegram/link', { config: asUser() }, async (req, reply) => {
      const principal = requireUser(req);
      await unlink(deps, principal.id, principal, req.meta);
      return reply.status(204).send();
    });
  };
