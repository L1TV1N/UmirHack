import {
  accuracyQuery,
  calendarDayBody,
  calendarQuery,
  demandQuery,
  type AccuracyDto,
  type CalendarDayDto,
  type DemandForecastDto,
  type UpcomingOffDayDto,
  type WeatherRefreshDto,
  type WeatherStatusDto,
} from '@zapas/shared';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Deps } from '../../lib/context';
import { conflict } from '../../lib/errors';
import { asUser, requireUser } from '../../plugins/access';
import { writeAudit } from '../audit/audit';
import { getAccuracy, getDemandForecast, listCalendarDays, refreshDemandOutlook, upcomingOff, weatherStatus } from './service';
import { refreshWeather } from './weather';

const dateParam = z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) });

export const forecastRoutes =
  (deps: Deps): FastifyPluginAsyncZod =>
  async (app) => {
    const { db } = deps;
    const heavy = { rateLimit: { max: Math.max(20, Math.floor(deps.config.rateLimitMax / 30)), timeWindow: '1 minute' } };

    // Прогноз спроса по позиции: уровень, дни недели, подтверждённые эффекты и ближайшие сутки с причинами
    app.get('/forecast/demand', { config: { ...asUser('storekeeper'), ...heavy }, schema: { querystring: demandQuery } }, async (req): Promise<DemandForecastDto> => {
      const { productId, locationId, days } = req.query;
      return getDemandForecast(deps, requireUser(req), productId, locationId, days);
    });

    // Проверка на прошлом: насколько прогноз попадал в фактические продажи
    app.get('/forecast/accuracy', { config: { ...asUser('manager'), ...heavy }, schema: { querystring: accuracyQuery } }, async (req): Promise<AccuracyDto> =>
      getAccuracy(deps, requireUser(req), req.query.locationId, req.query.days),
    );

    app.get('/forecast/weather', { config: asUser('admin') }, async (): Promise<WeatherStatusDto> => weatherStatus(deps));

    app.post('/forecast/weather/refresh', { config: { ...asUser('admin'), rateLimit: { max: 6, timeWindow: '1 minute' } } }, async (req): Promise<WeatherRefreshDto> => {
      const principal = requireUser(req);
      if (!deps.weather) throw conflict('Загрузка погоды отключена на сервере (WEATHER_ENABLED=false)', undefined, 'weather_disabled');
      const result = await refreshWeather(deps);
      await refreshDemandOutlook(deps);
      await writeAudit(db, { action: 'weather.refresh', entity: 'weather', principal, meta: req.meta, at: deps.clock(), details: { locations: result.locations, days: result.days, failed: result.failed.length } });
      return result;
    });

    // Календарь: встроенные переносы и ручные исправления
    app.get('/calendar/days', { config: asUser() }, async (): Promise<CalendarDayDto[]> => listCalendarDays(db));

    app.get('/calendar/upcoming', { config: asUser(), schema: { querystring: calendarQuery } }, async (req): Promise<UpcomingOffDayDto[]> => upcomingOff(deps, req.query.days));

    app.put('/calendar/days', { config: asUser('admin'), schema: { body: calendarDayBody } }, async (req): Promise<CalendarDayDto[]> => {
      const principal = requireUser(req);
      const now = deps.clock();
      await db.transaction().execute(async (trx) => {
        await trx
          .insertInto('calendar_days')
          .values({ day: req.body.date, kind: req.body.kind, note: req.body.note ?? null, created_by: principal.id, created_at: now })
          .onConflict((oc) => oc.column('day').doUpdateSet({ kind: req.body.kind, note: req.body.note ?? null, created_by: principal.id, created_at: now }))
          .execute();
        await writeAudit(trx, { action: 'calendar.set', entity: 'calendar_day', entityId: req.body.date, principal, meta: req.meta, at: now, details: { kind: req.body.kind, note: req.body.note ?? null } });
      });
      return listCalendarDays(db);
    });

    app.delete('/calendar/days/:date', { config: asUser('admin'), schema: { params: dateParam } }, async (req): Promise<CalendarDayDto[]> => {
      const principal = requireUser(req);
      await db.transaction().execute(async (trx) => {
        await trx.deleteFrom('calendar_days').where('day', '=', req.params.date).execute();
        await writeAudit(trx, { action: 'calendar.clear', entity: 'calendar_day', entityId: req.params.date, principal, meta: req.meta, at: deps.clock(), details: {} });
      });
      return listCalendarDays(db);
    });
  };
