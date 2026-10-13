import { POS_VENDOR_LABELS, type ExternalSystemDto, type LocationDto, type PosConnectionCreatedDto, type PosConnectionDto } from '@zapas/shared';
import { USERS } from '../db/seed/data';
import { ONEC_PRESET_PROFILES } from '../modules/exchange/presets';
import { guidOf } from './guid';

/**
 * Готовит демо-стенд для показа обмена: подключает имитацию 1С и две кассы через обычный API.
 * Запуск: npm run emulate:setup (после npm run emulate:onec). Повторный запуск ничего не дублирует.
 */

const HELP = `Подготовка демо-стенда обмена

Параметры (или переменные окружения в скобках):
  --url       адрес «Запаса» (EMULATE_URL), по умолчанию http://localhost:3000
  --email     администратор (EMULATE_EMAIL), по умолчанию администратор демо-стенда
  --password  пароль (EMULATE_PASSWORD)
  --onec      адрес имитации 1С, по умолчанию http://127.0.0.1:8189
  --pass      пароль пользователя «zapas» в имитации 1С, по умолчанию secret
`;

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) return console.log(HELP);
  const arg = (name: string) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const admin = USERS.find((u) => u.role === 'admin');
  const base = (arg('url') || process.env.EMULATE_URL || 'http://localhost:3000').replace(/\/+$/, '');
  const onec = (arg('onec') || 'http://127.0.0.1:8189').replace(/\/+$/, '');
  const email = arg('email') || process.env.EMULATE_EMAIL || admin?.email || '';
  const password = arg('password') || process.env.EMULATE_PASSWORD || admin?.password || '';

  const login = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) });
  const session = (await login.json().catch(() => ({}))) as { accessToken?: string; error?: { message?: string } };
  if (!login.ok || !session.accessToken) throw new Error(session.error?.message ?? 'Не удалось войти');
  const call = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    const res = await fetch(`${base}/api${path}`, { method, headers: { authorization: `Bearer ${session.accessToken}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    const data = (await res.json().catch(() => ({}))) as T & { error?: { message?: string } };
    if (!res.ok) throw new Error(`${method} ${path}: ${data.error?.message ?? res.status}`);
    return data;
  };

  const systems = await call<ExternalSystemDto[]>('GET', '/exchange/systems');
  let system = systems.find((s) => s.name.startsWith('Бухгалтерия'));
  if (!system) {
    system = await call<ExternalSystemDto>('POST', '/exchange/systems', {
      kind: 'onec',
      name: 'Бухгалтерия (имитация 1С)',
      baseUrl: onec,
      username: 'zapas',
      password: arg('pass') ?? 'secret',
      profile: { ...ONEC_PRESET_PROFILES.bp3, organizationKey: guidOf('org', 'zapas') },
      docKinds: ['receipt', 'writeoff', 'transfer'],
    });
    console.log(`Подключена 1С: ${system.name}`);
  } else console.log(`1С уже подключена: ${system.name}`);
  const check = await call<{ ok: boolean; items: { ok: boolean; text: string }[] }>('POST', `/exchange/systems/${system.id}/check`);
  for (const i of check.items) console.log(`  ${i.ok ? '✓' : '!'} ${i.text}`);

  const locations = await call<LocationDto[]>('GET', '/locations');
  const connections = await call<PosConnectionDto[]>('GET', '/pos/connections');
  const wanted: { name: string; vendor: 'evotor' | 'frontol'; loc: string; flags: string }[] = [
    { name: 'Касса кухни, Набережная', vendor: 'evotor', loc: 'Набережная', flags: '' },
    { name: 'Касса, Центр', vendor: 'frontol', loc: 'Центр', flags: ' --products' },
  ];
  for (const w of wanted) {
    if (connections.some((c) => c.name === w.name && !c.revokedAt)) {
      console.log(`Касса уже подключена: ${w.name}`);
      continue;
    }
    const loc = locations.find((l) => l.name.includes(w.loc));
    if (!loc) continue;
    const c = await call<PosConnectionCreatedDto>('POST', '/pos/connections', { name: w.name, locationId: loc.id, vendor: w.vendor });
    console.log(`Подключена касса «${c.name}» (${POS_VENDOR_LABELS[c.vendor]}). Ключ: ${c.key}`);
    console.log(`  npm run emulate:pos -- --key ${c.key} --vendor ${c.vendor}${w.flags}`);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
