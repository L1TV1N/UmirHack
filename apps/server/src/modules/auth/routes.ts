import { changePasswordBody, loginBody, registerBody, resendEmailBody, twoFactorResendBody, twoFactorVerifyBody, verifyEmailBody } from '@zapas/shared';
import type { FastifyReply } from 'fastify';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { Deps } from '../../lib/context';
import { unauthorized } from '../../lib/errors';
import { asUser, open, requireUser } from '../../plugins/access';
import { assertTrustedOrigin } from '../../plugins/security';
import { loadUser, toUserDto } from '../users/users';
import { resendEmailCode } from './email-verification';
import { changePassword, completeTwoFactorLogin, login, logout, refresh, register, resendLoginCode, verifyEmail, type SessionResult } from './service';

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
        const result = await login(deps, req.body, req.meta);
        // нужен код из Telegram: сессии и cookie ещё нет
        if ('twoFactor' in result) return result.twoFactor;
        // почта не подтверждена: нужен код из письма
        if ('emailVerificationRequired' in result) return result;
        return respond(reply, result);
      },
    );

    app.post(
      '/auth/2fa/verify',
      { config: { ...open, rateLimit: { max: deps.config.loginRateLimitMax, timeWindow: '1 minute' } }, schema: { body: twoFactorVerifyBody } },
      async (req, reply) => {
        assertTrustedOrigin(req, deps.config);
        return respond(reply, await completeTwoFactorLogin(deps, req.body, req.meta));
      },
    );

    app.post(
      '/auth/2fa/resend',
      { config: { ...open, rateLimit: { max: deps.config.loginRateLimitMax, timeWindow: '1 minute' } }, schema: { body: twoFactorResendBody } },
      async (req) => {
        assertTrustedOrigin(req, deps.config);
        const issued = await resendLoginCode(deps, req.body.challengeId, req.meta);
        return { challengeId: issued.id, delivered: issued.delivered, expiresIn: issued.expiresIn, resendAfter: issued.resendAfter };
      },
    );

    app.post(
      '/auth/register',
      { config: { ...open, rateLimit: { max: deps.config.loginRateLimitMax, timeWindow: '1 minute' } }, schema: { body: registerBody } },
      async (req, reply) => {
        assertTrustedOrigin(req, deps.config);
        const result = await register(deps, req.body, req.meta);
        if ('emailVerificationRequired' in result) return reply.status(202).send(result);
        void reply.status(201);
        return respond(reply, result);
      },
    );

    app.post(
      '/auth/verify-email',
      { config: { ...open, rateLimit: { max: deps.config.loginRateLimitMax, timeWindow: '1 minute' } }, schema: { body: verifyEmailBody } },
      async (req, reply) => {
        assertTrustedOrigin(req, deps.config);
        return respond(reply, await verifyEmail(deps, req.body, req.meta));
      },
    );

    app.post(
      '/auth/verify-email/resend',
      { config: { ...open, rateLimit: { max: deps.config.loginRateLimitMax, timeWindow: '1 minute' } }, schema: { body: resendEmailBody } },
      async (req) => {
        assertTrustedOrigin(req, deps.config);
        return resendEmailCode(deps, req.body.email);
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
