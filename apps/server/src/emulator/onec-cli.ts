import { USERS } from '../db/seed/data';
import { ONEC_PRESET_PROFILES } from '../modules/exchange/presets';
import { guidOf } from './guid';
import { MockOneC } from './onec';

/**
 * Имитация сервера 1С со стандартным интерфейсом OData: принимает документы от «Запаса», ищет в справочниках, обновляет
 * документы без дублей. Справочники заполняются из «Запаса», поэтому автоматическая связка находит всё по артикулу.
 *
 * Запуск: npm run emulate:onec. Параметры подключения выводятся при старте.
 */

const HELP = `Имитация сервера 1С для «Запаса»

Параметры (или переменные окружения в скобках):
  --url       адрес «Запаса» для чтения номенклатуры (EMULATE_URL), по умолчанию http://localhost:3000
  --email     пользователь, --password пароль (EMULATE_EMAIL, EMULATE_PASSWORD), по умолчанию менеджер демо-стенда
  --port      порт имитации, по умолчанию 8189
  --preset    bp3 | retail3 | ut11 | unf, по умолчанию bp3
  --pass      пароль пользователя «zapas» в имитации, по умолчанию secret
`;

function parse(argv: string[], env: NodeJS.ProcessEnv) {
  const raw = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i] as string;
    if (a === '--help' || a === '-h') return null;
    if (!a.startsWith('--')) throw new Error(`Неизвестный аргумент «${a}»`);
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) throw new Error(`Для ${a} не указано значение`);
    raw.set(a.slice(2), v);
    i += 1;
  }
  for (const k of raw.keys()) if (!['url', 'email', 'password', 'port', 'preset', 'pass'].includes(k)) throw new Error(`Неизвестный параметр --${k}`);
  const manager = USERS.find((u) => u.role === 'manager');
  const preset = (raw.get('preset') ?? 'bp3') as keyof typeof ONEC_PRESET_PROFILES;
  if (!(preset in ONEC_PRESET_PROFILES) || preset === 'custom') throw new Error(`Неизвестная конфигурация «${preset}»`);
  return {
    url: (raw.get('url') || env.EMULATE_URL || 'http://localhost:3000').replace(/\/+$/, ''),
    email: raw.get('email') || env.EMULATE_EMAIL || manager?.email || '',
    password: raw.get('password') || env.EMULATE_PASSWORD || manager?.password || '',
    port: Number(raw.get('port') ?? 8189),
    preset,
    pass: raw.get('pass') ?? 'secret',
  };
}

async function main(): Promise<void> {
  const o = parse(process.argv.slice(2), process.env);
  if (!o) return console.log(HELP);
  const login = await fetch(`${o.url}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: o.email, password: o.password }) });
  const session = (await login.json().catch(() => ({}))) as { accessToken?: string; error?: { message?: string } };
  if (!login.ok || !session.accessToken) throw new Error(session.error?.message ?? 'Не удалось войти в «Запас»');
  const get = async <T>(path: string): Promise<T> => {
    const res = await fetch(`${o.url}/api${path}`, { headers: { authorization: `Bearer ${session.accessToken}` } });
    if (!res.ok) throw new Error(`${path}: ${res.status}`);
    return (await res.json()) as T;
  };

  const profile = { ...ONEC_PRESET_PROFILES[o.preset], organizationKey: guidOf('org', 'zapas') };
  const mock = new MockOneC(profile, { user: 'zapas', password: o.pass });
  const add = (entity: string | undefined, code: string, name: string) => {
    if (!entity) return;
    const key = guidOf(entity, code);
    const row = mock.addCatalogItem(entity, code, name);
    // заменяем случайный ключ на постоянный
    const rows = mock.catalogs.get(entity) as { Ref_Key: string }[];
    (rows.find((r) => r.Ref_Key === row) as { Ref_Key: string }).Ref_Key = key;
  };

  let products = 0;
  for (let offset = 0; ; offset += 200) {
    const page = await get<{ items: { sku: string; name: string }[]; total: number }>(`/products?limit=200&offset=${offset}&active=true`);
    for (const p of page.items) {
      add(profile.catalogs.product.entity, p.sku, p.name);
      products += 1;
    }
    if (products >= page.total || page.items.length === 0) break;
  }
  const suppliers = await get<{ name: string; inn: string | null }[]>('/suppliers');
  for (const s of suppliers) if (s.inn) add(profile.catalogs.supplier?.entity, s.inn, s.name);
  const locations = await get<{ code: string; name: string }[]>('/locations');
  for (const l of locations) add(profile.catalogs.location?.entity, l.code, l.name);

  const originalHandle = mock.handle.bind(mock);
  mock.handle = (req) => {
    const out = originalHandle(req);
    const line = `${req.method} ${decodeURIComponent(new URL(req.url).pathname).replace(profile.odataPath, '')} → ${out.status}`;
    if (req.method !== 'GET' || out.status >= 400) console.log(`[${new Intl.DateTimeFormat('ru-RU', { timeStyle: 'medium' }).format(new Date())}] ${line}`);
    return out;
  };

  const server = await mock.listen(o.port);
  console.log(`Имитация 1С запущена: ${preset(o.preset)}`);
  console.log(`  Адрес сервера:  http://127.0.0.1:${o.port}`);
  console.log(`  Пользователь:   zapas`);
  console.log(`  Пароль:         ${o.pass}`);
  console.log(`  Организация:    ${profile.organizationKey}`);
  console.log(`  Справочники: продуктов ${products}, поставщиков ${suppliers.filter((s) => s.inn).length}, складов ${locations.length}`);
  console.log('В «Запасе» разрешите адрес: EXCHANGE_ALLOW_HOSTS=127.0.0.1. Остановка по Ctrl+C');
  process.once('SIGINT', () => server.close(() => process.exit(0)));
  process.once('SIGTERM', () => server.close(() => process.exit(0)));
}

const preset = (p: string) => ({ bp3: '1С:Бухгалтерия 3.0', retail3: '1С:Розница 3', ut11: '1С:УТ 11', unf: '1С:УНФ' })[p] ?? p;

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
