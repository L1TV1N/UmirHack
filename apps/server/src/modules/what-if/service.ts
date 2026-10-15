import type { StopListDto, WhatIfBody, WhatIfHotLineDto, WhatIfMetricsDto, WhatIfResultDto, WhatIfStopLineDto } from '@zapas/shared';
import { applyActions, stockOf, type Scenario } from '../../domain/what-if';
import type { AutoStop } from '../../domain/stoplist';
import type { Deps, Principal } from '../../lib/context';
import { assertLocation, locationFilter } from '../../lib/scope';
import { businessHour } from '../../lib/time';
import { hotDishesFrom, summarize } from '../analytics/service';
import { getSnapshot, type Snapshot } from '../analytics/snapshot';
import { evaluate } from '../stoplist/service';

const HOT_SHOWN = 5;

const NOTES = [
  'Это прогон в сухую: в базу ничего не записывается, остатки, стоп-лист и журнал не меняются.',
  'Скидки и акции не моделируются: неизвестно, насколько они ускорят продажи. Скорость можно изменить отдельным шагом.',
  'Стоп-лист считается по автоматическим правилам. Ручные снятия с продажи на результат не влияют.',
  'Поставки в пути и прогноз спроса на дни вперёд остаются прежними.',
];

const asStopList = (stops: readonly AutoStop[]): StopListDto => ({
  warnings: [],
  entries: stops.map((s) => ({
    key: `what-if:${s.locationId}:${s.entityType}:${s.entityId}`,
    entityType: s.entityType,
    entityId: s.entityId,
    name: s.name,
    locationId: s.locationId,
    locationName: s.locationName,
    source: 'auto' as const,
    reasons: s.reasons,
    since: '',
    manualId: null,
    until: null,
    createdBy: null,
  })),
});

function metrics(snap: Snapshot, scopeIds: string[] | null, nowHour: number): { metrics: WhatIfMetricsDto; stops: AutoStop[]; hot: WhatIfHotLineDto[] } {
  const inScope = (locationId: string) => !scopeIds || scopeIds.includes(locationId);
  const stops = evaluate(snap).stops.filter((s) => inScope(s.locationId));
  const hot = hotDishesFrom(snap, asStopList(stops), scopeIds, nowHour);
  const sum = summarize(snap, scopeIds);
  return {
    stops,
    hot: hot.slice(0, HOT_SHOWN).map((h) => ({ dishId: h.dishId, dishName: h.dishName, locationName: h.locationName, priority: h.priority })),
    metrics: {
      stockValue: Math.round(sum.stockValue * 100) / 100,
      atRiskValue: Math.round(sum.atRiskValue * 100) / 100,
      expiredValue: Math.round(sum.expiredValue * 100) / 100,
      expiringSoonValue: Math.round(sum.expiringSoonValue * 100) / 100,
      stopCount: stops.length,
      hotCount: hot.length,
    },
  };
}

const keyOf = (s: Pick<AutoStop, 'locationId' | 'entityType' | 'entityId'>) => `${s.locationId}:${s.entityType}:${s.entityId}`;
const lineOf = (s: AutoStop): WhatIfStopLineDto => ({
  entityType: s.entityType,
  entityId: s.entityId,
  name: s.name,
  locationId: s.locationId,
  locationName: s.locationName,
  reason: s.reasons[0]?.text ?? 'Нет в наличии',
});

/**
 * Проигрывает решения на копии данных и показывает, что изменилось. Ничего не пишет: исходный срез из кеша
 * не меняется (партии копируются), поэтому прогон не влияет ни на других пользователей, ни на следующие расчёты.
 */
export async function runWhatIf(deps: Deps, principal: Principal, body: WhatIfBody): Promise<WhatIfResultDto> {
  const allowed = locationFilter(principal);
  if (body.locationId) assertLocation(principal, body.locationId);
  const scopeIds = body.locationId ? [body.locationId] : allowed;
  const snap = await getSnapshot(deps, allowed);
  const nowHour = businessHour(deps);

  const scenario: Scenario = {
    today: snap.today,
    products: snap.products,
    locations: snap.locations,
    dishes: snap.dishes,
    batches: snap.batches.map((b) => ({ ...b })),
    velocities: new Map(snap.velocities),
    tracked: new Set(snap.tracked),
  };
  const { steps } = applyActions(scenario, body.actions);

  // новый объект среза: кеши расчётов привязаны к объекту, поэтому исходный срез и его кеши остаются нетронутыми
  const after: Snapshot = {
    ...snap,
    batches: scenario.batches.filter((b) => b.remainingMilli > 0),
    stock: stockOf(scenario.batches.filter((b) => b.remainingMilli > 0)),
    velocities: scenario.velocities,
    tracked: scenario.tracked,
  };

  const was = metrics(snap, scopeIds, nowHour);
  const now = metrics(after, scopeIds, nowHour);

  const wasKeys = new Set(was.stops.map(keyOf));
  const nowKeys = new Set(now.stops.map(keyOf));
  return {
    persisted: false,
    asOf: deps.clock().toISOString(),
    steps,
    before: was.metrics,
    after: now.metrics,
    stopAdded: now.stops.filter((s) => !wasKeys.has(keyOf(s))).map(lineOf),
    stopRemoved: was.stops.filter((s) => !nowKeys.has(keyOf(s))).map(lineOf),
    hotBefore: was.hot,
    hotAfter: now.hot,
    notes: NOTES,
  };
}
