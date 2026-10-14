import type { ServerResponse } from 'node:http';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { hubFor, type LiveEvent } from '../../lib/events';
import type { Deps } from '../../lib/context';
import { AppError } from '../../lib/errors';
import { asUser, requireUser } from '../../plugins/access';

const PING_MS = 25_000;
/** Токен доступа живёт 15 минут, поток живёт не дольше: после переподключения права проверяются заново. */
const MAX_LIFE_MS = 14 * 60_000;
const MAX_STREAMS_PER_USER = 5;

/** Завершает ответ и закрывает соединение: иначе оно остаётся в keep-alive, и остановка сервера ждёт его дольше минуты. */
function finish(res: ServerResponse): void {
  res.end();
  res.socket?.destroySoon();
}

export const eventRoutes =
  (deps: Deps): FastifyPluginAsyncZod =>
  async (app) => {
    const hub = hubFor(deps.db);
    const open = new Set<ServerResponse>();
    const perUser = new Map<string, number>();

    // без этого остановка сервера ждала бы, пока клиенты сами закроют потоки: обычный onClose срабатывает уже после ожидания
    app.addHook('preClose', async () => {
      for (const res of [...open]) finish(res);
      open.clear();
      hub.stop();
    });

    // Поток изменений данных (Server-Sent Events). Интерфейс не умеет передать токен в EventSource, поэтому
    // подключается обычным fetch с заголовком авторизации.
    app.get('/events', { config: { ...asUser('waiter'), rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req, reply) => {
      const principal = requireUser(req);
      const used = perUser.get(principal.id) ?? 0;
      if (used >= MAX_STREAMS_PER_USER) throw new AppError(429, 'too_many_streams', 'Слишком много открытых потоков обновлений');
      perUser.set(principal.id, used + 1);

      reply.hijack();
      const res = reply.raw;
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Content-Type-Options': 'nosniff',
        // обратный прокси не должен копить ответ: иначе события придут пачкой через минуты
        'X-Accel-Buffering': 'no',
      });
      res.write('retry: 5000\n\nevent: ready\ndata: {}\n\n');
      open.add(res);

      const send = (event: LiveEvent) => {
        res.write(`event: ${event.type}\ndata: ${JSON.stringify({ at: event.at })}\n\n`);
      };
      const unsubscribe = hub.subscribe(send, principal.orgId);
      const ping = setInterval(() => res.write(': ping\n\n'), PING_MS);
      const life = setTimeout(() => finish(res), MAX_LIFE_MS * (0.9 + Math.random() * 0.1));
      ping.unref();
      life.unref();

      res.on('close', () => {
        clearInterval(ping);
        clearTimeout(life);
        unsubscribe();
        open.delete(res);
        const left = (perUser.get(principal.id) ?? 1) - 1;
        if (left > 0) perUser.set(principal.id, left);
        else perUser.delete(principal.id);
      });
    });
  };
