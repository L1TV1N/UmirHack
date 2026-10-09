import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { addProduct, createWorld, receive, type World } from './fixtures';
import { call, createTestEnv, createUser, FakeTelegramApi, loginAs, TEST_PASSWORD, type Session, type TestEnv } from './helpers';
import { HttpTelegramApi, TelegramApiError } from '../src/modules/telegram/api';
import { TelegramBot } from '../src/modules/telegram/bot';
import { fit, parseCommand } from '../src/modules/telegram/commands';

let env: TestEnv;
let w: World;

beforeAll(async () => {
  env = await createTestEnv({ ACCESS_TOKEN_TTL_SECONDS: '3600' });
});
afterAll(() => env.close());
beforeEach(async () => {
  await env.reset();
  w = await createWorld(env);
});

const ADMIN = 111;
const MANAGER = 222;
const KEEPER = 333;
const VIEWER = 444;
const STRANGER = 555;

async function newCode(s: Session): Promise<string> {
  const res = await call(env, s.token)('POST', '/api/telegram/link-code');
  expect(res.statusCode).toBe(201);
  return res.json().code as string;
}

/** Привязывает чат так, как это делает человек: код из интерфейса, затем команда боту. */
async function link(chatId: number, s: Session): Promise<string> {
  return env.chat(chatId, `/start ${await newCode(s)}`);
}

/** Между числом и единицей стоит неразрывный пробел: для сравнения заменяем его обычным. */
const plain = (text: string) => text.replace(/\u00a0/g, ' ');

const sale = (token: string, locationId: string, lines: object[]) => call(env, token)('POST', '/api/documents/sales', { locationId, lines });

describe('разбор команд', () => {
  it('понимает имя бота, регистр и лишние пробелы', () => {
    expect(parseCommand('/stock@zapashack_bot  молоко   3,2%', 'zapashack_bot')).toEqual({ name: 'stock', args: 'молоко 3,2%' });
    expect(parseCommand('/RISKS Центр')).toEqual({ name: 'risks', args: 'Центр' });
    expect(parseCommand('  /help  ')).toEqual({ name: 'help', args: '' });
  });

  it('команду, адресованную другому боту, пропускает; обычный текст не команда', () => {
    expect(parseCommand('/help@other_bot', 'zapashack_bot')).toBeNull();
    expect(parseCommand('привет')).toBeNull();
    expect(parseCommand('/')).toBeNull();
    expect(parseCommand('/1abc')).toBeNull();
  });

  it('fit не режет строку посередине и ставит многоточие', () => {
    const lines = Array.from({ length: 100 }, (_, i) => `строка номер ${i} `.padEnd(80, 'я'));
    const text = fit(lines, 1000);
    expect(text.length).toBeLessThanOrEqual(1010);
    expect(text.endsWith('…')).toBe(true);
    expect(text.split('\n').slice(0, -1).every((l) => l.length === 80)).toBe(true);
  });
});

describe('привязка чата', () => {
  it('код из веб-интерфейса привязывает чат, и бот узнаёт пользователя', async () => {
    const before = await call(env, w.keeperA.token)('GET', '/api/telegram');
    expect(before.json()).toMatchObject({ enabled: true, linked: false, botUsername: 'zapas_test_bot' });

    const reply = await link(KEEPER, w.keeperA);
    expect(reply).toContain('чат привязан');
    expect(reply).toContain('кладовщик');

    const after = (await call(env, w.keeperA.token)('GET', '/api/telegram')).json();
    expect(after.linked).toBe(true);
    expect(after.chatUsername).toBe(`user${KEEPER}`);
    expect(await env.chat(KEEPER, '/whoami')).toContain('кладовщик');
  });

  it('ссылка для входа в бота содержит код', async () => {
    const res = (await call(env, w.keeperA.token)('POST', '/api/telegram/link-code')).json();
    expect(res.deepLink).toBe(`https://t.me/zapas_test_bot?start=${res.code}`);
    expect(res.code).toMatch(/^[A-HJ-NP-Z2-9]{8}$/);
    expect(new Date(res.expiresAt).getTime()).toBe(env.clock.now.getTime() + 10 * 60_000);
  });

  it('код одноразовый', async () => {
    const code = await newCode(w.keeperA);
    expect(await env.chat(KEEPER, `/link ${code}`)).toContain('чат привязан');
    expect(await env.chat(STRANGER, `/link ${code}`)).toContain('Код не подошёл');
    expect(await env.chat(STRANGER, '/points')).toContain('закрытый бот');
  });

  it('код вводят как удобно: строчными, с пробелом или дефисом', async () => {
    const code = await newCode(w.keeperA);
    const typed = `${code.slice(0, 4)}-${code.slice(4)}`.toLowerCase();
    expect(await env.chat(KEEPER, `/link ${typed}`)).toContain('чат привязан');
  });

  it('просроченный и выдуманный код не подходят и отвечают одинаково', async () => {
    const code = await newCode(w.keeperA);
    env.clock.advance(10 * 60_000 + 1000);
    const stale = await env.chat(KEEPER, `/link ${code}`);
    const bogus = await env.chat(KEEPER, '/link ABCDEFGH');
    expect(stale).toContain('Код не подошёл');
    expect(stale).toBe(bogus);
  });

  it('новый код отменяет прежний', async () => {
    const first = await newCode(w.keeperA);
    const second = await newCode(w.keeperA);
    expect(await env.chat(KEEPER, `/link ${first}`)).toContain('Код не подошёл');
    expect(await env.chat(KEEPER, `/link ${second}`)).toContain('чат привязан');
  });

  it('в базе лежит только хэш кода', async () => {
    const code = await newCode(w.keeperA);
    const rows = await env.owner.selectFrom('telegram_link_codes').selectAll().execute();
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toContain(code);
  });

  it('пять неверных кодов подряд закрывают попытки на 15 минут, даже верный код не поможет', async () => {
    const code = await newCode(w.keeperA);
    for (let i = 0; i < 5; i += 1) expect(await env.chat(STRANGER, '/link ZZZZZZZZ')).toContain('Код не подошёл');
    expect(await env.chat(STRANGER, `/link ${code}`)).toContain('Слишком много неверных кодов');
    expect(await env.chat(STRANGER, '/points')).toContain('закрытый бот');

    env.clock.advance(16 * 60_000);
    const fresh = await newCode(w.keeperA);
    expect(await env.chat(STRANGER, `/link ${fresh}`)).toContain('чат привязан');
  });

  it('чужой чат нельзя привязать ко второй учётной записи', async () => {
    await link(KEEPER, w.keeperA);
    expect(await link(KEEPER, w.viewerA)).toContain('уже привязан к другой учётной записи');
    expect(await env.chat(KEEPER, '/whoami')).toContain('кладовщик');
  });

  it('повторная привязка переносит доступ на новый чат, старый теряет его', async () => {
    await link(KEEPER, w.keeperA);
    expect(await link(777, w.keeperA)).toContain('чат привязан');
    expect(await env.chat(KEEPER, '/points')).toContain('закрытый бот');
    expect(await env.chat(777, '/points')).toContain('Магазин Центр');
  });

  it('отключённый пользователь теряет бота, привязка удаляется', async () => {
    await link(KEEPER, w.keeperA);
    const off = await call(env, w.admin.token)('PATCH', `/api/users/${w.keeperA.userId}`, { isActive: false });
    expect(off.statusCode).toBe(200);
    expect(await env.chat(KEEPER, '/points')).toContain('закрытый бот');
    expect(await env.owner.selectFrom('telegram_links').selectAll().execute()).toHaveLength(0);
  });

  it('смена пароля и сброс пароля администратором отвязывают чат', async () => {
    await link(KEEPER, w.keeperA);
    const changed = await call(env, w.keeperA.token)('POST', '/api/auth/change-password', { currentPassword: TEST_PASSWORD, newPassword: 'Новый-Пароль-Ёлка-77' });
    expect(changed.statusCode).toBe(204);
    expect(await env.chat(KEEPER, '/points')).toContain('закрытый бот');

    await link(VIEWER, w.viewerA);
    const reset = await call(env, w.admin.token)('PUT', `/api/users/${w.viewerA.userId}/password`, { password: 'Сброшенный-Пароль-Сосна-31' });
    expect(reset.statusCode).toBe(204);
    expect(await env.chat(VIEWER, '/points')).toContain('закрытый бот');
  });

  it('/unlink и DELETE /api/telegram/link отвязывают чат', async () => {
    await link(KEEPER, w.keeperA);
    expect(await env.chat(KEEPER, '/unlink')).toContain('Чат отвязан');
    expect(await env.chat(KEEPER, '/points')).toContain('закрытый бот');

    await link(VIEWER, w.viewerA);
    const res = await call(env, w.viewerA.token)('DELETE', '/api/telegram/link');
    expect(res.statusCode).toBe(204);
    expect((await call(env, w.viewerA.token)('GET', '/api/telegram')).json().linked).toBe(false);
    expect(await env.chat(VIEWER, '/points')).toContain('закрытый бот');
  });

  it('привязка и отвязка попадают в журнал аудита', async () => {
    await link(KEEPER, w.keeperA);
    await env.chat(KEEPER, '/unlink');
    const rows = await env.owner.selectFrom('audit_log').select(['action', 'user_id']).where('action', 'like', 'telegram.%').orderBy('id').execute();
    expect(rows.map((r) => r.action)).toEqual(['telegram.link', 'telegram.unlink']);
    expect(rows[0]?.user_id).toBe(w.keeperA.userId);
  });

  it('без токена и без настройки код не выдаётся', async () => {
    expect((await call(env, null)('POST', '/api/telegram/link-code')).statusCode).toBe(401);
    expect((await call(env, null)('GET', '/api/telegram')).statusCode).toBe(401);
  });
});

describe('закрытый бот', () => {
  it('до привязки бот отвечает одинаково и ничего не показывает', async () => {
    const p = await addProduct(env, w.categoryId, { name: 'Секретный сыр' });
    await receive(env, w.manager.token, w.locA.id, [{ productId: p, quantity: 5, expiresOn: w.day(3) }]);
    for (const text of ['/stock сыр', '/risks', '/today', '/stoplist', '/points', '/whoami', '/unlink', 'привет']) {
      const reply = await env.chat(STRANGER, text);
      expect(reply, text).toContain('закрытый бот');
      expect(reply, text).not.toContain('Секретный');
    }
    expect(await env.chat(STRANGER, '/start')).toContain('закрытый бот');
  });

  it('группы, каналы и сообщения от ботов не обслуживаются', async () => {
    await link(KEEPER, w.keeperA);
    const sent = env.telegram.sent.length;
    await env.bot.handleUpdate(env.telegram.say(-100123, '/points', { chat: { id: -100123, type: 'supergroup' } }));
    await env.bot.handleUpdate(env.telegram.say(KEEPER, '/points', { from: { id: KEEPER, is_bot: true } }));
    await env.bot.handleUpdate(env.telegram.say(KEEPER, '/points', { from: { id: 9999 } }));
    await env.bot.handleUpdate({ update_id: 1 });
    await env.bot.handleUpdate({ update_id: 2, message: { message_id: 1, chat: { id: KEEPER, type: 'private' } } });
    expect(env.telegram.sent.length).toBe(sent);
  });

  it('слишком частые сообщения перестают обслуживаться', async () => {
    await link(KEEPER, w.keeperA);
    const before = env.telegram.sent.length;
    for (let i = 0; i < 40; i += 1) await env.chat(KEEPER, '/whoami');
    const answered = env.telegram.sent.length - before;
    expect(answered).toBeLessThan(40);
    expect(answered).toBeGreaterThan(20);
    env.clock.advance(61_000);
    expect(await env.chat(KEEPER, '/whoami')).toContain('кладовщик');
  });

  it('служебные символы и длинный текст отклоняются', async () => {
    await link(KEEPER, w.keeperA);
    expect(await env.chat(KEEPER, '/stock мол\u0000око')).toContain('Не понял');
    expect(await env.chat(KEEPER, `/stock ${'я'.repeat(400)}`)).toContain('Не понял');
    expect(await env.chat(KEEPER, '/stock ‮молоко')).toContain('Не понял');
  });

  it('неизвестная команда и обычный текст получают подсказку', async () => {
    await link(KEEPER, w.keeperA);
    expect(await env.chat(KEEPER, '/drop_database')).toContain('/help');
    expect(await env.chat(KEEPER, 'привет')).toContain('/help');
  });

  it('команды для другого бота молча пропускаются', async () => {
    await link(KEEPER, w.keeperA);
    const before = env.telegram.sent.length;
    await env.chat(KEEPER, '/points@someone_else_bot');
    expect(env.telegram.sent.length).toBe(before);
  });
});

describe('команды', () => {
  beforeEach(async () => {
    await link(ADMIN, w.admin);
    await link(MANAGER, w.manager);
    await link(KEEPER, w.keeperA);
    await link(VIEWER, w.viewerA);
  });

  it('/help показывает все команды, меню бота задано при запуске', async () => {
    const help = await env.chat(KEEPER, '/help');
    for (const c of ['/today', '/risks', '/order', '/stoplist', '/stock', '/expiring', '/expired', '/low', '/points', '/unlink']) expect(help).toContain(c);
    expect(env.telegram.commands.map((c) => c.command)).toEqual(expect.arrayContaining(['today', 'risks', 'stock', 'unlink']));
  });

  it('/points: кладовщик видит свою точку, менеджер все', async () => {
    const keeper = await env.chat(KEEPER, '/points');
    expect(keeper).toContain('Магазин Центр');
    expect(keeper).not.toContain('Северный');
    const manager = await env.chat(MANAGER, '/points');
    expect(manager).toContain('Магазин Центр');
    expect(manager).toContain('Магазин Северный');
    expect(manager).toContain('Кухня');
  });

  it('/stock ищет по названию и артикулу и показывает только свои точки', async () => {
    const own = await addProduct(env, w.categoryId, { name: 'Кефир 2,5%', unit: 'l' });
    const foreign = await addProduct(env, w.categoryId, { name: 'Кефир домашний', unit: 'l' });
    await receive(env, w.manager.token, w.locA.id, [{ productId: own, quantity: 12, expiresOn: w.day(4) }]);
    await receive(env, w.manager.token, w.locB.id, [{ productId: foreign, quantity: 7, expiresOn: w.day(4) }]);

    const keeper = await env.chat(KEEPER, '/stock кефир');
    expect(keeper).toContain('Кефир 2,5%');
    expect(plain(keeper)).toContain('12 л');
    expect(keeper).toContain('Магазин Центр');
    expect(keeper).not.toContain('домашний');
    expect(keeper).not.toContain('Северный');

    const manager = await env.chat(MANAGER, '/stock кефир');
    expect(manager).toContain('Кефир 2,5%');
    expect(manager).toContain('Кефир домашний');

    const sku = (await env.owner.selectFrom('products').select('sku').where('id', '=', own).executeTakeFirstOrThrow()).sku;
    expect(await env.chat(KEEPER, `/stock ${sku.toLowerCase()}`)).toContain('Кефир 2,5%');
  });

  it('/stock без запроса объясняет, что нужно, а на пустой результат отвечает прямо', async () => {
    expect(await env.chat(KEEPER, '/stock')).toContain('Что искать');
    expect(await env.chat(KEEPER, '/stock а')).toContain('Что искать');
    expect(await env.chat(KEEPER, '/stock несуществующий')).toContain('ничего не найдено');
  });

  it('названия из базы экранируются, разметка не ломается', async () => {
    const p = await addProduct(env, w.categoryId, { name: 'Сыр <b>&<script>' });
    await receive(env, w.manager.token, w.locA.id, [{ productId: p, quantity: 1, expiresOn: w.day(4) }]);
    const reply = await env.chat(KEEPER, '/stock сыр');
    expect(reply).toContain('Сыр &lt;b&gt;&amp;&lt;script&gt;');
    expect(reply).not.toContain('<script>');
    expect(await env.chat(KEEPER, '/stock <b>')).toContain('&lt;b&gt;');
  });

  it('/stoplist: закончившаяся позиция в списке, чужая точка нет', async () => {
    const mine = await addProduct(env, w.categoryId, { name: 'Мой творог', unit: 'kg' });
    const theirs = await addProduct(env, w.categoryId, { name: 'Чужая сметана', unit: 'kg' });
    for (const [p, loc] of [[mine, w.locA.id], [theirs, w.locB.id]] as const) {
      await receive(env, w.manager.token, loc, [{ productId: p, quantity: 1, expiresOn: w.day(5) }]);
      expect((await sale(w.manager.token, loc, [{ productId: p, quantity: 1 }])).statusCode).toBe(201);
    }
    await env.settle();
    const keeper = await env.chat(KEEPER, '/stoplist');
    expect(keeper).toContain('Мой творог');
    expect(keeper).toContain('Нет в наличии');
    expect(keeper).not.toContain('Чужая сметана');
    expect(await env.chat(MANAGER, '/stoplist')).toContain('Чужая сметана');
    expect(await env.chat(MANAGER, '/stoplist Северный')).not.toContain('Мой творог');
  });

  it('/stoplist пуст, когда всё есть', async () => {
    expect(await env.chat(KEEPER, '/stoplist')).toContain('пусто');
  });

  it('/risks и /today: что требует действий и деньги под угрозой', async () => {
    const p = await addProduct(env, w.categoryId, { name: 'Йогурт', unit: 'kg', cost: 200, price: 300 });
    await receive(env, w.manager.token, w.locA.id, [{ productId: p, quantity: 8, expiresOn: w.day(1), unitCost: 200 }]);
    const old = await addProduct(env, w.categoryId, { name: 'Старая сметана', unit: 'kg', cost: 100 });
    await receive(env, w.manager.token, w.locA.id, [{ productId: old, quantity: 3, expiresOn: w.day(-1), unitCost: 100 }], { allowExpired: true });

    const risks = await env.chat(KEEPER, '/risks');
    expect(risks).toContain('Что требует действий: 2');
    expect(risks).toContain('Старая сметана');
    expect(risks).toContain('Йогурт');
    expect(risks).toContain('Под угрозой');
    expect(risks.indexOf('Старая сметана')).toBeLessThan(risks.indexOf('Йогурт'));

    const today = await env.chat(KEEPER, '/today');
    expect(today).toContain('Сводка на');
    expect(today).toContain('Просрочено: 1 парт.');
    expect(today).toContain('Под угрозой');
  });

  it('/risks по точке и права на точки', async () => {
    const a = await addProduct(env, w.categoryId, { name: 'Товар А', unit: 'kg' });
    const b = await addProduct(env, w.categoryId, { name: 'Товар Б', unit: 'kg' });
    await receive(env, w.manager.token, w.locA.id, [{ productId: a, quantity: 5, expiresOn: w.day(-1) }], { allowExpired: true });
    await receive(env, w.manager.token, w.locB.id, [{ productId: b, quantity: 5, expiresOn: w.day(-1) }], { allowExpired: true });

    expect(await env.chat(MANAGER, '/risks Центр')).toContain('Товар А');
    expect(await env.chat(MANAGER, '/risks Центр')).not.toContain('Товар Б');
    expect(await env.chat(MANAGER, '/risks')).toContain('Товар Б');
    // кладовщик чужую точку не видит: она не отличается от несуществующей
    const denied = await env.chat(KEEPER, '/risks Северный');
    expect(denied).toContain('не найдена');
    expect(denied).not.toContain('Товар Б');
    expect(await env.chat(KEEPER, '/risks')).not.toContain('Товар Б');
    expect(await env.chat(MANAGER, '/risks Нигде')).toContain('не найдена');
  });

  it('если название подходит нескольким точкам, бот просит уточнить', async () => {
    const reply = await env.chat(MANAGER, '/risks Магазин');
    expect(reply).toContain('Уточните точку');
    expect(reply).toContain('Центр');
    expect(reply).toContain('Северный');
  });

  it('/expired, /expiring и /low', async () => {
    const stale = await addProduct(env, w.categoryId, { name: 'Прокисшее молоко', unit: 'l', cost: 50 });
    const soon = await addProduct(env, w.categoryId, { name: 'Хлеб на завтра', unit: 'pcs' });
    const low = await addProduct(env, w.categoryId, { name: 'Редкий соус', unit: 'kg', minStock: 10 });
    await receive(env, w.manager.token, w.locA.id, [{ productId: stale, quantity: 4, expiresOn: w.day(-2), unitCost: 50 }], { allowExpired: true });
    await receive(env, w.manager.token, w.locA.id, [{ productId: soon, quantity: 20, expiresOn: w.day(1) }]);
    await receive(env, w.manager.token, w.locA.id, [{ productId: low, quantity: 2, expiresOn: w.day(90) }]);

    const expired = await env.chat(KEEPER, '/expired');
    expect(expired).toContain('Прокисшее молоко');
    expect(plain(expired)).toContain('просрочено 4 л на 200');
    const expiring = await env.chat(KEEPER, '/expiring');
    expect(expiring).toContain('Хлеб на завтра');
    expect(expiring).toContain('истекает завтра');
    const lowText = await env.chat(KEEPER, '/low');
    expect(lowText).toContain('Редкий соус');
    expect(lowText).toContain('ниже минимума');
    expect(await env.chat(VIEWER, '/low Центр')).toContain('Редкий соус');
  });

  it('на пустые списки отвечает коротко', async () => {
    expect(await env.chat(KEEPER, '/expired')).toContain('ничего нет');
    expect(await env.chat(KEEPER, '/low')).toContain('ничего нет');
    expect(await env.chat(KEEPER, '/risks')).toContain('сейчас ничего');
    expect(await env.chat(KEEPER, '/order')).toContain('сейчас ничего');
  });

  it('длинный список укладывается в одно сообщение Telegram', async () => {
    const ids = await Promise.all(Array.from({ length: 40 }, (_, i) => addProduct(env, w.categoryId, { name: `Очень длинное название продукта номер ${i} для проверки предела`, unit: 'kg' })));
    await receive(env, w.manager.token, w.locA.id, ids.map((productId) => ({ productId, quantity: 3, expiresOn: w.day(-1) })), { allowExpired: true });
    for (const cmd of ['/risks', '/expired', '/stock очень', '/today']) {
      const reply = await env.chat(MANAGER, cmd);
      expect(reply.length, cmd).toBeLessThan(4096);
      expect(reply, cmd).toMatch(/ещё \d+|Сводка/);
    }
  });

  it('роль наблюдателя тоже читает, но бот ничего не изменяет', async () => {
    const p = await addProduct(env, w.categoryId, { name: 'Мёд', unit: 'kg' });
    await receive(env, w.manager.token, w.locA.id, [{ productId: p, quantity: 3, expiresOn: w.day(100) }]);
    expect(await env.chat(VIEWER, '/stock мёд')).toContain('Мёд');
    const movements = await env.owner.selectFrom('stock_movements').select('id').execute();
    for (const cmd of ['/stop мёд', '/writeoff мёд', '/sale мёд 1', '/discount мёд 50']) await env.chat(VIEWER, cmd);
    expect(await env.owner.selectFrom('stock_movements').select('id').execute()).toHaveLength(movements.length);
    expect(await env.owner.selectFrom('stop_list_manual').select('id').execute()).toHaveLength(0);
  });
});

describe('опрос Telegram', () => {
  it('обрабатывает сообщения по порядку, двигает смещение и переживает сбои сети', async () => {
    const api = new FakeTelegramApi();
    const waits: number[] = [];
    const controller = new AbortController();
    const log = { info: () => undefined, warn: () => undefined, error: () => undefined };
    const bot = new TelegramBot({ db: env.db, config: env.config, clock: () => env.clock.now, notifier: env.notifier, telegram: api, log }, api, {
      sleep: async (ms) => {
        waits.push(ms);
      },
    });

    const offsets: number[] = [];
    const batch = [api.say(STRANGER, '/help'), api.say(STRANGER, 'привет')];
    let call = 0;
    api.getUpdates = async (offset = 0) => {
      offsets.push(offset);
      call += 1;
      if (call === 1) throw new Error('сеть пропала');
      if (call === 2) throw new Error('сеть пропала снова');
      if (call === 3) return batch;
      controller.abort();
      return [];
    };
    await bot.run(controller.signal);

    expect(waits).toEqual([1000, 2000]);
    expect(offsets[0]).toBe(0);
    // после обработанной пачки спрашиваем следующее сообщение: смещение на единицу больше последнего
    expect(offsets[3]).toBe((batch[1] as { update_id: number }).update_id + 1);
    expect(api.to(STRANGER)).toHaveLength(2);
    expect(api.commands.length).toBeGreaterThan(5);
  });

  it('сообщение, на котором обработчик падает, не приходит повторно и не останавливает опрос', async () => {
    const api = new FakeTelegramApi();
    const controller = new AbortController();
    const log = { info: () => undefined, warn: () => undefined, error: () => undefined };
    const bot = new TelegramBot({ db: env.db, config: env.config, clock: () => env.clock.now, notifier: env.notifier, telegram: api, log }, api, { sleep: async () => undefined });
    const original = bot.handleUpdate.bind(bot);
    let handled = 0;
    bot.handleUpdate = async (u) => {
      handled += 1;
      if (handled === 1) throw new Error('сбой');
      await original(u);
    };
    const seen: number[] = [];
    let n = 0;
    api.getUpdates = async (offset = 0) => {
      seen.push(offset);
      n += 1;
      if (n === 1) return [api.say(STRANGER, '/help'), api.say(STRANGER, '/help')];
      controller.abort();
      return [];
    };
    await bot.run(controller.signal);
    expect(handled).toBe(2);
    expect(seen[1]).toBeGreaterThan(seen[0] as number);
    expect(api.to(STRANGER)).toHaveLength(1);
  });

  it('сбой отправки ответа не роняет бота', async () => {
    await link(KEEPER, w.keeperA);
    env.telegram.sendMessage = async () => {
      throw new Error('Telegram недоступен');
    };
    await expect(env.bot.handleUpdate(env.telegram.say(KEEPER, '/points'))).resolves.toBeUndefined();
    env.telegram.sendMessage = FakeTelegramApi.prototype.sendMessage.bind(env.telegram);
  });

  it('при ошибке внутри команды человек видит общий ответ без подробностей', async () => {
    await link(KEEPER, w.keeperA);
    await env.owner.schema.alterTable('locations').renameTo('locations_tmp').execute();
    try {
      const reply = await env.chat(KEEPER, '/points');
      expect(reply).toContain('Не удалось выполнить команду');
      expect(reply).not.toMatch(/relation|locations|SQL/i);
    } finally {
      await env.owner.schema.alterTable('locations_tmp').renameTo('locations').execute();
    }
  });
});

describe('клиент Bot API', () => {
  it('ходит только на api.telegram.org, токен не попадает в текст ошибки', async () => {
    const urls: string[] = [];
    const secret = '123456:ABC-secret';
    const api = new HttpTelegramApi(secret, (async (url: string | URL | Request) => {
      urls.push(String(url));
      return new Response(JSON.stringify({ ok: false, description: 'Unauthorized' }), { status: 401 });
    }) as typeof fetch);
    await api.getMe().then(
      () => expect.unreachable(),
      (err: unknown) => {
        expect(err).toBeInstanceOf(TelegramApiError);
        expect((err as Error).message).not.toContain(secret);
        expect((err as Error).message).toContain('401');
      },
    );
    await expect(api.sendMessage(1, 'x')).rejects.toThrow();
    await expect(api.getUpdates(0, 1)).rejects.toThrow();
    await expect(api.setCommands([])).rejects.toThrow();
    expect(urls.every((u) => u.startsWith('https://api.telegram.org/bot'))).toBe(true);
    expect(urls).toHaveLength(4);
  });

  it('при успехе отдаёт результат и просит нужные типы обновлений', async () => {
    const bodies: Record<string, unknown>[] = [];
    const api = new HttpTelegramApi('1:t', (async (_url: string | URL | Request, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(JSON.stringify({ ok: true, result: [{ update_id: 5 }] }), { status: 200 });
    }) as typeof fetch);
    expect(await api.getUpdates(7, 25)).toEqual([{ update_id: 5 }]);
    expect(bodies[0]).toMatchObject({ offset: 7, timeout: 25, allowed_updates: ['message'] });
  });
});

describe('несколько пользователей', () => {
  it('чаты разных людей не смешиваются', async () => {
    const other = await createUser(env, { role: 'storekeeper', locationIds: [w.locB.id] }).then((u) => loginAs(env, u));
    await link(KEEPER, w.keeperA);
    await link(VIEWER, other);
    const a = await addProduct(env, w.categoryId, { name: 'Только для Центра' });
    const b = await addProduct(env, w.categoryId, { name: 'Только для Северного' });
    await receive(env, w.manager.token, w.locA.id, [{ productId: a, quantity: 1, expiresOn: w.day(9) }]);
    await receive(env, w.manager.token, w.locB.id, [{ productId: b, quantity: 1, expiresOn: w.day(9) }]);
    expect(await env.chat(KEEPER, '/stock только')).toContain('Только для Центра');
    expect(await env.chat(KEEPER, '/stock только')).not.toContain('Северного');
    expect(await env.chat(VIEWER, '/stock только')).toContain('Только для Северного');
    expect(await env.chat(VIEWER, '/stock только')).not.toContain('Центра');
  });
});
