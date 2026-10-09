import { forecastQuery, idParam, locationScopeQuery, recommendationsQuery } from '@zapas/shared';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { Deps } from '../../lib/context';
import { asUser, requireUser } from '../../plugins/access';
import { getDashboard, getForecast, getRecommendations } from './service';

export const analyticsRoutes =
  (deps: Deps): FastifyPluginAsyncZod =>
  async (app) => {
    app.get('/analytics/dashboard', { config: asUser(), schema: { querystring: locationScopeQuery } }, async (req) =>
      getDashboard(deps, requireUser(req), req.query.locationId),
    );

    app.get('/analytics/recommendations', { config: asUser(), schema: { querystring: recommendationsQuery } }, async (req) =>
      getRecommendations(deps, requireUser(req), req.query.locationId, req.query.type),
    );

    app.get(
      '/analytics/forecast/:id',
      { config: asUser(), schema: { params: idParam, querystring: forecastQuery } },
      async (req) => getForecast(deps, requireUser(req), req.params.id, req.query.locationId),
    );
  };
