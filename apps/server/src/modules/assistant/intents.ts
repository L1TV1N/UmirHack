import {
  describeDaysLeft,
  formatMoneyWhole,
  formatQty,
  fromMilli,
  hasRole,
  plural,
  type Role,
} from '@zapas/shared';
import { z } from 'zod';
import { stockKey } from '../../domain/stoplist';
import type { Deps, UserPrincipal } from '../../lib/context';
import { getDashboard, getHotDishes, getRecommendations, getRescuedStats, getShortageStats } from '../analytics/service';
import { getSnapshot } from '../analytics/snapshot';
import { getStopForecast, getStopList } from '../stoplist/service';

export interface AnswerBody {
  title: string;
  lines: string[];
  link?: { path: string; label: string };
}

export interface IntentContext {
  deps: Deps;
  principal: UserPrincipal;
  /** Точки, о которых спрашивают: все доступные или одна названная. null означает все. */
  scopeIds: string[] | null;
  /** Одна точка, если вопрос о ней; для сервисов, принимающих только одну точку. */
  locationId: string | undefined;
  /** Название точки для подписи, если вопрос о ней. */
  locationName: string | null;
}

export interface Intent {
  id: string;
  /** Для модели: когда выбирать этот запрос. */
  describe: string;
  /** Для модели: какие параметры бывают. */
  paramsHelp: string;
  min: Role;
  examples: string[];
  parse(raw: unknown): Record<string, unknown> | null;
  run(ctx: IntentContext, params: Record<string, unknown>): Promise<AnswerBody>;
}

const days = z.coerce.number().int().min(1).max(30);
const product = z.string().trim().min(2).max(60);

function define<S extends z.ZodType<Record<string, unknown>>>(i: {
  id: string;
  describe: string;
  paramsHelp: string;
  min: Role;
  examples: string[];
  schema: S;
  run(ctx: IntentContext, params: z.infer<S>): Promise<AnswerBody>;
}): Intent {
  return {
    id: i.id,
    describe: i.describe,
    paramsHelp: i.paramsHelp,
    min: i.min,
    examples: i.examples,
    parse: (raw) => {
      // модель иногда присылает null вместо пустого объекта
      const parsed = i.schema.safeParse(raw ?? {});
      return parsed.success ? parsed.data : null;
    },
    run: (ctx, params) => i.run(ctx, params as z.infer<S>),
  };
}

const none = z.object({}).strip();
const LIMIT = 10;
const more = (shown: number, total: number): string[] => (total > shown ? [`и ещё ${total - shown}`] : []);
const at = (name: string, ctx: IntentContext, place: string): string => (ctx.locationName ? name : `${name} (${place})`);

/** «через 5 ч» или «через 2 дня». */
function eta(hours: number): string {
  if (hours < 1) return 'меньше чем через час';
  if (hours < 24) return `через ${Math.round(hours)} ч`;
  const d = Math.round(hours / 24);
  return `через ${d} ${plural(d, ['день', 'дня', 'дней'])}`;
}

const inScope = (ctx: IntentContext, locationId: string): boolean => !ctx.scopeIds || ctx.scopeIds.includes(locationId);

export const INTENTS: Intent[] = [
  define({
    id: 'summary',
    describe: 'Общая сводка: стоимость склада, деньги под угрозой, просрочка, стоп-лист, что ниже минимума',
    paramsHelp: 'нет',
    min: 'viewer',
    examples: ['Как дела на складе?', 'Дай сводку'],
    schema: none,
    async run(ctx) {
      const k = (await getDashboard(ctx.deps, ctx.principal, ctx.locationId)).kpis;
      return {
        title: ctx.locationName ? `Сводка: ${ctx.locationName}` : 'Сводка по вашим точкам',
        lines: [
          `Склад: ${formatMoneyWhole(k.stockValue)} по себестоимости`,
          `Под угрозой: ${formatMoneyWhole(k.atRiskValue)}`,
          `Истекает скоро: ${k.expiringSoonBatches} ${plural(k.expiringSoonBatches, ['партия', 'партии', 'партий'])} на ${formatMoneyWhole(k.expiringSoonValue)}`,
          `Просрочено: ${k.expiredBatches} ${plural(k.expiredBatches, ['партия', 'партии', 'партий'])} на ${formatMoneyWhole(k.expiredValue)}`,
          `В стоп-листе: ${k.stopListCount}`,
          `Ниже минимального остатка: ${k.lowStockCount}`,
        ],
        link: { path: '/', label: 'Открыть панель' },
      };
    },
  }),
  define({
    id: 'stop_list',
    describe: 'Что сейчас в стоп-листе: блюда и продукты, которые нельзя заказывать, и причины',
    paramsHelp: 'нет',
    min: 'viewer',
    examples: ['Что в стоп-листе?', 'Какие блюда нельзя заказать?'],
    schema: none,
    async run(ctx) {
      const { entries } = await getStopList(ctx.deps, ctx.scopeIds);
      if (entries.length === 0) return { title: 'Стоп-лист пуст', lines: ['Можно заказывать всё меню.'], link: { path: '/stop-list', label: 'Открыть стоп-лист' } };
      return {
        title: `В стоп-листе ${entries.length} ${plural(entries.length, ['позиция', 'позиции', 'позиций'])}`,
        lines: [
          ...entries.slice(0, LIMIT).map((e) => `${at(e.name, ctx, e.locationName)}: ${e.reasons[0]?.text ?? 'нет в наличии'}`),
          ...more(Math.min(LIMIT, entries.length), entries.length),
        ],
        link: { path: '/stop-list', label: 'Открыть стоп-лист' },
      };
    },
  }),
  define({
    id: 'stop_forecast',
    describe: 'Какие блюда скоро закончатся и когда, если не будет новых поставок',
    paramsHelp: 'нет',
    min: 'viewer',
    examples: ['Что скоро закончится?', 'Какие блюда уйдут в стоп?'],
    schema: none,
    async run(ctx) {
      const list = await getStopForecast(ctx.deps, ctx.principal, ctx.locationId);
      if (list.length === 0) return { title: 'Ближайшие часы блюда не закончатся', lines: ['По прогнозу продаж остатков хватает.'], link: { path: '/stop-list', label: 'Открыть прогноз' } };
      return {
        title: `Скоро закончатся: ${list.length}`,
        lines: [
          ...list.slice(0, LIMIT).map((f) => {
            const why = f.cause === 'expiry' ? 'истечёт срок' : `не хватит ${f.limiting.productName}`;
            const delivery = f.incoming ? `, едет поставка ${f.incoming.arrivesOn.split('-').reverse().join('.')}` : '';
            return `${at(f.dishName, ctx, f.locationName)}: ${eta(f.hoursLeft)} (${why}${delivery})`;
          }),
          ...more(Math.min(LIMIT, list.length), list.length),
        ],
        link: { path: '/stop-list', label: 'Открыть прогноз' },
      };
    },
  }),
  define({
    id: 'risks',
    describe: 'Что требует действий: что списать, уценить, переместить, продвинуть; деньги под угрозой',
    paramsHelp: 'нет',
    min: 'viewer',
    examples: ['Что нужно списать?', 'Что делать с истекающим?'],
    schema: none,
    async run(ctx) {
      const all = (await getRecommendations(ctx.deps, ctx.principal, ctx.locationId)).items.filter((r) => r.type !== 'reorder');
      if (all.length === 0) return { title: 'Срочных действий нет', lines: ['Ничего не требует списания, уценки или перемещения.'], link: { path: '/recommendations', label: 'Рекомендации' } };
      const sum = all.reduce((s, r) => s + r.atRiskValue, 0);
      return {
        title: `Требует действий: ${all.length}, под угрозой ${formatMoneyWhole(sum)}`,
        lines: [...all.slice(0, 6).map((r) => `${r.headline} (${r.locationName})`), ...more(Math.min(6, all.length), all.length)],
        link: { path: '/recommendations', label: 'Открыть рекомендации' },
      };
    },
  }),
  define({
    id: 'reorder',
    describe: 'Что пора заказать у поставщиков, потому что остаток скоро закончится',
    paramsHelp: 'нет',
    min: 'viewer',
    examples: ['Что заказать?', 'Что пора закупить?'],
    schema: none,
    async run(ctx) {
      const list = (await getRecommendations(ctx.deps, ctx.principal, ctx.locationId, 'reorder')).items;
      if (list.length === 0) return { title: 'Заказывать пока нечего', lines: ['Остатков хватает до следующей поставки.'], link: { path: '/orders', label: 'Заказы' } };
      return {
        title: `Пора заказать: ${list.length}`,
        lines: [
          ...list.slice(0, 8).map((r) => `${at(r.productName, ctx, r.locationName)}: около ${formatQty(r.reorder?.suggestedQty ?? r.quantity, r.unit)}${r.reorder?.daysToZero != null ? `, закончится через ${r.reorder.daysToZero} дн.` : ''}`),
          ...more(Math.min(8, list.length), list.length),
        ],
        link: { path: '/orders', label: 'Открыть заказы' },
      };
    },
  }),
  define({
    id: 'hot_dishes',
    describe: 'Какие блюда стоит продвигать, чтобы не пропали продукты с близким сроком',
    paramsHelp: 'нет',
    min: 'viewer',
    examples: ['Что продвигать?', 'Какие блюда предлагать гостям?'],
    schema: none,
    async run(ctx) {
      const list = (await getHotDishes(ctx.deps, ctx.principal, ctx.locationId)).items;
      if (list.length === 0) return { title: 'Продвигать пока нечего', lines: ['Сроки ингредиентов не поджимают.'], link: { path: '/hot-dishes', label: 'Горячие предложения' } };
      return {
        title: `Предложите гостям: ${list.length}`,
        lines: [
          ...list.slice(0, 5).map((d) => `${at(d.dishName, ctx, d.locationName)}: продать около ${d.portionsToPush} порц., приоритет ${d.priority}`),
          ...more(Math.min(5, list.length), list.length),
        ],
        link: { path: '/hot-dishes', label: 'Открыть горячие предложения' },
      };
    },
  }),
  define({
    id: 'expiring',
    describe: 'Какие партии скоро истекают (срок годности заканчивается в ближайшие дни)',
    paramsHelp: 'days: за сколько суток смотреть, число от 1 до 30, по умолчанию 3',
    min: 'viewer',
    examples: ['Что истекает за 5 дней?', 'Что скоро испортится?'],
    schema: z.object({ days: days.optional() }).strip(),
    async run(ctx, p) {
      const horizon = p.days ?? 3;
      const snap = await getSnapshot(ctx.deps, ctx.scopeIds);
      const list = snap.batches
        .filter((b) => inScope(ctx, b.locationId) && b.daysLeft >= 0 && b.daysLeft <= horizon)
        .sort((a, b) => a.daysLeft - b.daysLeft || b.remainingMilli * b.unitCost - a.remainingMilli * a.unitCost);
      const label = horizon === 1 ? 'до завтра' : `ближайшие ${horizon} ${plural(horizon, ['день', 'дня', 'дней'])}`;
      if (list.length === 0) return { title: `В ${label} ничего не истекает`, lines: [], link: { path: '/stock', label: 'Остатки' } };
      const value = list.reduce((s, b) => s + fromMilli(b.remainingMilli) * b.unitCost, 0);
      return {
        title: `Истекает за ${label}: ${list.length} ${plural(list.length, ['партия', 'партии', 'партий'])} на ${formatMoneyWhole(value)}`,
        lines: [
          ...list.slice(0, LIMIT).map((b) => {
            const p2 = snap.products.get(b.productId);
            return `${p2?.name ?? 'Продукт'}${ctx.locationName ? '' : ` (${snap.locations.get(b.locationId)?.name ?? '-'})`}: ${formatQty(fromMilli(b.remainingMilli), p2?.unit)}, ${describeDaysLeft(b.daysLeft)}`;
          }),
          ...more(Math.min(LIMIT, list.length), list.length),
        ],
        link: { path: '/stock?status=expiring', label: 'Открыть остатки' },
      };
    },
  }),
  define({
    id: 'expired',
    describe: 'Что уже просрочено и ждёт списания',
    paramsHelp: 'нет',
    min: 'viewer',
    examples: ['Что просрочено?', 'Что пора списать по сроку?'],
    schema: none,
    async run(ctx) {
      const snap = await getSnapshot(ctx.deps, ctx.scopeIds);
      const list = snap.batches.filter((b) => inScope(ctx, b.locationId) && b.daysLeft < 0).sort((a, b) => a.daysLeft - b.daysLeft);
      if (list.length === 0) return { title: 'Просрочки нет', lines: [], link: { path: '/stock', label: 'Остатки' } };
      const value = list.reduce((s, b) => s + fromMilli(b.remainingMilli) * b.unitCost, 0);
      return {
        title: `Просрочено: ${list.length} ${plural(list.length, ['партия', 'партии', 'партий'])} на ${formatMoneyWhole(value)}`,
        lines: [
          ...list.slice(0, LIMIT).map((b) => {
            const p2 = snap.products.get(b.productId);
            return `${p2?.name ?? 'Продукт'}${ctx.locationName ? '' : ` (${snap.locations.get(b.locationId)?.name ?? '-'})`}: ${formatQty(fromMilli(b.remainingMilli), p2?.unit)}, ${describeDaysLeft(b.daysLeft)}`;
          }),
          ...more(Math.min(LIMIT, list.length), list.length),
        ],
        link: { path: '/stock?status=expired', label: 'Открыть остатки' },
      };
    },
  }),
  define({
    id: 'low_stock',
    describe: 'Какие продукты ниже минимального остатка',
    paramsHelp: 'нет',
    min: 'viewer',
    examples: ['Что ниже минимума?', 'Чего мало на складе?'],
    schema: none,
    async run(ctx) {
      const snap = await getSnapshot(ctx.deps, ctx.scopeIds);
      const rows: { name: string; place: string; have: number; min: number; unit: Parameters<typeof formatQty>[1] }[] = [];
      for (const pair of snap.tracked) {
        const [productId, locationId] = pair.split('|');
        if (!productId || !locationId || !inScope(ctx, locationId)) continue;
        const p = snap.products.get(productId);
        const l = snap.locations.get(locationId);
        if (!p?.isActive || !l?.isActive || p.minStock <= 0) continue;
        const have = fromMilli(snap.stock.get(pair)?.availableMilli ?? 0);
        if (have <= p.minStock) rows.push({ name: p.name, place: l.name, have, min: p.minStock, unit: p.unit });
      }
      rows.sort((a, b) => a.have / a.min - b.have / b.min);
      if (rows.length === 0) return { title: 'Всё выше минимума', lines: [], link: { path: '/stock', label: 'Остатки' } };
      return {
        title: `Ниже минимального остатка: ${rows.length}`,
        lines: [...rows.slice(0, LIMIT).map((r) => `${at(r.name, ctx, r.place)}: ${formatQty(r.have, r.unit)}, минимум ${formatQty(r.min, r.unit)}`), ...more(Math.min(LIMIT, rows.length), rows.length)],
        link: { path: '/stock?status=low', label: 'Открыть остатки' },
      };
    },
  }),
  define({
    id: 'stock_of',
    describe: 'Сколько осталось конкретного продукта и где он лежит',
    paramsHelp: 'product: название продукта как в вопросе (например, "молоко"), обязательно',
    min: 'viewer',
    examples: ['Сколько осталось молока?', 'Есть ли говядина на кухне?'],
    schema: z.object({ product }).strip(),
    async run(ctx, p) {
      const snap = await getSnapshot(ctx.deps, ctx.scopeIds);
      const term = p.product.toLowerCase().replace(/ё/g, 'е');
      // «молока» и «молоко» отличаются окончанием, поэтому ищем и по началу слова
      const stem = term.length > 5 ? term.slice(0, Math.max(4, term.length - 2)) : term;
      const norm = (s: string) => s.toLowerCase().replace(/ё/g, 'е');
      const found = [...snap.products.values()].filter((x) => x.isActive && (norm(x.name).includes(term) || norm(x.name).includes(stem)));
      if (found.length === 0) return { title: `Продукт «${p.product}» не найден`, lines: ['Проверьте название или откройте остатки.'], link: { path: '/stock', label: 'Остатки' } };
      const lines: string[] = [];
      for (const prod of found.slice(0, 5)) {
        const parts: string[] = [];
        for (const [id, loc] of snap.locations) {
          if (!inScope(ctx, id)) continue;
          const point = snap.stock.get(stockKey(prod.id, id));
          if (!point || point.onHandMilli <= 0) continue;
          const expired = point.onHandMilli - point.availableMilli;
          parts.push(`${loc.name} ${formatQty(fromMilli(point.availableMilli), prod.unit)}${expired > 0 ? ` (просрочено ${formatQty(fromMilli(expired), prod.unit)})` : ''}`);
        }
        lines.push(`${prod.name}: ${parts.length ? parts.join(', ') : 'нет в наличии'}`);
      }
      return {
        title: found.length === 1 ? (found[0] as { name: string }).name : `Найдено продуктов: ${found.length}`,
        lines: [...lines, ...more(Math.min(5, found.length), found.length)],
        link: { path: '/stock', label: 'Открыть остатки' },
      };
    },
  }),
  define({
    id: 'rescued',
    describe: 'Сколько удалось спасти уценкой: выручка с товара, который иначе бы списали',
    paramsHelp: 'days: за сколько суток, от 1 до 30, по умолчанию 30',
    min: 'manager',
    examples: ['Сколько спасли уценкой за неделю?'],
    schema: z.object({ days: days.optional() }).strip(),
    async run(ctx, p) {
      const r = await getRescuedStats(ctx.deps, ctx.principal, ctx.locationId, p.days ?? 30);
      if (r.batches === 0) return { title: `За ${r.days} дн. уценённых продаж нет`, lines: [], link: { path: '/', label: 'Открыть панель' } };
      return {
        title: `Спасено за ${r.days} дн.: ${formatMoneyWhole(r.revenue)}`,
        lines: [
          `Это ${r.batches} ${plural(r.batches, ['партия', 'партии', 'партий'])}; по себестоимости ${formatMoneyWhole(r.cost)} не пропали при списании`,
          `Скидками отдано ${formatMoneyWhole(r.discountGiven)}`,
          ...r.products.slice(0, 3).map((x) => `${x.productName}: ${formatMoneyWhole(x.revenue)}`),
        ],
        link: { path: '/', label: 'Открыть панель' },
      };
    },
  }),
  define({
    id: 'shortages',
    describe: 'Каких ингредиентов не хватало и сколько это стоило: простои блюд, отклонённые заказы',
    paramsHelp: 'days: за сколько суток, от 1 до 30, по умолчанию 30',
    min: 'manager',
    examples: ['Чего не хватало за месяц?', 'Сколько потеряли из-за дефицита?'],
    schema: z.object({ days: days.optional() }).strip(),
    async run(ctx, p) {
      const r = await getShortageStats(ctx.deps, ctx.principal, ctx.locationId, p.days ?? 30);
      if (r.ingredients.length === 0) return { title: `За ${r.days} дн. дефицита не было`, lines: [], link: { path: '/', label: 'Открыть панель' } };
      return {
        title: `Дефицит за ${r.days} дн.: недополучено ${formatMoneyWhole(r.totals.lostRevenue)}`,
        lines: [
          `Отклонено заказов: ${r.totals.refusedOrders}, простоев: ${r.totals.episodes}`,
          ...r.ingredients.slice(0, 5).map((i) => `${i.productName}: ${Math.round(i.hours)} ч без остатка, блюд заблокировано ${i.dishesBlocked}`),
        ],
        link: { path: '/', label: 'Открыть панель' },
      };
    },
  }),
];

export const INTENT_BY_ID = new Map(INTENTS.map((i) => [i.id, i]));

/** Запросы, доступные роли. */
export const intentsFor = (role: Role): Intent[] => INTENTS.filter((i) => hasRole(role, i.min));
