import { cancelReservationBody, cancelStaffBody, createOfferBody, idParam, reserveBody, slugBody, storefrontSettingsBody } from '@zapas/shared';
import type { FastifyRequest } from 'fastify';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Actor, Deps, UserPrincipal } from '../../lib/context';
import { open, asUser, requireUser } from '../../plugins/access';
import { cancelByGuest, cancelByStaff, closeOffer, createOffer, listOffers, listReservations, listSettings, pickUp, publicRescue, reserve, saveSettings } from './service';

const locationQuery = z.object({ locationId: z.uuid().optional() });
const reservationsQuery = z.object({ locationId: z.uuid().optional(), code: z.string().trim().max(12).optional() });

export const storefrontRoutes =
  (deps: Deps): FastifyPluginAsyncZod =>
  async (app) => {
    const actor = (req: FastifyRequest): Actor => ({ principal: requireUser(req), meta: req.meta });
    const user = (req: FastifyRequest): UserPrincipal => requireUser(req) as UserPrincipal;
    const reserveLimit = { max: deps.config.storefront.reserveLimit, timeWindow: '10 minutes' };

    // Публичная часть: без входа, поэтому каждый маршрут ограничен по частоте, а ответы не содержат ничего, кроме предложений

    app.get('/public/rescue', { config: { ...open, rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (_req, reply) => {
      void reply.header('Cache-Control', 'public, max-age=15');
      return publicRescue(deps);
    });

    app.get(
      '/public/rescue/:slug',
      { config: { ...open, rateLimit: { max: 60, timeWindow: '1 minute' } }, schema: { params: z.object({ slug: slugBody }) } },
      async (req, reply) => {
        void reply.header('Cache-Control', 'public, max-age=15');
        return publicRescue(deps, req.params.slug);
      },
    );

    app.post('/public/rescue/reservations', { config: { ...open, rateLimit: reserveLimit }, schema: { body: reserveBody } }, async (req, reply) => {
      void reply.status(201).header('Cache-Control', 'no-store');
      return reserve(deps, req.body, req.ip ?? null);
    });

    app.post(
      '/public/rescue/reservations/cancel',
      { config: { ...open, rateLimit: { max: 10, timeWindow: '10 minutes' } }, schema: { body: cancelReservationBody } },
      async (req, reply) => {
        await cancelByGuest(deps, req.body);
        return reply.status(204).send();
      },
    );

    // Сотрудники

    app.get('/storefront/settings', { config: asUser('manager') }, async (req) => listSettings(deps, user(req)));

    app.put('/storefront/settings', { config: asUser('manager'), schema: { body: storefrontSettingsBody } }, async (req) => saveSettings(deps, actor(req), req.body));

    app.get('/storefront/offers', { config: asUser('storekeeper'), schema: { querystring: locationQuery } }, async (req) => listOffers(deps, user(req), req.query.locationId));

    app.post('/storefront/offers', { config: asUser('manager'), schema: { body: createOfferBody } }, async (req, reply) => {
      void reply.status(201);
      return createOffer(deps, actor(req), req.body);
    });

    app.post('/storefront/offers/:id/close', { config: asUser('manager'), schema: { params: idParam } }, async (req, reply) => {
      await closeOffer(deps, actor(req), req.params.id);
      return reply.status(204).send();
    });

    app.get('/storefront/reservations', { config: asUser('storekeeper'), schema: { querystring: reservationsQuery } }, async (req) =>
      listReservations(deps, user(req), req.query),
    );

    app.post('/storefront/reservations/:id/pickup', { config: asUser('storekeeper'), schema: { params: idParam } }, async (req) => pickUp(deps, actor(req), req.params.id));

    app.post('/storefront/reservations/:id/cancel', { config: asUser('storekeeper'), schema: { params: idParam, body: cancelStaffBody } }, async (req) =>
      cancelByStaff(deps, actor(req), req.params.id, req.body.reason),
    );
  };
