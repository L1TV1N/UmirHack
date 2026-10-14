import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createWorld, type World } from './fixtures';
import { call, createTestEnv, createUser, TEST_PASSWORD, type TestEnv } from './helpers';

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

const CHAT = 7001;
const admin = () => call(env, w.admin.token);

/** Последний шестизначный код, который бот отправил в чат. */
const lastCode = (chatId = CHAT): string => {
  const text = env.telegram.to(chatId).at(-1) ?? '';
  const m = /<b>(\d{6})<\/b>/.exec(text);
  if (!m) throw new Error(`Кода нет в сообщении: ${text}`);
  return m[1] as string;
};

async function linkTelegram(userId: string, chatId = CHAT): Promise<void> {
  await env.db.insertInto('telegram_links').values({ user_id: userId, chat_id: chatId, username: null, linked_at: env.clock.now }).execute();
}

async function emailOf(userId: string): Promise<string> {
  return (await env.db.selectFrom('users').select('email').where('id', '=', userId).executeTakeFirstOrThrow()).email;
}

/** Администратор с включённой защитой: привязан чат, защита подтверждена кодом, получены резервные коды. */
async function protectedAdmin(): Promise<{ id: string; email: string; password: string; codes: string[] }> {
  const user = await createUser(env, { role: 'admin' });
  await linkTelegram(user.id);
  const login = await env.app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: user.email, password: user.password } });
  const token = login.json().accessToken as string;
  const start = await call(env, token)('POST', '/api/auth/2fa/start', { purpose: 'enable' });
  expect(start.statusCode, start.body).toBe(200);
  const confirm = await call(env, token)('POST', '/api/auth/2fa/confirm', { challengeId: start.json().challengeId, code: lastCode() });
  expect(confirm.statusCode, confirm.body).toBe(200);
  return { ...user, codes: confirm.json().recoveryCodes as string[] };
}

const loginRaw = (user: { email: string; password: string }) =>
  env.app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: user.email, password: user.password } });
const verify = (challengeId: string, code: string) => env.app.inject({ method: 'POST', url: '/api/auth/2fa/verify', payload: { challengeId, code } });

describe('включение подтверждения входа', () => {
  it('статус: администратору доступно, остальным нет; без привязанного чата включить нельзя', async () => {
    const status = (await admin()('GET', '/api/auth/2fa')).json();
    expect(status).toMatchObject({ eligible: true, botConfigured: true, telegramLinked: false, enabled: false, recoveryCodesLeft: 0 });
    expect((await call(env, w.manager.token)('GET', '/api/auth/2fa')).json().eligible).toBe(false);

    const start = await admin()('POST', '/api/auth/2fa/start', { purpose: 'enable' });
    expect(start.statusCode).toBe(409);
    expect(start.json().error.code).toBe('telegram_not_linked');
    expect((await call(env, w.manager.token)('POST', '/api/auth/2fa/start', { purpose: 'enable' })).statusCode).toBe(403);
  });

  it('код приходит в Telegram, неверный не подходит, верный включает защиту и выдаёт резервные коды', async () => {
    const adminUser = await createUser(env, { role: 'admin' });
    await linkTelegram(adminUser.id);
    const token = (await loginRaw(adminUser)).json().accessToken as string;
    const as = call(env, token);

    const start = await as('POST', '/api/auth/2fa/start', { purpose: 'enable' });
    expect(start.statusCode).toBe(200);
    expect(start.json()).toMatchObject({ delivered: true, expiresIn: 300 });
    const code = lastCode();
    expect(env.telegram.last(CHAT)).toContain('Никому его не сообщайте');

    const wrong = await as('POST', '/api/auth/2fa/confirm', { challengeId: start.json().challengeId, code: code === '000000' ? '111111' : '000000' });
    expect(wrong.statusCode).toBe(401);
    expect(wrong.json().error.code).toBe('invalid_code');
    expect(wrong.json().error.message).toContain('Осталось попыток: 4');

    const ok = await as('POST', '/api/auth/2fa/confirm', { challengeId: start.json().challengeId, code });
    expect(ok.statusCode).toBe(200);
    const { enabled, recoveryCodes } = ok.json();
    expect(enabled).toBe(true);
    expect(recoveryCodes).toHaveLength(8);
    expect(new Set(recoveryCodes).size).toBe(8);
    expect(recoveryCodes.every((c: string) => /^[A-Z2-9]{10}$/.test(c))).toBe(true);

    expect((await as('GET', '/api/auth/2fa')).json()).toMatchObject({ enabled: true, recoveryCodesLeft: 8 });
    expect(env.telegram.last(CHAT)).toContain('Подтверждение входа включено');
    // тот же код второй раз не подходит
    expect((await as('POST', '/api/auth/2fa/confirm', { challengeId: start.json().challengeId, code })).statusCode).toBe(401);
    const audit = (await admin()('GET', '/api/audit?action=2fa.enable')).json();
    expect(audit.items).toHaveLength(1);
  });

  it('если Telegram не отвечает, включить нельзя: защита без рабочего канала заперла бы администратора', async () => {
    const user = await createUser(env, { role: 'admin' });
    await linkTelegram(user.id);
    const token = (await loginRaw(user)).json().accessToken as string;
    const original = env.telegram.sendMessage.bind(env.telegram);
    env.telegram.sendMessage = async () => {
      throw new Error('сеть недоступна');
    };
    try {
      const start = await call(env, token)('POST', '/api/auth/2fa/start', { purpose: 'enable' });
      expect(start.statusCode).toBe(502);
      expect(start.json().error.code).toBe('telegram_unavailable');
    } finally {
      env.telegram.sendMessage = original;
    }
    expect((await call(env, token)('GET', '/api/auth/2fa')).json().enabled).toBe(false);
  });

  it('код не хранится открытым текстом', async () => {
    const user = await createUser(env, { role: 'admin' });
    await linkTelegram(user.id);
    const token = (await loginRaw(user)).json().accessToken as string;
    await call(env, token)('POST', '/api/auth/2fa/start', { purpose: 'enable' });
    const code = lastCode();
    const row = await env.db.selectFrom('login_challenges').selectAll().executeTakeFirstOrThrow();
    expect(row.code_hash).toHaveLength(64);
    expect(row.code_hash).not.toContain(code);
    expect(JSON.stringify(row)).not.toContain(`"${code}"`);
  });
});

describe('вход с подтверждением', () => {
  it('после пароля сессии нет: нужен код, с верным кодом вход проходит', async () => {
    const user = await protectedAdmin();
    const first = await loginRaw(user);
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ twoFactorRequired: true, delivered: true, expiresIn: 300, resendAfter: 30 });
    expect(first.json().accessToken).toBeUndefined();
    expect(first.cookies.find((c) => c.name === 'zapas_rt')).toBeUndefined();

    const done = await verify(first.json().challengeId, lastCode());
    expect(done.statusCode, done.body).toBe(200);
    expect(done.json().accessToken).toBeTruthy();
    expect(done.cookies.find((c) => c.name === 'zapas_rt')).toBeTruthy();
    expect((await call(env, done.json().accessToken)('GET', '/api/auth/me')).statusCode).toBe(200);
    const audit = (await admin()('GET', '/api/audit?action=auth.login')).json();
    expect(JSON.stringify(audit.items)).toContain('telegram');
  });

  it('неверный пароль до кода не доходит: ни запроса, ни сообщения в чат', async () => {
    const user = await protectedAdmin();
    const before = env.telegram.to(CHAT).length;
    const res = await env.app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: user.email, password: 'не-тот-пароль-совсем' } });
    expect(res.statusCode).toBe(401);
    expect(env.telegram.to(CHAT).length).toBe(before);
  });

  it('код одноразовый и живёт пять минут', async () => {
    const user = await protectedAdmin();
    const first = await loginRaw(user);
    const code = lastCode();
    expect((await verify(first.json().challengeId, code)).statusCode).toBe(200);
    const again = await verify(first.json().challengeId, code);
    expect(again.statusCode).toBe(401);
    expect(again.json().error.code).toBe('invalid_challenge');

    const second = await loginRaw(user);
    const late = lastCode();
    env.clock.advance(5 * 60_000 + 1000);
    expect((await verify(second.json().challengeId, late)).statusCode).toBe(401);
  });

  it('пять неверных кодов закрывают запрос, даже верный код потом не принимается, а запись блокируется', async () => {
    const user = await protectedAdmin();
    const start = await loginRaw(user);
    const id = start.json().challengeId as string;
    const real = lastCode();
    const bad = real === '123456' ? '654321' : '123456';
    for (let i = 0; i < 5; i += 1) {
      const res = await verify(id, bad);
      expect(res.statusCode).toBe(401);
      expect(res.json().error.code).toBe('invalid_code');
    }
    const late = await verify(id, real);
    expect(late.statusCode).toBe(401);
    // запись уже заблокирована пятой неудачей, запрос закрыт в любом случае
    expect(['challenge_exhausted', 'invalid_challenge']).toContain(late.json().error.code);
    // подбор кода считается теми же неудачами, что и подбор пароля: запись заблокирована
    const again = await loginRaw(user);
    expect(again.statusCode).toBe(401);
    expect(again.json().error.code).toBe('invalid_credentials');
  });

  it('код привязан к запросу: код одного запроса не подходит к другому', async () => {
    const user = await protectedAdmin();
    const first = await loginRaw(user);
    const codeFirst = lastCode();
    const second = await loginRaw(user);
    const res = await verify(second.json().challengeId, codeFirst);
    expect(res.statusCode).toBe(401);
    // новый запрос заменил прежний того же назначения
    expect((await verify(first.json().challengeId, codeFirst)).statusCode).toBe(401);
  });

  it('повторная отправка: не чаще раза в полминуты и не больше трёх раз, прежний код перестаёт действовать', async () => {
    const user = await protectedAdmin();
    const start = await loginRaw(user);
    const id = start.json().challengeId as string;
    const old = lastCode();
    const post = () => env.app.inject({ method: 'POST', url: '/api/auth/2fa/resend', payload: { challengeId: id } });

    const soon = await post();
    expect(soon.statusCode).toBe(429);
    expect(soon.json().error.code).toBe('resend_too_soon');

    env.clock.advance(31_000);
    expect((await post()).statusCode).toBe(200);
    const fresh = lastCode();
    expect(fresh).not.toBe(old);
    env.clock.advance(31_000);
    expect((await post()).statusCode).toBe(200);
    env.clock.advance(31_000);
    const limit = await post();
    expect(limit.statusCode).toBe(429);
    expect(limit.json().error.code).toBe('resend_limit');

    expect((await verify(id, old)).statusCode).toBe(401);
    expect((await verify(id, lastCode())).statusCode).toBe(200);
  });

  it('запросы кода ограничены, чтобы чужой пароль не заваливал чат сообщениями', async () => {
    const user = await protectedAdmin();
    let last = 200;
    for (let i = 0; i < 12 && last === 200; i += 1) last = (await loginRaw(user)).statusCode;
    expect(last).toBe(429);
  });

  it('менеджер с включённым флагом входит как обычно: защита только для администратора', async () => {
    const manager = await createUser(env, { role: 'manager' });
    await env.db.updateTable('users').set({ two_factor_enabled: true }).where('id', '=', manager.id).execute();
    const res = await loginRaw(manager);
    expect(res.statusCode).toBe(200);
    expect(res.json().accessToken).toBeTruthy();
  });
});

describe('резервные коды и недоступный Telegram', () => {
  it('резервный код заменяет код из Telegram и работает один раз', async () => {
    const user = await protectedAdmin();
    const [first, second] = user.codes as [string, string];
    const start = await loginRaw(user);
    const formatted = `${first.slice(0, 5)}-${first.slice(5).toLowerCase()}`;
    const done = await verify(start.json().challengeId, formatted);
    expect(done.statusCode, done.body).toBe(200);
    expect(env.telegram.last(CHAT)).toContain('по резервному коду');
    expect(env.telegram.last(CHAT)).toContain('Осталось кодов: 7');

    const next = await loginRaw(user);
    expect((await verify(next.json().challengeId, first)).statusCode).toBe(401);
    const third = await loginRaw(user);
    expect((await verify(third.json().challengeId, second)).statusCode).toBe(200);
  });

  it('если Telegram не отвечает, вход возможен по резервному коду', async () => {
    const user = await protectedAdmin();
    const original = env.telegram.sendMessage.bind(env.telegram);
    env.telegram.sendMessage = async () => {
      throw new Error('сеть недоступна');
    };
    try {
      const start = await loginRaw(user);
      expect(start.statusCode).toBe(200);
      expect(start.json()).toMatchObject({ twoFactorRequired: true, delivered: false });
      const done = await verify(start.json().challengeId, user.codes[0] as string);
      expect(done.statusCode, done.body).toBe(200);
    } finally {
      env.telegram.sendMessage = original;
    }
  });

  it('новый набор резервных кодов требует пароль и код, прежние перестают действовать', async () => {
    const user = await protectedAdmin();
    const token = (await verify((await loginRaw(user)).json().challengeId, lastCode())).json().accessToken as string;
    const as = call(env, token);

    const noPassword = await as('POST', '/api/auth/2fa/start', { purpose: 'recovery' });
    expect(noPassword.statusCode).toBe(400);
    const start = await as('POST', '/api/auth/2fa/start', { purpose: 'recovery', password: user.password });
    expect(start.statusCode).toBe(200);
    const confirm = await as('POST', '/api/auth/2fa/confirm', { challengeId: start.json().challengeId, code: lastCode() });
    expect(confirm.statusCode).toBe(200);
    const fresh = confirm.json().recoveryCodes as string[];
    expect(fresh).toHaveLength(8);
    expect(fresh.some((c) => user.codes.includes(c))).toBe(false);

    const next = await loginRaw(user);
    expect((await verify(next.json().challengeId, user.codes[0] as string)).statusCode).toBe(401);
    const another = await loginRaw(user);
    expect((await verify(another.json().challengeId, fresh[0] as string)).statusCode).toBe(200);
  });
});

describe('кнопка «Это не я»', () => {
  it('закрывает запрос, блокирует запись и отзывает сессии; чужой чат не может', async () => {
    const user = await protectedAdmin();
    const open = await verify((await loginRaw(user)).json().challengeId, lastCode());
    expect(open.statusCode).toBe(200);
    const session = open.json().accessToken as string;

    const start = await loginRaw(user);
    const id = start.json().challengeId as string;
    const button = env.telegram.sent.at(-1)?.buttons?.[0]?.[0];
    expect(button?.text).toBe('Это не я');
    expect(button?.data).toBe(`2fa-no:${id}`);

    // чужой чат ничего не отзывает
    const stranger = await createUser(env, { role: 'admin' });
    await linkTelegram(stranger.id, 7777);
    await env.bot.handleUpdate(env.telegram.tap(7777, `2fa-no:${id}`));
    expect((await verify(id, lastCode())).statusCode).toBe(200);

    const again = await loginRaw(user);
    const id2 = again.json().challengeId as string;
    await env.bot.handleUpdate(env.telegram.tap(CHAT, `2fa-no:${id2}`));
    expect(env.telegram.edits.at(-1)?.text).toContain('Вход отклонён');
    expect((await verify(id2, lastCode())).statusCode).toBe(401);
    expect((await loginRaw(user)).statusCode).toBe(401);
    // сессия, открытая раньше, закрыта: обновить её нельзя
    const row = await env.db.selectFrom('refresh_tokens').select('revoked_at').where('user_id', '=', user.id).execute();
    expect(row.every((r) => r.revoked_at !== null)).toBe(true);
    expect(session).toBeTruthy();
    const audit = (await admin()('GET', '/api/audit?action=auth.2fa_denied')).json();
    expect(audit.items).toHaveLength(1);
  });
});

describe('отключение и связь с Telegram', () => {
  it('выключить защиту можно только с паролем и кодом; после этого вход по одному паролю', async () => {
    const user = await protectedAdmin();
    const token = (await verify((await loginRaw(user)).json().challengeId, lastCode())).json().accessToken as string;
    const as = call(env, token);

    const wrong = await as('POST', '/api/auth/2fa/start', { purpose: 'disable', password: 'не-тот-пароль-совсем' });
    expect(wrong.statusCode).toBe(400);
    expect(wrong.json().error.code).toBe('wrong_password');
    const start = await as('POST', '/api/auth/2fa/start', { purpose: 'disable', password: user.password });
    expect(start.statusCode).toBe(200);
    const done = await as('POST', '/api/auth/2fa/confirm', { challengeId: start.json().challengeId, code: lastCode() });
    expect(done.json()).toEqual({ enabled: false, recoveryCodes: null });
    expect(env.telegram.last(CHAT)).toContain('выключено');

    const plain = await loginRaw(user);
    expect(plain.json().accessToken).toBeTruthy();
    expect(await env.db.selectFrom('recovery_codes').select('code_hash').where('user_id', '=', user.id).execute()).toEqual([]);
  });

  it('чат нельзя отвязать или заменить, пока защита включена', async () => {
    const user = await protectedAdmin();
    const token = (await verify((await loginRaw(user)).json().challengeId, lastCode())).json().accessToken as string;
    const as = call(env, token);
    const del = await as('DELETE', '/api/telegram/link');
    expect(del.statusCode).toBe(409);
    expect(del.json().error.code).toBe('two_factor_enabled');
    expect((await as('POST', '/api/telegram/link-code')).statusCode).toBe(409);
    expect(await env.chat(CHAT, '/unlink')).toContain('вторым фактором');
    expect((await as('GET', '/api/auth/2fa')).json().telegramLinked).toBe(true);
  });

  it('смена пароля оставляет чат и защиту, отключение учётной записи снимает обе', async () => {
    const user = await protectedAdmin();
    const token = (await verify((await loginRaw(user)).json().challengeId, lastCode())).json().accessToken as string;
    const change = await call(env, token)('POST', '/api/auth/change-password', { currentPassword: user.password, newPassword: 'Новая-длинная-фраза-2026' });
    expect(change.statusCode).toBe(204);
    const row = await env.db.selectFrom('users').select('two_factor_enabled').where('id', '=', user.id).executeTakeFirstOrThrow();
    expect(row.two_factor_enabled).toBe(true);
    expect(await env.db.selectFrom('telegram_links').select('user_id').where('user_id', '=', user.id).execute()).toHaveLength(1);
    // новый вход снова требует код
    expect((await loginRaw({ email: user.email, password: 'Новая-длинная-фраза-2026' })).json().twoFactorRequired).toBe(true);

    const off = await admin()('PATCH', `/api/users/${user.id}`, { isActive: false });
    expect(off.statusCode, off.body).toBe(200);
    const after = await env.db.selectFrom('users').select('two_factor_enabled').where('id', '=', user.id).executeTakeFirstOrThrow();
    expect(after.two_factor_enabled).toBe(false);
    expect(await env.db.selectFrom('telegram_links').select('user_id').where('user_id', '=', user.id).execute()).toHaveLength(0);
  });

  it('сброс пароля другим администратором тоже оставляет защиту', async () => {
    const user = await protectedAdmin();
    const res = await admin()('PUT', `/api/users/${user.id}/password`, { password: 'Совсем-новая-фраза-2026' });
    expect(res.statusCode, res.body).toBe(204);
    const row = await env.db.selectFrom('users').select('two_factor_enabled').where('id', '=', user.id).executeTakeFirstOrThrow();
    expect(row.two_factor_enabled).toBe(true);
  });

  it('код привязки другого чата не подменяет второй фактор', async () => {
    const user = await protectedAdmin();
    // код создан до включения защиты и предъявлен после
    await env.db
      .insertInto('telegram_link_codes')
      .values({ code_hash: (await import('../src/lib/crypto')).sha256Hex('ABCDEFGH'), user_id: user.id, expires_at: new Date(env.clock.now.getTime() + 60_000) })
      .execute();
    const reply = await env.chat(9999, '/link ABCDEFGH');
    expect(reply).toContain('вторым фактором');
    expect(await env.db.selectFrom('telegram_links').select('chat_id').where('user_id', '=', user.id).executeTakeFirstOrThrow()).toMatchObject({ chat_id: CHAT });
  });
});

describe('сброс защиты коллеге', () => {
  it('администратор сбрасывает чужую защиту, себе не может, посторонний и менеджер не могут', async () => {
    const colleague = await protectedAdmin();
    expect((await call(env, w.manager.token)('POST', `/api/users/${colleague.id}/two-factor/reset`)).statusCode).toBe(403);

    const self = await admin()('POST', `/api/users/${w.admin.userId}/two-factor/reset`);
    expect(self.statusCode).toBe(400);
    expect(self.json().error.code).toBe('use_disable');

    const other = await env.app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { organizationName: 'ООО «Сосед»', fullName: 'Орлова Наталья Сергеевна', email: 'owner@neighbour.example', password: 'Хорошая-длинная-фраза-91' },
    });
    expect((await call(env, other.json().accessToken)('POST', `/api/users/${colleague.id}/two-factor/reset`)).statusCode).toBe(404);

    const ok = await admin()('POST', `/api/users/${colleague.id}/two-factor/reset`);
    expect(ok.statusCode, ok.body).toBe(204);
    expect(env.telegram.last(CHAT)).toContain('Администратор сбросил');
    expect((await loginRaw(colleague)).json().accessToken).toBeTruthy();
    expect((await admin()('POST', `/api/users/${colleague.id}/two-factor/reset`)).statusCode).toBe(409);
    const audit = (await admin()('GET', '/api/audit?action=2fa.reset')).json();
    expect(audit.items).toHaveLength(1);
    expect(await emailOf(colleague.id)).toBe(colleague.email);
  });

  it('в списке пользователей видно, у кого защита включена', async () => {
    const colleague = await protectedAdmin();
    const users = (await admin()('GET', '/api/users')).json().items as { id: string; twoFactorEnabled: boolean }[];
    expect(users.find((u) => u.id === colleague.id)?.twoFactorEnabled).toBe(true);
    expect(users.find((u) => u.id === w.admin.userId)?.twoFactorEnabled).toBe(false);
    expect(TEST_PASSWORD).toBeTruthy();
  });
});
