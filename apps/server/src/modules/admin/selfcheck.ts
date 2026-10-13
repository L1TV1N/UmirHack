import { isValidGtin, type SelfCheckDto, type SelfCheckItemDto } from '@zapas/shared';
import { sql } from 'kysely';
import type { Deps } from '../../lib/context';
import { businessToday } from '../../lib/time';
import { verifyAuditChain } from '../audit/audit';
import { getSettings } from '../settings/settings';

type Status = SelfCheckItemDto['status'];
const MINUTE = 60_000;

/** Быстрая проверка, что система собрана и работает: каждый пункт читает только состояние и ничего не меняет. */
export async function runSelfCheck(deps: Deps): Promise<SelfCheckDto> {
  const items: SelfCheckItemDto[] = [];
  const add = (id: string, group: string, title: string, status: Status, detail: string) => items.push({ id, group, title, status, detail });
  const guard = async (id: string, group: string, title: string, fn: () => Promise<[Status, string]>) => {
    try {
      const [status, detail] = await fn();
      add(id, group, title, status, detail);
    } catch (err) {
      add(id, group, title, 'fail', err instanceof Error ? err.message.slice(0, 200) : 'Сбой проверки');
    }
  };
  const now = deps.clock();
  const today = businessToday(deps);
  const count = async (table: 'products' | 'locations' | 'dishes' | 'api_keys' | 'suppliers', where?: string) => {
    const r = await sql<{ n: string }>`select count(*)::text as n from ${sql.table(table)} ${where ? sql.raw(`where ${where}`) : sql``}`.execute(deps.db);
    return Number(r.rows[0]?.n ?? 0);
  };

  await guard('db', 'Основа', 'База данных', async () => {
    const t0 = Date.now();
    await sql`select 1`.execute(deps.db);
    return ['ok', `Отвечает за ${Date.now() - t0} мс`];
  });
  await guard('audit', 'Основа', 'Журнал аудита', async () => {
    const v = await verifyAuditChain(deps.db);
    return v.ok ? ['ok', `Цепочка контрольных сумм цела, записей ${v.checked}`] : ['fail', 'Цепочка нарушена: записи журнала менялись'];
  });
  await guard('scheduler', 'Основа', 'Планировщик', async () => {
    if (!deps.config.scheduler) return ['warn', 'Выключен настройкой SCHEDULER'];
    const r = await deps.db.selectFrom('stoplist_published').select((eb) => eb.fn.max('published_at').as('at')).executeTakeFirst();
    const at = r?.at ? new Date(r.at as unknown as string) : null;
    return at && now.getTime() - at.getTime() < 10 * MINUTE ? ['ok', 'Стоп-лист пересчитывается регулярно'] : ['warn', 'Недавних пересчётов стоп-листа не видно: подождите минуту и повторите'];
  });

  await guard('locations', 'Данные', 'Точки', async () => {
    const n = await count('locations', 'is_active');
    return n > 0 ? ['ok', `Активных точек: ${n}`] : ['fail', 'Нет ни одной активной точки'];
  });
  await guard('products', 'Данные', 'Номенклатура', async () => {
    const n = await count('products', 'is_active');
    return n > 0 ? ['ok', `Активных продуктов: ${n}`] : ['fail', 'Номенклатура пуста'];
  });
  await guard('barcodes', 'Данные', 'Штрихкоды продуктов', async () => {
    const rows = await deps.db.selectFrom('products').select('barcode').where('is_active', '=', true).where('barcode', 'is not', null).execute();
    const bad = rows.filter((r) => r.barcode && !isValidGtin(r.barcode)).length;
    if (rows.length === 0) return ['warn', 'Ни у одного продукта нет штрихкода, сканер нечем проверить'];
    return bad === 0 ? ['ok', `Штрихкодов ${rows.length}, у всех верная контрольная цифра`] : ['warn', `Штрихкодов ${rows.length}, с неверной контрольной цифрой ${bad}: сканер их не примет`];
  });
  await guard('dishes', 'Данные', 'Блюда и рецептуры', async () => {
    const n = await count('dishes', 'is_active');
    const empty = (await sql<{ n: string }>`select count(*)::text n from dishes d where is_active and not exists (select 1 from dish_items i where i.dish_id = d.id)`.execute(deps.db)).rows[0]?.n;
    if (n === 0) return ['warn', 'Блюд нет: заказ гостя и горячие предложения не покажут ничего'];
    return Number(empty) > 0 ? ['warn', `Блюд ${n}, без рецептуры ${empty}`] : ['ok', `Блюд ${n}, у всех есть рецептура`];
  });
  await guard('expiry', 'Данные', 'Сроки годности', async () => {
    const r = await sql<{ expired: string; soon: string }>`
      select count(*) filter (where expires_on < ${today}::date)::text as expired,
             count(*) filter (where expires_on >= ${today}::date and expires_on <= ${today}::date + 3)::text as soon
      from batches where remaining_qty > 0`.execute(deps.db);
    const { expired, soon } = r.rows[0] ?? { expired: '0', soon: '0' };
    return ['ok', `Просроченных партий с остатком ${expired}, истекают в ближайшие 3 дня ${soon}`];
  });
  await guard('ledger', 'Данные', 'Остатки сходятся с журналом движений', async () => {
    const r = await sql<{ n: string }>`
      select count(*)::text n from (
        select b.id from batches b left join stock_movements m on m.batch_id = b.id
        group by b.id, b.remaining_qty having abs(b.remaining_qty - coalesce(sum(m.quantity), 0)) > 0.0005) x`.execute(deps.db);
    const n = Number(r.rows[0]?.n ?? 0);
    return n === 0 ? ['ok', 'Остаток каждой партии равен сумме её движений'] : ['fail', `Не сходится партий: ${n}`];
  });

  await guard('autowriteoff', 'Настройки', 'Автосписание просрочки', async () => {
    const s = await getSettings(deps.db);
    return s.autoWriteoffExpired ? ['ok', 'Включено: просроченное списывается раз в сутки'] : ['warn', 'Выключено: просроченное списывается вручную'];
  });
  await guard('telegram', 'Настройки', 'Telegram', async () => (deps.notifier.enabled ? ['ok', 'Подключён'] : ['warn', 'Не подключён: сводки и бот не работают']));
  await guard('smtp', 'Настройки', 'Почта для заказов', async () => (deps.mailer ? ['ok', 'SMTP подключён'] : ['warn', 'SMTP не настроен: заказ уходит без письма']));
  await guard('weather', 'Настройки', 'Погода для прогноза', async () => (deps.weather ? ['ok', 'Загрузка включена'] : ['warn', 'Выключена: прогноз без погоды']));
  await guard('photo', 'Настройки', 'Распознавание фото накладной', async () => (deps.invoiceReader ? ['ok', 'Включено'] : ['warn', 'Ключ не задан: работает только УПД в XML']));

  await guard('pos', 'Интеграции', 'Кассы', async () => {
    const keys = await deps.db.selectFrom('api_keys').select(['name', 'last_used_at']).where('revoked_at', 'is', null).execute();
    if (keys.length === 0) return ['warn', 'Касс не подключено'];
    const silent = keys.filter((k) => !k.last_used_at || now.getTime() - k.last_used_at.getTime() > 6 * 3_600_000);
    return silent.length === 0 ? ['ok', `Касс ${keys.length}, все присылали чеки за последние 6 часов`] : ['warn', `Касс ${keys.length}, давно не присылали чеки: ${silent.map((k) => k.name).join(', ')}`];
  });
  await guard('exchange', 'Интеграции', 'Обмен с 1С', async () => {
    const sys = await deps.db.selectFrom('external_systems').select(['name', 'enabled', 'last_error']).execute();
    if (sys.length === 0) return ['warn', 'Не подключён'];
    const bad = sys.filter((s) => s.enabled && s.last_error);
    const stuck = await deps.db.selectFrom('exchange_jobs').select((eb) => eb.fn.countAll<string>().as('n')).where('status', 'in', ['blocked', 'failed']).executeTakeFirst();
    const waiting = Number(stuck?.n ?? 0);
    if (bad.length > 0) return ['fail', `Ошибка обмена: ${bad.map((s) => `${s.name}: ${s.last_error}`).join('; ')}`.slice(0, 220)];
    return waiting > 0 ? ['warn', `Подключений ${sys.length}, документов ждут связей или не ушли: ${waiting}`] : ['ok', `Подключений ${sys.length}, очередь пуста`];
  });
  await guard('webhooks', 'Интеграции', 'Вебхуки', async () => {
    const hooks = await deps.db.selectFrom('webhook_endpoints').select(['name', 'enabled', 'disabled_reason']).execute();
    if (hooks.length === 0) return ['warn', 'Адресов нет'];
    const off = hooks.filter((h) => !h.enabled);
    return off.length === 0 ? ['ok', `Адресов ${hooks.length}, все включены`] : ['warn', `Выключены сами или вручную: ${off.map((h) => h.name).join(', ')}`];
  });

  return { checkedAt: now.toISOString(), items };
}
