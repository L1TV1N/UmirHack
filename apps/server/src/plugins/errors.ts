import type { ApiErrorBody } from '@zapas/shared';
import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import { hasZodFastifySchemaValidationErrors } from 'fastify-type-provider-zod';
import { AppError, pgCode, PG_CHECK_VIOLATION, PG_FK_VIOLATION, PG_UNIQUE_VIOLATION } from '../lib/errors';

export function send(reply: FastifyReply, req: FastifyRequest, status: number, code: string, message: string, details?: unknown) {
  const body: ApiErrorBody = { error: { code, message, ...(details !== undefined ? { details } : {}) }, requestId: req.id };
  return reply.status(status).send(body);
}

const HTTP_CODES: Record<number, [string, string]> = {
  400: ['bad_request', 'Некорректный запрос'],
  404: ['not_found', 'Не найдено'],
  405: ['method_not_allowed', 'Метод не поддерживается'],
  413: ['payload_too_large', 'Слишком большой запрос'],
  415: ['unsupported_media_type', 'Неподдерживаемый тип данных'],
  429: ['too_many_requests', 'Слишком много запросов, повторите позже'],
};

export const errorsPlugin = fp(async (app: FastifyInstance) => {
  app.setErrorHandler((err: FastifyError | AppError, req, reply) => {
    if (hasZodFastifySchemaValidationErrors(err)) {
      const details = err.validation.map((v) => ({
        path: v.instancePath.split('/').filter(Boolean),
        message: v.message ?? 'Некорректное значение',
      }));
      return send(reply, req, 400, 'validation_error', 'Проверьте введённые данные', details);
    }

    if (err instanceof AppError) {
      if (err.status >= 500) req.log.error({ err }, 'ошибка приложения');
      // отказы в доступе пригодятся при разборе инцидентов, но без тел запросов и токенов
      else if (err.status === 401 || err.status === 403) {
        req.log.warn({ code: err.code, status: err.status, route: req.routeOptions?.url, ip: req.ip, userId: req.principal?.kind === 'user' ? req.principal.id : undefined }, 'доступ отклонён');
      }
      return send(reply, req, err.status, err.code, err.message, err.details);
    }

    const pg = pgCode(err);
    // база перегружена или недоступна: это временное состояние, клиенту стоит повторить запрос позже
    if (pg === '57014' || pg === '53300' || pg === '57P01' || /timeout exceeded when trying to connect|Connection terminated|ECONNREFUSED/i.test(String((err as Error).message))) {
      req.log.error({ err }, 'база данных недоступна или перегружена');
      void reply.header('Retry-After', '3');
      return send(reply, req, 503, 'unavailable', 'Сервис временно перегружен, повторите запрос через несколько секунд');
    }
    // класс 22 в PostgreSQL: данные недопустимы для типа (нулевой байт, выход за диапазон)
    if (pg?.startsWith('22')) return send(reply, req, 400, 'invalid_data', 'Недопустимое значение в запросе');
    if (pg === PG_UNIQUE_VIOLATION) return send(reply, req, 409, 'duplicate', 'Такая запись уже существует');
    if (pg === PG_FK_VIOLATION) return send(reply, req, 409, 'in_use', 'Запись связана с другими данными');
    if (pg === PG_CHECK_VIOLATION) return send(reply, req, 409, 'constraint', 'Значение нарушает ограничение данных');

    const status = (err as FastifyError).statusCode;
    if (status && status >= 400 && status < 500) {
      const [code, message] = HTTP_CODES[status] ?? ['bad_request', 'Некорректный запрос'];
      const retry = (err as { retryAfterSeconds?: number }).retryAfterSeconds;
      if (retry) void reply.header('Retry-After', String(retry));
      return send(reply, req, status, code, message);
    }

    req.log.error({ err }, 'необработанная ошибка');
    return send(reply, req, 500, 'internal_error', 'Внутренняя ошибка сервера');
  });
});
