import { formatQty, type DishDto, type LocationDto, type Page, type ProductDto, type SessionDto, type Unit } from '@zapas/shared';
import { DISHES, USERS } from '../db/seed/data';
import { dailyDemand, makeRng, nextDelay, planOrder, planSupply, type EmuDish, type EmuProduct } from './engine';

/**
 * Генератор событий: имитирует работу кухни через обычный API. Присылает поставки (срок считается по сроку хранения)
 * и заказы гостей на блюда, часть которых упирается в нехватку и получает отказ. Нужен, чтобы показать панель,
 * стоп-лист и горячие предложения «вживую», не вводя документы руками.
 *
 * Запуск: npm run emulate -- --help
 */

const HELP = `Генератор событий для «Запаса»

Параметры (или переменные окружения в скобках):
  --url         адрес приложения (EMULATE_URL), по умолчанию http://localhost:3000
  --email       пользователь не ниже кладовщика (EMULATE_EMAIL), по умолчанию менеджер демо-стенда
  --password    пароль (EMULATE_PASSWORD)
  --location    часть названия кухни, по умолчанию первая кухня
  --speed       во сколько раз чаще события, по умолчанию 1 (заказ раз в 4 с, поставка раз в 30 с)
  --pressure    доля больших заказов, которые упираются в нехватку, от 0 до 1, по умолчанию 0.12
  --duration    сколько минут работать, по умолчанию пока не остановят (Ctrl+C)
  --count       остановиться после стольких событий
  --seed        число для повторяемой ленты событий
`;

interface Options {
  url: string;
  email: string;
  password: string;
  location: string | null;
  speed: number;
  pressure: number;
  durationMin: number | null;
  count: number | null;
  seed: number;
}

const ORDER_EVERY_MS = 4000;
const SUPPLY_EVERY_MS = 30_000;

function parseArgs(argv: string[], env: NodeJS.ProcessEnv): Options | null {
  const raw = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string;
    if (arg === '--help' || arg === '-h') return null;
    if (!arg.startsWith('--')) throw new Error(`Неизвестный аргумент «${arg}»`);
    const eq = arg.indexOf('=');
    if (eq > 0) raw.set(arg.slice(2, eq), arg.slice(eq + 1));
    else {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) throw new Error(`Для ${arg} не указано значение`);
      raw.set(arg.slice(2), value);
      i += 1;
    }
  }
  const known = new Set(['url', 'email', 'password', 'location', 'speed', 'pressure', 'duration', 'count', 'seed']);
  for (const key of raw.keys()) if (!known.has(key)) throw new Error(`Неизвестный параметр --${key}`);

  const number = (key: string, fallback: number | null, min: number, max: number): number | null => {
    const text = raw.get(key);
    if (text === undefined) return fallback;
    const n = Number(text.replace(',', '.'));
    if (!Number.isFinite(n) || n < min || n > max) throw new Error(`--${key}: число от ${min} до ${max}`);
    return n;
  };

  const demoManager = USERS.find((u) => u.role === 'manager');
  return {
    url: (raw.get('url') || env.EMULATE_URL || 'http://localhost:3000').replace(/\/+$/, ''),
    email: raw.get('email') || env.EMULATE_EMAIL || demoManager?.email || '',
    password: raw.get('password') || env.EMULATE_PASSWORD || demoManager?.password || '',
    location: raw.get('location') ?? null,
    speed: number('speed', 1, 0.05, 100) as number,
    pressure: number('pressure', 0.12, 0, 1) as number,
    durationMin: number('duration', null, 0.05, 100_000),
    count: number('count', null, 1, 10_000_000),
    seed: number('seed', Date.now() % 1_000_000, 0, 4_294_967_295) as number,
  };
}

class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

class Client {
  private token: string | null = null;
  constructor(
    private readonly base: string,
    private readonly email: string,
    private readonly password: string,
  ) {}

  async login(): Promise<SessionDto> {
    const res = await fetch(`${this.base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: this.email, password: this.password }),
    });
    const data = (await res.json().catch(() => ({}))) as SessionDto & { error?: { message?: string } };
    if (!res.ok) throw new ApiError(res.status, 'login_failed', data.error?.message ?? 'Не удалось войти');
    this.token = data.accessToken;
    return data;
  }

  async request<T>(method: 'GET' | 'POST', path: string, body?: unknown, key?: string, retry = true): Promise<T> {
    const res = await fetch(`${this.base}/api${path}`, {
      method,
      headers: {
        ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(key ? { 'idempotency-key': key } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    if (res.status === 401 && retry) {
      // токен доступа живёт недолго
      await this.login();
      return this.request<T>(method, path, body, key, false);
    }
    const data = (await res.json().catch(() => ({}))) as T & { error?: { code?: string; message?: string; details?: unknown } };
    if (!res.ok) throw new ApiError(res.status, data.error?.code ?? 'http_error', data.error?.message ?? `Ответ ${res.status}`, data.error?.details);
    return data;
  }
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done);
  });

const clock = () => new Intl.DateTimeFormat('ru-RU', { timeStyle: 'medium' }).format(new Date());
const log = (text: string) => console.log(`[${clock()}] ${text}`);
const unitLabel = (qty: number, unit: Unit) => formatQty(qty, unit);

async function loadAll<T>(client: Client, path: string): Promise<T[]> {
  const items: T[] = [];
  for (let offset = 0; ; offset += 200) {
    const page = await client.request<Page<T>>('GET', `${path}${path.includes('?') ? '&' : '?'}limit=200&offset=${offset}`);
    items.push(...page.items);
    if (items.length >= page.total || page.items.length === 0) return items;
  }
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2), process.env);
  if (!opts) {
    console.log(HELP);
    return;
  }
  const client = new Client(opts.url, opts.email, opts.password);
  const session = await client.login();
  log(`Вход выполнен: ${session.user.fullName}`);

  const locations = await client.request<LocationDto[]>('GET', '/locations');
  const kitchens = locations.filter((l) => l.kind === 'kitchen' && l.isActive);
  const kitchen = opts.location ? kitchens.find((l) => l.name.toLowerCase().includes((opts.location as string).toLowerCase())) : kitchens[0];
  if (!kitchen) throw new Error(opts.location ? `Кухня «${opts.location}» не найдена` : 'В системе нет активной кухни');

  const popularity = new Map(DISHES.map((d) => [d.name, d.perDay]));
  const dishes: EmuDish[] = (await client.request<DishDto[]>('GET', '/dishes'))
    .filter((d) => d.isActive && d.items.length > 0)
    .map((d) => ({ id: d.id, name: d.name, perDay: popularity.get(d.name) ?? 10, items: d.items.map((i) => ({ productId: i.productId, quantity: i.quantity })) }));
  if (dishes.length === 0) throw new Error('В системе нет блюд с рецептурами. Загрузите демо-данные: npm run seed');

  const demand = dailyDemand(dishes);
  const products = new Map<string, EmuProduct>(
    (await loadAll<ProductDto>(client, '/products?active=true'))
      .filter((p) => demand.has(p.id))
      .map((p) => [p.id, { id: p.id, name: p.name, unit: p.unit, cost: p.cost, shelfLifeDays: p.shelfLifeDays, packSize: p.packSize }]),
  );
  log(`${kitchen.name}: блюд ${dishes.length}, ингредиентов ${products.size}. Стартуем (seed ${opts.seed}), остановка по Ctrl+C`);

  const rng = makeRng(opts.seed);
  const stop = new AbortController();
  process.once('SIGINT', () => stop.abort());
  process.once('SIGTERM', () => stop.abort());
  const deadline = opts.durationMin ? Date.now() + opts.durationMin * 60_000 : Number.POSITIVE_INFINITY;

  const stats = { supplies: 0, orders: 0, refused: 0, failed: 0 };
  let supplyNo = 0;
  let sequence = 0;
  const key = (kind: string) => `emu-${kind}-${opts.seed}-${(sequence += 1)}-${Date.now()}`;

  const supply = async () => {
    const plan = planSupply(rng, products, demand);
    if (!plan) return;
    supplyNo += 1;
    try {
      const doc = await client.request<{ number: string }>(
        'POST',
        '/documents/receipts',
        {
          locationId: kitchen.id,
          documentNo: `ЭМ-${String(supplyNo).padStart(4, '0')}`,
          comment: 'Генератор событий',
          lines: [{ productId: plan.product.id, quantity: plan.quantity, unitCost: plan.product.cost, shelfLifeDays: plan.shelfLifeDays }],
        },
        key('supply'),
      );
      stats.supplies += 1;
      log(`Поставка ${doc.number}: ${plan.product.name}, ${unitLabel(plan.quantity, plan.product.unit)}, срок хранения ${plan.shelfLifeDays} сут.${plan.shortDated ? ' (короткий срок)' : ''}`);
    } catch (err) {
      stats.failed += 1;
      log(`Поставка не принята: ${(err as Error).message}`);
    }
  };

  const order = async () => {
    const plan = planOrder(rng, dishes, opts.pressure);
    if (!plan) return;
    const text = plan.lines.map((l) => `${l.dish.name} × ${l.quantity}`).join(', ');
    try {
      const doc = await client.request<{ number: string }>(
        'POST',
        '/documents/sales',
        { locationId: kitchen.id, comment: plan.burst ? 'Генератор событий: большой заказ' : 'Генератор событий', lines: plan.lines.map((l) => ({ dishId: l.dish.id, quantity: l.quantity })) },
        key('order'),
      );
      stats.orders += 1;
      log(`Заказ ${doc.number}: ${text}`);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'insufficient_stock') {
        stats.refused += 1;
        const missing = (Array.isArray(err.details) ? (err.details as { name: string; unit?: Unit; requested: number; available: number }[]) : [])
          .map((d) => `${d.name} (нужно ${d.unit ? unitLabel(d.requested, d.unit) : d.requested}, есть ${d.unit ? unitLabel(d.available, d.unit) : d.available})`)
          .join(', ');
        log(`Заказ отклонён: ${text}. Не хватает: ${missing || 'ингредиентов'}`);
      } else {
        stats.failed += 1;
        log(`Заказ не принят: ${(err as Error).message}`);
      }
    }
  };

  const orderEvery = ORDER_EVERY_MS / opts.speed;
  const supplyEvery = SUPPLY_EVERY_MS / opts.speed;
  let nextOrder = Date.now() + 1000 / opts.speed;
  let nextSupply = Date.now() + 3000 / opts.speed;
  let events = 0;

  while (!stop.signal.aborted && Date.now() < deadline && (opts.count === null || events < opts.count)) {
    const supplyFirst = nextSupply <= nextOrder;
    await sleep(Math.max(0, (supplyFirst ? nextSupply : nextOrder) - Date.now()), stop.signal);
    if (stop.signal.aborted) break;
    try {
      if (supplyFirst) {
        await supply();
        nextSupply = Date.now() + nextDelay(rng, supplyEvery);
      } else {
        await order();
        nextOrder = Date.now() + nextDelay(rng, orderEvery);
      }
      events += 1;
    } catch (err) {
      // сервер недоступен: подождём и продолжим
      log(`Нет связи с сервером (${(err as Error).message}), повтор через 5 с`);
      await sleep(5000, stop.signal);
    }
  }

  log(`Готово. Поставок ${stats.supplies}, заказов принято ${stats.orders}, отклонено из-за нехватки ${stats.refused}, ошибок ${stats.failed}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
