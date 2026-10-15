import { z } from 'zod';

const id = z.uuid();

/** Больше шагов в одном сценарии не нужно: это проверка решения, а не план на неделю. */
export const WHAT_IF_MAX_ACTIONS = 10;

export const WHAT_IF_ACTION_LABELS = {
  writeoff: 'Списать партию',
  receive: 'Принять поставку',
  transfer: 'Переместить партию',
  cook: 'Продать порции блюда',
  demand: 'Изменить скорость продаж',
} as const;
export type WhatIfActionType = keyof typeof WHAT_IF_ACTION_LABELS;

const quantity = z.number().positive().max(1_000_000);

export const whatIfAction = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('writeoff'), batchId: id, quantity: quantity.optional() }),
  z.strictObject({
    type: z.literal('receive'),
    productId: id,
    locationId: id,
    quantity,
    shelfDays: z.number().int().min(0).max(730),
    unitCost: z.number().min(0).max(10_000_000).optional(),
  }),
  z.strictObject({ type: z.literal('transfer'), batchId: id, toLocationId: id, quantity: quantity.optional() }),
  z.strictObject({ type: z.literal('cook'), dishId: id, locationId: id, portions: z.number().int().min(1).max(5000) }),
  z.strictObject({ type: z.literal('demand'), productId: id, locationId: id, factor: z.number().min(0.1).max(5) }),
]);
export type WhatIfAction = z.infer<typeof whatIfAction>;

export const whatIfBody = z.strictObject({
  /** Показатели считаются по этой точке, а без неё по всем доступным. Сами шаги могут касаться любых доступных точек. */
  locationId: id.optional(),
  actions: z.array(whatIfAction).min(1).max(WHAT_IF_MAX_ACTIONS),
});
export type WhatIfBody = z.infer<typeof whatIfBody>;

export interface WhatIfStepDto {
  index: number;
  type: WhatIfActionType;
  ok: boolean;
  /** Что сделано или почему шаг не выполнен. */
  text: string;
  /** Деньги по себестоимости: потеря при списании, стоимость израсходованных продуктов при продаже блюда. */
  cost: number;
}

export interface WhatIfMetricsDto {
  stockValue: number;
  atRiskValue: number;
  expiredValue: number;
  expiringSoonValue: number;
  stopCount: number;
  hotCount: number;
}

export interface WhatIfStopLineDto {
  entityType: 'product' | 'dish';
  entityId: string;
  name: string;
  locationId: string;
  locationName: string;
  reason: string;
}

export interface WhatIfHotLineDto {
  dishId: string;
  dishName: string;
  locationName: string;
  priority: number;
}

export interface WhatIfResultDto {
  /** Всегда false: прогон в сухую ничего не записывает в базу. */
  persisted: false;
  asOf: string;
  steps: WhatIfStepDto[];
  before: WhatIfMetricsDto;
  after: WhatIfMetricsDto;
  /** Позиции, которые попадут в автоматический стоп-лист, и те, что выйдут из него. */
  stopAdded: WhatIfStopLineDto[];
  stopRemoved: WhatIfStopLineDto[];
  hotBefore: WhatIfHotLineDto[];
  hotAfter: WhatIfHotLineDto[];
  /** Чего расчёт не учитывает. */
  notes: string[];
}
