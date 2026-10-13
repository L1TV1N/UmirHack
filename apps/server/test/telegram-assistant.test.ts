import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { parseAction } from '../src/modules/telegram/actions';
import { schedulerTick } from '../src/modules/notifications/scheduler';
import { addProduct, createWorld, receive, remaining, seedSales, type World } from './fixtures';
import { call, createTestEnv, type Session, type TestEnv } from './helpers';

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

const MANAGER = 222;
const KEEPER = 333;
const STRANGER = 555;

async function link(chatId: number, s: Session): Promise<void> {
  const res = await call(env, s.token)('POST', '/api/telegram/link-code');
  await env.chat(chatId, `/start ${res.json().code as string}`);
}

/** Нажимает кнопку и возвращает, что бот сделал в ответ. */
async function tap(chatId: number, data: string, messageId = 7) {
  const sent = env.telegram.sent.length;
  const edits = env.telegram.edits.length;
  const answers = env.telegram.answers.length;
  await env.bot.handleUpdate(env.telegram.tap(chatId, data, messageId));
  return {
    sent: env.telegram.sent.slice(sent),
    edits: env.telegram.edits.slice(edits),
    answers: env.telegram.answers.slice(answers),
  };
}

const lastButtons = (chatId: number) => env.telegram.sent.filter((m) => m.chatId === chatId && m.buttons).at(-1)?.buttons?.flat() ?? [];

/** Партия, которую система предложит уценить: продаётся медленнее, чем истекает срок. */
async function discountable(name = 'Йогурт') {
  const p = await addProduct(env, w.categoryId, { name, unit: 'l', price: 100, cost: 60 });
  await seedSales(env, { productId: p, locationId: w.locA.id, days: 25, perDay: 4 });
  await receive(env, w.manager.token, w.locA.id, [{ productId: p, quantity: 30, expiresOn: w.day(2), unitCost: 60 }]);
  return p;
}

describe('меню и кнопки', () => {
  it('после привязки бот показывает главное меню', async () => {
    await link(KEEPER, w.keeperA);
    const data = lastButtons(KEEPER).map((b) => b.data);
    expect(data).toEqual(expect.arrayContaining(['cmd:today', 'cmd:risks', 'cmd:stoplist', 'cmd:hot', 'cmd:order', 'cmd:subscribe']));
    for (const d of data) expect(Buffer.byteLength(d)).toBeLessThanOrEqual(64);
  });

  it('кнопка меню запускает ту же команду и снимает индикатор ожидания', async () => {
    await link(KEEPER, w.keeperA);
    const r = await tap(KEEPER, 'cmd:stoplist');
    expect(r.sent).toHaveLength(1);
    expect(r.sent[0]?.text).toContain('Стоп-лист');
    expect(r.answers).toHaveLength(1);
  });

  it('чужие, выдуманные и слишком длинные данные кнопки ничего не делают', async () => {
    await link(KEEPER, w.keeperA);
    for (const data of ['cmd:unlink', 'cmd:whoami', 'zzz:1', 'sub:другое', 'a:d:не-uuid:30', 'a:w:', 'x'.repeat(80)]) {
      const r = await tap(KEEPER, data);
      expect(r.edits, data).toHaveLength(0);
      expect(r.answers, data).toHaveLength(1);
    }
    // подделанное подтверждение отвечает, что кнопка устарела, и ничего не выполняет
    const forged = await tap(KEEPER, 'y:d:00000000-0000-4000-8000-000000000000:99');
    expect(forged.edits[0]?.text).toBe('Кнопка устарела.');
    expect(await env.chat(KEEPER, '/whoami')).toContain('кладовщик');
  });

  it('нажатие из непривязанного чата отвергается', async () => {
    const r = await tap(STRANGER, 'cmd:today');
    expect(r.sent).toHaveLength(0);
    expect(r.answers[0]?.text).toBe('Нет доступа');
  });

  it('кнопки в группе и от другого человека не работают', async () => {
    await link(KEEPER, w.keeperA);
    const group = env.telegram.tap(KEEPER, 'cmd:today');
    group.callback_query!.message!.chat.type = 'supergroup';
    await env.bot.handleUpdate(group);
    const other = env.telegram.tap(KEEPER, 'cmd:today');
    other.callback_query!.from.id = 999;
    await env.bot.handleUpdate(other);
    expect(env.telegram.sent.filter((m) => m.text.includes('Сводка'))).toHaveLength(0);
  });

  it('разбор данных действия строгий', () => {
    const id = '5b3f6a52-5d6e-4f55-9d0b-1f7f8f0f7a11';
    expect(parseAction(`d:${id}:30`)).toEqual({ kind: 'discount', batchId: id, percent: 30 });
    expect(parseAction(`w:${id}`)).toEqual({ kind: 'writeoff', batchId: id });
    for (const bad of [`d:${id}`, `d:${id}:0`, `d:${id}:95`, `d:${id}:3x`, `w:${id}:1`, 'w:abc', `x:${id}`, '']) expect(parseAction(bad), bad).toBeNull();
  });
});

describe('подписки', () => {
  it('по умолчанию включены сводка и стоп-лист, горячие блюда выключены', async () => {
    await link(KEEPER, w.keeperA);
    const text = await env.chat(KEEPER, '/subscribe');
    expect(text).toContain('Включено: Утренняя сводка');
    expect(text).toContain('Включено: Новые позиции в стоп-листе');
    expect(text).toContain('Выключено: Горячие блюда в сводке');
  });

  it('кнопка переключает тему и обновляет сообщение на месте', async () => {
    await link(KEEPER, w.keeperA);
    await env.chat(KEEPER, '/subscribe');
    const on = await tap(KEEPER, 'sub:hot', 42);
    expect(on.edits[0]).toMatchObject({ chatId: KEEPER, messageId: 42 });
    expect(on.edits[0]?.text).toContain('Включено: Горячие блюда в сводке');
    expect(await env.db.selectFrom('telegram_links').select('topics').where('chat_id', '=', String(KEEPER)).executeTakeFirstOrThrow()).toMatchObject({ topics: expect.arrayContaining(['hot']) });

    const off = await tap(KEEPER, 'sub:digest', 42);
    expect(off.edits[0]?.text).toContain('Выключено: Утренняя сводка');
  });

  it('подписки у каждого свои', async () => {
    await link(KEEPER, w.keeperA);
    await link(MANAGER, w.manager);
    await tap(KEEPER, 'sub:stoplist');
    expect(await env.chat(KEEPER, '/subscribe')).toContain('Выключено: Новые позиции в стоп-листе');
    expect(await env.chat(MANAGER, '/subscribe')).toContain('Включено: Новые позиции в стоп-листе');
  });
});

describe('действия по рекомендациям', () => {
  it('менеджер включает скидку кнопкой после подтверждения', async () => {
    const p = await discountable();
    await link(MANAGER, w.manager);
    await env.chat(MANAGER, '/risks');
    const discount = lastButtons(MANAGER).find((b) => b.data.startsWith('a:d:'));
    expect(discount?.text).toContain('Йогурт');

    const ask = await tap(MANAGER, discount!.data);
    expect(ask.sent[0]?.text).toContain('Включить скидку 30%');
    expect(ask.sent[0]?.buttons?.flat().map((b) => b.data)).toEqual([`y:${discount!.data.slice(2)}`, 'n']);
    // пока не подтвердили, ничего не изменилось
    expect((await call(env, w.manager.token)('GET', '/api/promotions')).json()).toHaveLength(0);

    const done = await tap(MANAGER, `y:${discount!.data.slice(2)}`, 9);
    expect(done.edits[0]?.text).toContain('Скидка 30% включена');
    const promos = (await call(env, w.manager.token)('GET', '/api/promotions')).json();
    expect(promos).toHaveLength(1);
    expect(promos[0]).toMatchObject({ percent: 30, productName: 'Йогурт' });
    const audit = await env.owner.selectFrom('audit_log').select(['user_email', 'ip']).where('action', '=', 'promotion.create').executeTakeFirstOrThrow();
    expect(audit.user_email).toBeTruthy();
    void p;
  });

  it('отмена ничего не меняет', async () => {
    await discountable();
    await link(MANAGER, w.manager);
    await env.chat(MANAGER, '/risks');
    const discount = lastButtons(MANAGER).find((b) => b.data.startsWith('a:d:'))!;
    await tap(MANAGER, discount.data);
    const r = await tap(MANAGER, 'n', 9);
    expect(r.edits[0]?.text).toBe('Отменено.');
    expect((await call(env, w.manager.token)('GET', '/api/promotions')).json()).toHaveLength(0);
  });

  it('кладовщику кнопки скидки не показываются, а подделанная кнопка не срабатывает', async () => {
    await discountable();
    await link(KEEPER, w.keeperA);
    await env.chat(KEEPER, '/risks');
    expect(lastButtons(KEEPER).some((b) => b.data.startsWith('a:d:'))).toBe(false);

    await link(MANAGER, w.manager);
    await env.chat(MANAGER, '/risks');
    const forged = lastButtons(MANAGER).find((b) => b.data.startsWith('a:d:'))!.data;
    const r = await tap(KEEPER, forged);
    expect(r.sent[0]?.text).toContain('менеджер');
    const run = await tap(KEEPER, `y:${forged.slice(2)}`);
    expect(run.edits[0]?.text).toContain('менеджер');
    expect((await call(env, w.manager.token)('GET', '/api/promotions')).json()).toHaveLength(0);
  });

  it('кладовщик списывает просроченное кнопкой, документ записан на него', async () => {
    const p = await addProduct(env, w.categoryId, { name: 'Сыр', unit: 'kg', cost: 500 });
    await receive(env, w.manager.token, w.locA.id, [{ productId: p, quantity: 2, expiresOn: w.day(-1), unitCost: 500 }], { allowExpired: true });
    await link(KEEPER, w.keeperA);
    await env.chat(KEEPER, '/risks');
    const writeoff = lastButtons(KEEPER).find((b) => b.data.startsWith('a:w:'))!;
    expect(writeoff.text).toContain('Сыр');

    const ask = await tap(KEEPER, writeoff.data);
    expect(ask.sent[0]?.text).toContain('Списать');
    expect(await remaining(env, p, w.locA.id)).toBe(2);
    const done = await tap(KEEPER, `y:${writeoff.data.slice(2)}`, 9);
    expect(done.edits[0]?.text).toContain('Списано');
    expect(await remaining(env, p, w.locA.id)).toBe(0);
    const doc = await env.owner.selectFrom('documents').select(['kind', 'actor_name', 'comment']).where('kind', '=', 'writeoff').executeTakeFirstOrThrow();
    expect(doc.comment).toBe('Списано из Telegram');
    expect(doc.actor_name).toBe((await env.owner.selectFrom('users').select('full_name').where('id', '=', w.keeperA.userId).executeTakeFirstOrThrow()).full_name);
  });

  it('чужая точка недоступна: подделанная кнопка отвечает, что партии нет', async () => {
    const p = await addProduct(env, w.categoryId, { name: 'Сыр', unit: 'kg', cost: 500 });
    await receive(env, w.manager.token, w.locB.id, [{ productId: p, quantity: 2, expiresOn: w.day(-1), unitCost: 500 }], { allowExpired: true });
    const batch = (await env.owner.selectFrom('batches').select('id').executeTakeFirstOrThrow()).id;
    await link(KEEPER, w.keeperA);
    const r = await tap(KEEPER, `a:w:${batch}`);
    expect(r.sent[0]?.text).toContain('не найден');
    const run = await tap(KEEPER, `y:w:${batch}`);
    expect(run.edits[0]?.text).toContain('не найден');
    expect(await remaining(env, p, w.locB.id)).toBe(2);
  });

  it('когда партию уже списали, бот сообщает об этом, а не списывает второй раз', async () => {
    const p = await addProduct(env, w.categoryId, { name: 'Сыр', unit: 'kg', cost: 500 });
    await receive(env, w.manager.token, w.locA.id, [{ productId: p, quantity: 2, expiresOn: w.day(-1), unitCost: 500 }], { allowExpired: true });
    await link(KEEPER, w.keeperA);
    await env.chat(KEEPER, '/risks');
    const writeoff = lastButtons(KEEPER).find((b) => b.data.startsWith('a:w:'))!;
    await tap(KEEPER, `y:${writeoff.data.slice(2)}`);
    const again = await tap(KEEPER, `y:${writeoff.data.slice(2)}`);
    expect(again.edits[0]?.text).toContain('уже не требует списания');
    expect((await env.owner.selectFrom('documents').select('id').where('kind', '=', 'writeoff').execute())).toHaveLength(1);
  });
});

describe('рассылка по подпискам', () => {
  async function soldOut(locationId: string, name: string) {
    const p = await addProduct(env, w.categoryId, { name, unit: 'kg' });
    await receive(env, w.manager.token, locationId, [{ productId: p, quantity: 1, expiresOn: w.day(5) }]);
    await env.settle();
    await call(env, w.manager.token)('POST', '/api/documents/sales', { locationId, lines: [{ productId: p, quantity: 1 }] });
    await env.settle();
  }

  it('новая позиция в стоп-листе приходит подписчику только по его точкам', async () => {
    await link(KEEPER, w.keeperA);
    await link(MANAGER, w.manager);
    // сначала запоминаем состояние точек: первый проход молчит
    await soldOut(w.locA.id, 'Основа');
    env.telegram.sent.length = 0;
    await soldOut(w.locB.id, 'Чужая сметана');
    expect(env.telegram.to(MANAGER).join('\n')).toContain('Чужая сметана');
    expect(env.telegram.to(KEEPER).join('\n')).not.toContain('Чужая сметана');
    await soldOut(w.locA.id, 'Мой творог');
    expect(env.telegram.to(KEEPER).join('\n')).toContain('Мой творог');
  });

  it('выключенная тема уведомления не присылает', async () => {
    await link(MANAGER, w.manager);
    await soldOut(w.locA.id, 'Основа');
    await tap(MANAGER, 'sub:stoplist');
    env.telegram.sent.length = 0;
    await soldOut(w.locA.id, 'Мой творог');
    expect(env.telegram.to(MANAGER)).toEqual([]);
  });

  it('личная утренняя сводка уходит один раз за сутки и только по точкам сотрудника', async () => {
    const p = await addProduct(env, w.categoryId, { name: 'Мой творог', unit: 'kg', cost: 100 });
    await receive(env, w.manager.token, w.locA.id, [{ productId: p, quantity: 3, expiresOn: w.day(-1), unitCost: 100 }], { allowExpired: true });
    const other = await addProduct(env, w.categoryId, { name: 'Чужой кефир', unit: 'l', cost: 100 });
    await receive(env, w.manager.token, w.locB.id, [{ productId: other, quantity: 3, expiresOn: w.day(-1), unitCost: 100 }], { allowExpired: true });
    await link(KEEPER, w.keeperA);
    await link(MANAGER, w.manager);
    // 09:00 UTC это 12:00 в Москве
    await call(env, w.admin.token)('PUT', '/api/settings', { expiringSoonDays: 3, criticalDays: 1, forecastWindowDays: 28, reorderCoverDays: 7, lowPortionThreshold: 3, digestHour: 12 });
    env.telegram.sent.length = 0;

    await schedulerTick(env.deps);
    const keeper = env.telegram.to(KEEPER).filter((t) => t.includes('Сводка на'));
    expect(keeper).toHaveLength(1);
    expect(env.telegram.to(MANAGER).filter((t) => t.includes('Сводка на'))).toHaveLength(1);
    expect(env.telegram.sent.find((m) => m.chatId === KEEPER)?.buttons).toBeDefined();

    await schedulerTick(env.deps);
    expect(env.telegram.to(KEEPER).filter((t) => t.includes('Сводка на'))).toHaveLength(1);

    // кладовщик видит просрочку одной партии, менеджер двух
    const money = (text: string) => /Просрочено: (\d+) парт\./.exec(text)?.[1];
    expect(money(keeper[0] as string)).toBe('1');
    expect(money(env.telegram.to(MANAGER).find((t) => t.includes('Сводка на')) as string)).toBe('2');
  });

  it('отключённая тема сводки: сводка не приходит', async () => {
    await link(KEEPER, w.keeperA);
    await tap(KEEPER, 'sub:digest');
    await call(env, w.admin.token)('PUT', '/api/settings', { expiringSoonDays: 3, criticalDays: 1, forecastWindowDays: 28, reorderCoverDays: 7, lowPortionThreshold: 3, digestHour: 12 });
    env.telegram.sent.length = 0;
    await schedulerTick(env.deps);
    expect(env.telegram.to(KEEPER)).toEqual([]);
  });
});

describe('команда /hot', () => {
  it('показывает горячие блюда с причиной, когда они есть', async () => {
    const milk = await addProduct(env, w.categoryId, { name: 'Молоко', unit: 'l', sellable: false, cost: 60 });
    const dish = await env.owner.insertInto('dishes').values({ name: 'Каша манная', price: 160, created_at: env.clock.now, updated_at: env.clock.now }).returning('id').executeTakeFirstOrThrow();
    await env.owner.insertInto('dish_items').values({ dish_id: dish.id, product_id: milk, quantity: 0.2 }).execute();
    await receive(env, w.manager.token, w.kitchen.id, [{ productId: milk, quantity: 12, expiresOn: w.day(1) }]);
    await link(MANAGER, w.manager);
    const text = await env.chat(MANAGER, '/hot');
    expect(text).toContain('Горячие предложения');
    expect(text).toContain('Каша манная');
    expect(text).toContain('Молоко');
  });

  it('когда продвигать нечего, говорит об этом', async () => {
    await link(MANAGER, w.manager);
    expect(await env.chat(MANAGER, '/hot')).toContain('продвигать пока нечего');
  });
});
