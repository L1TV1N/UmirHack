import { dishCode, DISHES } from '../db/seed/data';
import { POS_PRESETS } from '../modules/pos/presets';
import { makeRng } from './engine';

/**
 * Имитация кассы: присылает в «Запас» чеки в формате выбранной кассы. Показывает приём чеков, неопознанные позиции и возвраты
 * без настоящей кассы. Ключ выдаётся в «Администрирование → Кассы».
 *
 * Запуск: npm run emulate:pos -- --key zk_... --vendor evotor
 */

const HELP = `Имитация кассы для «Запаса»

Параметры (или переменные окружения в скобках):
  --key       ключ кассы из «Администрирование → Кассы» (EMULATE_POS_KEY), обязательный
  --url       адрес приложения (EMULATE_URL), по умолчанию http://localhost:3000
  --vendor    evotor | frontol | atol | iiko | sigma | generic, по умолчанию evotor
  --every     раз в сколько секунд присылать чек, по умолчанию 3
  --count     остановиться после стольких чеков, по умолчанию пока не остановят (Ctrl+C)
  --products  продавать упакованные продукты по штрихкодам (для магазина), а не блюда (для кухни)
  --unknown   доля чеков с неизвестной позицией от 0 до 1, по умолчанию 0.15
  --returns   доля возвратов от 0 до 1, по умолчанию 0.08
  --seed      число для повторяемой ленты
`;

type Vendor = keyof typeof POS_PRESETS;

function parse(argv: string[], env: NodeJS.ProcessEnv) {
  const raw = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string;
    if (arg === '--help' || arg === '-h') return null;
    if (!arg.startsWith('--')) throw new Error(`Неизвестный аргумент «${arg}»`);
    if (arg === '--products') {
      raw.set('products', '1');
      continue;
    }
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) throw new Error(`Для ${arg} не указано значение`);
    raw.set(arg.slice(2), v);
    i += 1;
  }
  const known = new Set(['key', 'url', 'vendor', 'every', 'count', 'unknown', 'returns', 'seed', 'products']);
  for (const k of raw.keys()) if (!known.has(k)) throw new Error(`Неизвестный параметр --${k}`);
  const key = raw.get('key') || env.EMULATE_POS_KEY || '';
  if (!key) throw new Error('Не указан ключ кассы (--key)');
  const vendor = (raw.get('vendor') ?? 'evotor') as Vendor;
  if (!(vendor in POS_PRESETS)) throw new Error(`Неизвестная касса «${vendor}»`);
  const num = (name: string, fallback: number) => {
    const t = raw.get(name);
    if (t === undefined) return fallback;
    const n = Number(t.replace(',', '.'));
    if (!Number.isFinite(n)) throw new Error(`--${name}: нужно число`);
    return n;
  };
  return {
    key,
    vendor,
    url: (raw.get('url') || env.EMULATE_URL || 'http://localhost:3000').replace(/\/+$/, ''),
    everyMs: num('every', 3) * 1000,
    count: raw.has('count') ? num('count', 0) : null,
    unknown: num('unknown', 0.15),
    returns: num('returns', 0.08),
    seed: num('seed', Date.now() % 1_000_000),
    products: raw.has('products'),
  };
}

interface Pos {
  id: string;
  kind: 'sale' | 'return';
  lines: { code: string; barcode?: string; name: string; quantity: number; price: number }[];
}

/** Один чек в формате выбранной кассы. */
function render(vendor: Vendor, c: Pos): { body: string; type: string } {
  const ret = c.kind === 'return';
  switch (vendor) {
    case 'evotor':
      return { type: 'application/json', body: JSON.stringify({ id: c.id, type: ret ? 'PAYBACK' : 'SELL', number: c.id, body: { positions: c.lines.map((l) => ({ code: l.code, barcode: l.barcode, name: l.name, quantity: l.quantity, price: l.price })) } }) };
    case 'iiko':
      return { type: 'application/json', body: JSON.stringify({ id: c.id, order: { id: c.id, type: ret ? 'RETURN' : 'SALE', items: c.lines.map((l) => ({ product: { code: l.code, name: l.name }, amount: l.quantity, price: l.price })) } }) };
    case 'sigma':
      return { type: 'application/json', body: JSON.stringify({ check: { number: c.id, operation: ret ? 'return' : 'sale', positions: c.lines.map((l) => ({ code: l.code, name: l.name, qty: l.quantity, price: l.price })) } }) };
    case 'frontol':
      return { type: 'text/csv', body: ['Номер чека;Тип;Код товара;Штрихкод;Наименование;Количество;Цена', ...c.lines.map((l) => `${c.id};${ret ? 'Возврат' : 'Продажа'};${l.code};${l.barcode ?? ''};${l.name};${l.quantity};${l.price}`)].join('\n') };
    case 'atol':
      return { type: 'application/xml', body: `<receipts><receipt id="${c.id}"><type>${ret ? 'return' : 'sell'}</type><items>${c.lines.map((l) => `<item><code>${l.code}</code><name>${l.name}</name><quantity>${l.quantity}</quantity><price>${l.price}</price></item>`).join('')}</items></receipt></receipts>` };
    default:
      return { type: 'application/json', body: JSON.stringify({ externalId: c.id, lines: c.lines.map((l) => ({ code: l.code, name: l.name, quantity: l.quantity, price: l.price })) }) };
  }
}

const log = (t: string) => console.log(`[${new Intl.DateTimeFormat('ru-RU', { timeStyle: 'medium' }).format(new Date())}] ${t}`);

async function main(): Promise<void> {
  const o = parse(process.argv.slice(2), process.env);
  if (!o) return console.log(HELP);
  const rng = makeRng(o.seed);
  const stop = new AbortController();
  process.once('SIGINT', () => stop.abort());
  process.once('SIGTERM', () => stop.abort());
  let menu: { code: string; barcode?: string; name: string; price: number }[] = DISHES.map((d, i) => ({ code: dishCode(i), name: d.name, price: d.price }));
  if (o.products) {
    const res = await fetch(`${o.url}/api/pos/products?limit=200`, { headers: { 'x-api-key': o.key } });
    const feed = (await res.json().catch(() => ({}))) as { items?: { sku: string; barcode: string | null; name: string; price: number; sellable: boolean; isActive: boolean }[] };
    if (!res.ok || !feed.items) throw new Error('Не удалось получить список продуктов кассы: проверьте ключ');
    menu = feed.items.filter((p) => p.sellable && p.isActive && p.price > 0).map((p) => ({ code: p.sku, ...(p.barcode ? { barcode: p.barcode } : {}), name: p.name, price: p.price }));
    if (menu.length === 0) throw new Error('В номенклатуре нет продаваемых продуктов');
  }
  const stamp = Date.now().toString(36);
  let n = 0;
  let sent = 0;
  log(`Имитация кассы «${o.vendor}», чек раз в ${o.everyMs / 1000} с. Остановка по Ctrl+C`);
  while (!stop.signal.aborted && (o.count === null || sent < o.count)) {
    n += 1;
    const lines = Array.from({ length: 1 + Math.floor(rng() * 3) }, () => {
      const d = menu[Math.floor(rng() * menu.length)] as (typeof menu)[number];
      return { code: d.code, ...(d.barcode ? { barcode: d.barcode } : {}), name: d.name, quantity: o.products ? 1 : 1 + Math.floor(rng() * 2), price: d.price };
    });
    if (rng() < o.unknown) lines.push({ code: `NEW-${1 + Math.floor(rng() * 3)}`, name: ['Сезонный десерт', 'Лимонад дня', 'Пакет-майка'][Math.floor(rng() * 3)] as string, quantity: 1, price: 150 });
    const kind = rng() < o.returns ? 'return' : 'sale';
    const { body, type } = render(o.vendor, { id: `EM-${stamp}-${n}`, kind, lines });
    try {
      const res = await fetch(`${o.url}/api/pos/ingest`, { method: 'POST', headers: { 'x-api-key': o.key, 'content-type': type }, body });
      const data = (await res.json().catch(() => ({}))) as { results?: { status: string; unmatched?: string[]; error?: string | null; documentNumber?: string | null }[]; error?: { message?: string } };
      if (!res.ok) log(`Чек ${n} не принят: ${data.error?.message ?? res.status}`);
      else {
        const r = data.results?.[0];
        const text: Record<string, string> = { done: `принят${r?.documentNumber ? `, документ ${r.documentNumber}` : ''}`, pending_match: `ждёт сопоставления (${r?.unmatched?.join(', ')})`, rejected: `отклонён: ${r?.error}`, return_logged: 'возврат записан' };
        log(`Чек ${n}${kind === 'return' ? ' (возврат)' : ''}: ${text[r?.status ?? ''] ?? r?.status}`);
      }
      sent += 1;
    } catch (err) {
      log(`Нет связи с сервером (${(err as Error).message}), повтор через 5 с`);
      await new Promise((r) => setTimeout(r, 5000));
      continue;
    }
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, o.everyMs);
      stop.signal.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
    });
  }
  log(`Готово, отправлено чеков: ${sent}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
