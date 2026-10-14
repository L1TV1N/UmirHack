import { changePasswordBody, loginBody, registerBody } from '@zapas/shared';
import type { FastifyReply } from 'fastify';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { Deps } from '../../lib/context';
import { unauthorized } from '../../lib/errors';
import { asUser, open, requireUser } from '../../plugins/access';
import { assertTrustedOrigin } from '../../plugins/security';
import { loadUser, toUserDto } from '../users/users';
import { changePassword, login, logout, refresh, register, type SessionResult } from './service';

export const REFRESH_COOKIE = 'zapas_rt';

export const authRoutes =
  (deps: Deps): FastifyPluginAsyncZod =>
  async (app) => {
    const cookieOptions = {
      httpOnly: true,
      secure: deps.config.cookieSecure,
      sameSite: 'strict' as const,
      path: '/api/auth',
    };

    const respond = (reply: FastifyReply, result: SessionResult) => {
      void reply.setCookie(REFRESH_COOKIE, result.refreshToken, { ...cookieOptions, expires: result.refreshExpiresAt });
      return result.session;
    };

    app.post(
      '/auth/login',
      {
        config: { ...open, rateLimit: { max: deps.config.loginRateLimitMax, timeWindow: '1 minute' } },
        schema: { body: loginBody },
      },
      async (req, reply) => {
        // без проверки источника чужая страница могла бы войти в систему под учётной записью злоумышленника
        assertTrustedOrigin(req, deps.config);
        return respond(reply, await login(deps, req.body, req.meta));
      },
    );

    app.post(
      '/auth/register',
      { config: { ...open, rateLimit: { max: deps.config.loginRateLimitMax, timeWindow: '1 minute' } }, schema: { body: registerBody } },
      async (req, reply) => {
        assertTrustedOrigin(req, deps.config);
        void reply.status(201);
        return respond(reply, await register(deps, req.body, req.meta));
      },
    );

    app.post('/auth/refresh', { config: { ...open, rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (req, reply) => {
      assertTrustedOrigin(req, deps.config);
      const token = req.cookies[REFRESH_COOKIE];
      if (!token) throw unauthorized('Нужно войти', 'no_session');
      try {
        return respond(reply, await refresh(deps, token, req.meta));
      } catch (err) {
        if ((err as { code?: string }).code === 'invalid_session') {
          void reply.clearCookie(REFRESH_COOKIE, cookieOptions);
        }
        throw err;
      }
    });

    app.post('/auth/logout', { config: open }, async (req, reply) => {
      assertTrustedOrigin(req, deps.config);
      await logout(deps, req.cookies[REFRESH_COOKIE], req.meta);
      void reply.clearCookie(REFRESH_COOKIE, cookieOptions);
      return reply.status(204).send();
    });

    app.get('/auth/me', { config: asUser('waiter') }, async (req) => {
      const principal = requireUser(req);
      const loaded = await loadUser(deps.db, principal.id);
      if (!loaded) throw unauthorized();
      return toUserDto(loaded.row, loaded.locationIds, deps.clock(), loaded.organizationName);
    });

    app.post(
      '/auth/change-password',
      {
        config: { ...asUser('waiter'), rateLimit: { max: 5, timeWindow: '1 minute' } },
        schema: { body: changePasswordBody },
      },
      async (req, reply) => {
        await changePassword(deps, requireUser(req), req.body, req.meta);
        void reply.clearCookie(REFRESH_COOKIE, cookieOptions);
        return reply.status(204).send();
      },
    );
  };
