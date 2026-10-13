import { addDays, inHaccpRange } from '@zapas/shared';
import { createHash } from 'node:crypto';
import type { Transaction } from 'kysely';
import type { Database } from '../types';

/** Псевдослучайное число от 0 до 1, одно и то же для одной строки. */
const unit = (seed: string) => parseInt(createHash('sha1').update(seed).digest('hex').slice(0, 8), 16) / 0xffffffff;

interface PointSpec {
  key: string;
  location: string;
  name: string;
  kind: 'fridge' | 'freezer' | 'hot';
  min: number;
  max: number;
  every: number;
  /** Часы суток, когда делают замер. */
  hours: number[];
}

const POINTS: PointSpec[] = [
  { key: 'meat', location: 'kit', name: 'Холодильник: мясо и рыба', kind: 'fridge', min: 0, max: 4, every: 4, hours: [8, 12, 16, 20] },
  { key: 'dairy', location: 'kit', name: 'Холодильник: молочные продукты', kind: 'fridge', min: 0, max: 6, every: 4, hours: [8, 12, 16, 20] },
  { key: 'freezer', location: 'kit', name: 'Морозильная камера', kind: 'freezer', min: -24, max: -18, every: 8, hours: [8, 16] },
  { key: 'hot', location: 'kit', name: 'Линия раздачи, горячее', kind: 'hot', min: 65, max: 95, every: 2, hours: [11, 13, 15, 17, 19, 21] },
  { key: 'showC', location: 'shopC', name: 'Витрина молочной продукции', kind: 'fridge', min: 0, max: 6, every: 4, hours: [9, 13, 17, 21] },
  { key: 'chestC', location: 'shopC', name: 'Морозильный ларь', kind: 'freezer', min: -24, max: -18, every: 8, hours: [9, 17] },
  { key: 'showN', location: 'shopN', name: 'Витрина молочной продукции', kind: 'fridge', min: 0, max: 6, every: 4, hours: [9, 13, 17, 21] },
];

interface Deviation {
  point: string;
  daysAgo: number;
  hour: number;
  value: number;
  action: string | null;
}

/** Отклонения за две недели. Почти по всем записано действие, одно сегодняшнее остаётся открытым. */
const DEVIATIONS: Deviation[] = [
  { point: 'dairy', daysAgo: 11, hour: 12, value: 8.5, action: 'Дверь была не закрыта, продукты проверены, температура вернулась через час' },
  { point: 'freezer', daysAgo: 9, hour: 16, value: -14, action: 'Вызван мастер, продукты перенесены в запасную камеру' },
  { point: 'showC', daysAgo: 6, hour: 21, value: 9, action: 'Витрину разгрузили, отрегулирован термостат' },
  { point: 'hot', daysAgo: 3, hour: 13, value: 58, action: 'Подогрев доведён до 80 °C, блюда догреты и проверены' },
  { point: 'meat', daysAgo: 1, hour: 20, value: 5.5, action: 'Загрузка была слишком плотной, часть продуктов переложена' },
];

const at = (date: string, hour: number, minute = 0) => new Date(`${date}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00+03:00`);

/**
 * Журнал HACCP для демонстрации: контрольные точки, две недели замеров с отклонениями и осмотры недавних партий.
 * Одна точка (витрина «Северного») давно без замера, чтобы был виден просроченный контроль, а одно отклонение сегодня
 * открыто: по нему ещё нужно записать действие.
 */
export async function seedHaccp(trx: Transaction<Database>, locations: Record<string, string>, now: Date, today: string): Promise<void> {
  const created = at(addDays(today, -14), 7);
  const ids = new Map<string, string>();
  for (const p of POINTS) {
    const row = await trx
      .insertInto('haccp_points')
      .values({ location_id: locations[p.location] as string, name: p.name, kind: p.kind, min_temp: p.min, max_temp: p.max, every_hours: p.every, created_at: created })
      .returning('id')
      .executeTakeFirstOrThrow();
    ids.set(p.key, row.id);
  }

  const keeper = 'Козлов Андрей Николаевич';
  const rows: { point_id: string; location_id: string; measured_at: Date; value: number; min_temp: number; max_temp: number; in_range: boolean; comment: string | null; created_by: null; actor_name: string; created_at: Date }[] = [];
  const deviations = new Map<string, Deviation>();
  for (const d of DEVIATIONS) deviations.set(`${d.point}|${addDays(today, -d.daysAgo)}|${d.hour}`, d);

  for (let back = 14; back >= 0; back -= 1) {
    const date = addDays(today, -back);
    for (const p of POINTS) {
      // витрина «Северного» последние сутки без замеров
      if (p.key === 'showN' && back < 1) continue;
      for (const hour of p.hours) {
        const when = at(date, hour, Math.floor(unit(`m:${p.key}:${date}:${hour}`) * 20));
        if (when.getTime() > now.getTime() - 40 * 60_000) continue;
        const dev = deviations.get(`${p.key}|${date}|${hour}`);
        const mid = (p.min + p.max) / 2;
        const spread = (p.max - p.min) * 0.3;
        const value = dev ? dev.value : Math.round((mid + (unit(`v:${p.key}:${date}:${hour}`) - 0.5) * 2 * spread) * 10) / 10;
        rows.push({
          point_id: ids.get(p.key) as string,
          location_id: locations[p.location] as string,
          measured_at: when,
          value,
          min_temp: p.min,
          max_temp: p.max,
          in_range: inHaccpRange(value, p.min, p.max),
          comment: null,
          created_by: null,
          actor_name: keeper,
          created_at: when,
        });
      }
    }
  }
  // открытое отклонение сегодня: холодильник с мясом чуть выше нормы, действия ещё нет
  const open = new Date(now.getTime() - 90 * 60_000);
  const meat = POINTS[0] as PointSpec;
  rows.push({ point_id: ids.get('meat') as string, location_id: locations.kit as string, measured_at: open, value: 6.5, min_temp: meat.min, max_temp: meat.max, in_range: false, comment: 'После загрузки поставки', created_by: null, actor_name: keeper, created_at: open });

  rows.sort((a, b) => a.measured_at.getTime() - b.measured_at.getTime());
  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500);
    const inserted = await trx.insertInto('haccp_readings').values(chunk).returning(['id', 'point_id', 'measured_at']).execute();
    const actions = inserted.flatMap((r, idx) => {
      const src = chunk[idx];
      if (!src || src.in_range) return [];
      const pointKey = [...ids].find(([, id]) => id === r.point_id)?.[0];
      const dev = DEVIATIONS.find((d) => d.point === pointKey && at(addDays(today, -d.daysAgo), d.hour).getTime() <= r.measured_at.getTime() && r.measured_at.getTime() < at(addDays(today, -d.daysAgo), d.hour, 59).getTime());
      return dev?.action ? [{ reading_id: Number(r.id), action: dev.action, created_by: null, actor_name: keeper, created_at: new Date(r.measured_at.getTime() + 25 * 60_000) }] : [];
    });
    if (actions.length > 0) await trx.insertInto('haccp_actions').values(actions).execute();
  }

  // бракераж: часть недавних скоропортящихся партий осмотрена, часть ждёт
  const batches = await trx
    .selectFrom('batches as b')
    .innerJoin('documents as d', (join) => join.onRef('d.id', '=', 'b.origin_document_id').on('d.kind', '=', 'receipt'))
    .innerJoin('products as p', 'p.id', 'b.product_id')
    .select(['b.id', 'b.location_id', 'b.created_at'])
    .where('p.shelf_life_days', '<=', 10)
    .where('b.received_on', '<', today)
    .orderBy('b.created_at', 'desc')
    .limit(40)
    .execute();
  const done = batches.slice(0, 14);
  await trx
    .insertInto('haccp_inspections')
    .values(
      done.map((b, i) => {
        const rejected = i === 5;
        return {
          batch_id: b.id,
          location_id: b.location_id,
          temperature: Math.round((2 + unit(`t:${b.id}`) * 3) * 10) / 10,
          appearance_ok: !rejected,
          packaging_ok: true,
          decision: rejected ? ('rejected' as const) : ('accepted' as const),
          comment: rejected ? 'Нарушен внешний вид, поставщику направлена претензия' : null,
          created_by: null,
          actor_name: keeper,
          created_at: new Date(b.created_at.getTime() + 30 * 60_000),
        };
      }),
    )
    .execute();
}
