import { hasRole, type Role } from '@zapas/shared';
import type { FastifyInstance, FastifyRequest, onRequestAsyncHookHandler } from 'fastify';
import fp from 'fastify-plugin';
import { sha256Hex } from '../lib/crypto';
import type { Deps, Principal, RequestMeta } from '../lib/context';
import { forbidden, unauthorized } from '../lib/errors';
import { verifyAccessToken } from '../modules/auth/tokens';
import { loadUser, userPrincipal } from '../modules/users/users';

export type Access =
  | { kind: 'public' }
  | { kind: 'user'; minRole: Role }
  | { kind: 'pos' };

export interface RouteInfo {
  method: string;
  url: string;
  access: Access;
}

declare module 'fastify' {
  interface FastifyInstance {
    /** Все маршруты API с объявленными правами. Нужен проверкам и документации. */
    routeTable: RouteInfo[];
  }
  interface FastifyContextConfig {
    access?: Access;
  }
  interface FastifyRequest {
    principal: Principal | null;
    meta: RequestMeta;
  }
}

export const open: { access: Access } = { access: { kind: 'public' } };
export const asUser = (minRole: Role = 'viewer'): { access: Access } => ({ access: { kind: 'user', minRole } });
export const asPos: { access: Access } = { access: { kind: 'pos' } };

const API_KEY_PATTERN = /^zk_[A-Za-z0-9_-]{8}_[A-Za-z0-9_-]{32,64}$/;
const LAST_USED_THROTTLE_MS = 60_000;

function bearer(req: FastifyRequest): string | null {
  const header = req.headers.authorization;
  if (!header) return null;
  const [scheme, token, ...rest] = header.split(' ');
  if (scheme?.toLowerCase() !== 'bearer' || !token || rest.length > 0) return null;
  return token;
}

async function authenticateUser(deps: Deps, req: FastifyRequest): Promise<Extract<Principal, { kind: 'user' }>> {
  const token = bearer(req);
  if (!token) throw unauthorized();
  const now = deps.clock();
  const claims = await verifyAccessToken(deps.config.jwtSecret, token, now);
  if (!claims) throw unauthorized('Сессия истекла', 'token_expired');

  const loaded = await loadUser(deps.db, claims.sub);
  if (!loaded || !loaded.row.is_active) throw unauthorized('Сессия недействительна', 'invalid_session');
  // после выхода или отзыва сессии токен доступа перестаёт действовать сразу, а не через 15 минут
  const alive = await deps.db
    .selectFrom('refresh_tokens')
    .select('id')
    .where('family_id', '=', claims.sid)
    .where('user_id', '=', claims.sub)
    .where('revoked_at', 'is', null)
    .limit(1)
    .executeTakeFirst();
  if (!alive) throw unauthorized('Сессия закрыта', 'invalid_session');
  // токены, выданные до смены пароля, перестают действовать
  if (Math.floor(loaded.row.password_changed_at.getTime() / 1000) > claims.iat) {
    throw unauthorized('Сессия недействительна', 'invalid_session');
  }
  return userPrincipal(loaded.row, loaded.locationIds) as Extract<Principal, { kind: 'user' }>;
}

async function authenticateApiKey(deps: Deps, req: FastifyRequest): Promise<Principal> {
  const key = req.headers['x-api-key'];
  if (typeof key !== 'string' || !API_KEY_PATTERN.test(key)) throw unauthorized('Неверный ключ', 'invalid_api_key');
  const row = await deps.db
    .selectFrom('api_keys')
    .innerJoin('locations', 'locations.id', 'api_keys.location_id')
    .select(['api_keys.id', 'api_keys.name', 'api_keys.location_id', 'api_keys.last_used_at', 'locations.is_active'])
    .where('api_keys.key_hash', '=', sha256Hex(key))
    .where('api_keys.revoked_at', 'is', null)
    .executeTakeFirst();
  if (!row || !row.is_active) throw unauthorized('Неверный ключ', 'invalid_api_key');

  const now = deps.clock();
  if (!row.last_used_at || now.getTime() - row.last_used_at.getTime() > LAST_USED_THROTTLE_MS) {
    await deps.db.updateTable('api_keys').set({ last_used_at: now }).where('id', '=', row.id).execute();
  }
  return { kind: 'apikey', id: row.id, name: row.name, locationIds: [row.location_id] };
}

/**
 * Каждый маршрут под /api обязан объявить права в config.access. Без этого сервер не стартует:
 * забытая проверка прав не доживёт до продакшена.
 */
export const accessPlugin = fp<{ deps: Deps }>(async (app: FastifyInstance, { deps }) => {
  app.decorateRequest('principal', null);
  const table: RouteInfo[] = [];
  app.decorate('routeTable', table);

  app.addHook('onRoute', (route) => {
    if (!route.url.startsWith('/api')) return;
    const access = route.config?.access;
    if (!access) {
      throw new Error(`Маршрут ${String(route.method)} ${route.url} не объявил права доступа (config.access)`);
    }
    for (const method of [route.method].flat()) {
      if (method !== 'HEAD' && method !== 'OPTIONS') table.push({ method, url: route.url, access });
    }

    const handler: onRequestAsyncHookHandler = async (req) => {
      if (access.kind === 'public') return;
      if (access.kind === 'pos') {
        req.principal = await authenticateApiKey(deps, req);
        return;
      }
      const principal = await authenticateUser(deps, req);
      if (!hasRole(principal.role, access.minRole)) throw forbidden();
      req.principal = principal;
    };

    const existing = route.onRequest;
    route.onRequest = [handler, ...(Array.isArray(existing) ? existing : existing ? [existing] : [])];
  });
});

export function requirePrincipal(req: FastifyRequest): Principal {
  if (!req.principal) throw unauthorized();
  return req.principal;
}

export function requireUser(req: FastifyRequest): Extract<Principal, { kind: 'user' }> {
  const p = requirePrincipal(req);
  if (p.kind !== 'user') throw forbidden();
  return p;
}
