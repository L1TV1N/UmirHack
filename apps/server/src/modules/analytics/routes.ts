import { forecastQuery, idParam, locationScopeQuery, recommendationsQuery, rescuedQuery, shortagesQuery, supplierRatingQuery } from '@zapas/shared';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { Deps } from '../../lib/context';
import { asUser, requireUser } from '../../plugins/access';
import { getSupplierRating } from './suppliers';
import { getDashboard, getForecast, getHotDishes, getRecommendations, getRescuedStats, getShortageStats } from './service';

export const analyticsRoutes =
  (deps: Deps): FastifyPluginAsyncZod =>
  async (app) => {
    app.get('/analytics/dashboard', { config: asUser(), schema: { querystring: locationScopeQuery } }, async (req) =>
      getDashboard(deps, requireUser(req), req.query.locationId),
    );

    app.get('/analytics/recommendations', { config: asUser(), schema: { querystring: recommendationsQuery } }, async (req) =>
      getRecommendations(deps, requireUser(req), req.query.locationId, req.query.type),
    );

    // Горячие предложения: блюда, продажу которых стоит стимулировать, с приоритетом и причинами
    app.get('/analytics/hot-dishes', { config: asUser(), schema: { querystring: locationScopeQuery } }, async (req) =>
      getHotDishes(deps, requireUser(req), req.query.locationId),
    );

    // Рейтинг поставщиков: выполнение заказов, сроки, свежесть, потери по причинам
    app.get('/analytics/suppliers', { config: asUser('manager'), schema: { querystring: supplierRatingQuery } }, async (req) =>
      getSupplierRating(deps, requireUser(req), req.query.locationId, req.query.days),
    );

    // Сколько выручили с товара, проданного по скидке до конца срока
    app.get('/analytics/rescued', { config: asUser(), schema: { querystring: rescuedQuery } }, async (req) =>
      getRescuedStats(deps, requireUser(req), req.query.locationId, req.query.days),
    );

    // Самые дефицитные ингредиенты: время без остатка, остановленные блюда, отклонённые заказы
    app.get('/analytics/shortages', { config: asUser(), schema: { querystring: shortagesQuery } }, async (req) =>
      getShortageStats(deps, requireUser(req), req.query.locationId, req.query.days),
    );

    app.get(
      '/analytics/forecast/:id',
      { config: asUser(), schema: { params: idParam, querystring: forecastQuery } },
      async (req) => getForecast(deps, requireUser(req), req.params.id, req.query.locationId),
    );
  };
