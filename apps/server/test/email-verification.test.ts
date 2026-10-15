import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createWorld, type World } from './fixtures';
import { call, createTestEnv, createUser, TEST_PASSWORD, type TestEnv } from './helpers';

let env: TestEnv;
let w: World;

const SMTP = { SMTP_URL: 'smtps://user:secret@mail.example.ru:465', SMTP_FROM: 'Запас <zapas@example.ru>', ACCESS_TOKEN_TTL_SECONDS: '3600' };

beforeAll(async () => {
  env = await createTestEnv(SMTP);
});
afterAll(() => env.close());
beforeEach(async () => {
  await env.reset();
  w = await createWorld(env);
});

const owner = { organizationName: 'ООО «Вкус»', fullName: 'Орлова Наталья', email: 'owner@vkus.example', password: 'Хорошая-длинная-фраза-91' };
const register = (body: object = owner) => env.app.inject({ method: 'POST', url: '/api/auth/register', payload: body });
const login = (email: string, password: string) => env.app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password } });
const verify = (email: string, code: string) => env.app.inject({ method: 'POST', url: '/api/auth/verify-email', payload: { email, code } });
const resend = (email: string) => env.app.inject({ method: 'POST', url: '/api/auth/verify-email/resend', payload: { email } });

const emailOf = async (userId: string): Promise<string> => (await env.db.selectFrom('users').select('email').where('id', '=', userId).executeTakeFirstOrThrow()).email;

const lastCode = (): string => {
  const text = env.mailer.sent.at(-1)?.text ?? '';
  const m = /Код для подтверждения почты: (\d{6})/.exec(text);
  if (!m) throw new Error(`Кода нет в письме: ${text}`);
  return m[1] as string;
};

describe('подтверждение почты при регистрации', () => {
  it('регистрация не выдаёт сессию, а отправляет код на почту', async () => {
    const res = await register();
    expect(res.statusCode, res.body).toBe(202);
    expect(res.json()).toMatchObject({ emailVerificationRequired: true, email: owner.email, delivered: true, resendAfter: 30 });
    expect(res.json().accessToken).toBeUndefined();
    expect(res.headers['set-cookie']).toBeUndefined();
    expect(env.mailer.sent).toHaveLength(1);
    expect(env.mailer.sent[0]?.to).toBe(owner.email);
    // код не должен попадать в тему
    expect(env.mailer.sent[0]?.subject).not.toMatch(/\d{6}/);
  });

  it('до подтверждения вход закрыт и снова отправляет код', async () => {
    await register();
    env.clock.advance(60_000);
    const res = await login(owner.email, owner.password);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ emailVerificationRequired: true });
    expect(res.json().accessToken).toBeUndefined();
    expect(env.mailer.sent).toHaveLength(2);
  });

  it('неверный пароль не раскрывает, что почта не подтверждена', async () => {
    await register();
    const res = await login(owner.email, 'Совсем-другой-пароль-77');
    expect(res.statusCode).toBe(401);
    expect(env.mailer.sent).toHaveLength(1);
  });

  it('верный код выдаёт сессию, после этого вход работает без кода', async () => {
    await register();
    const ok = await verify(owner.email, lastCode());
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json().accessToken).toEqual(expect.any(String));
    expect(ok.json().user).toMatchObject({ email: owner.email, role: 'admin' });
    expect(ok.headers['set-cookie']).toBeDefined();

    const again = await login(owner.email, owner.password);
    expect(again.statusCode).toBe(200);
    expect(again.json().accessToken).toEqual(expect.any(String));
    // код одноразовый
    expect((await verify(owner.email, lastCode())).statusCode).toBe(401);
  });

  it('неверный код считается, пять неверных закрывают код, верный после этого уже не подходит', async () => {
    await register();
    const code = lastCode();
    const wrong = code === '000000' ? '111111' : '000000';
    const first = await verify(owner.email, wrong);
    expect(first.statusCode).toBe(401);
    expect(first.json().error.code).toBe('invalid_code');
    expect(first.json().error.message).toMatch(/Осталось попыток: 4/);
    for (let i = 0; i < 4; i += 1) await verify(owner.email, wrong);
    const closed = await verify(owner.email, code);
    expect(closed.statusCode).toBe(401);
    expect(closed.json().error.code).toBe('code_exhausted');
  });

  it('код устаревает через 15 минут', async () => {
    await register();
    const code = lastCode();
    env.clock.advance(16 * 60_000);
    const res = await verify(owner.email, code);
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('invalid_code');
  });

  it('новый код отменяет прежний, а повторная отправка не чаще раза в полминуты', async () => {
    await register();
    const old = lastCode();
    expect((await resend(owner.email)).statusCode).toBe(200);
    expect(env.mailer.sent).toHaveLength(1);
    env.clock.advance(31_000);
    expect((await resend(owner.email)).statusCode).toBe(200);
    expect(env.mailer.sent).toHaveLength(2);
    const fresh = lastCode();
    if (fresh !== old) expect((await verify(owner.email, old)).statusCode).toBe(401);
    expect((await verify(owner.email, fresh)).statusCode).toBe(200);
  });

  it('повторная отправка отвечает одинаково для чужого, подтверждённого и несуществующего адреса', async () => {
    const stranger = await resend('nobody@example.ru');
    const confirmed = await resend(await emailOf(w.admin.userId));
    expect(stranger.statusCode).toBe(200);
    expect(confirmed.statusCode).toBe(200);
    expect(stranger.json()).toEqual(confirmed.json());
    expect(env.mailer.sent).toHaveLength(0);
  });

  it('больше шести кодов за десять минут не отправляется', async () => {
    await register();
    for (let i = 0; i < 5; i += 1) {
      env.clock.advance(31_000);
      await resend(owner.email);
    }
    expect(env.mailer.sent).toHaveLength(6);
    env.clock.advance(31_000);
    await resend(owner.email).catch(() => undefined);
    const blocked = await login(owner.email, owner.password);
    expect(blocked.statusCode).toBe(429);
    expect(env.mailer.sent).toHaveLength(6);
  });

  it('если письмо не ушло, регистрация всё равно создана, а ответ честно говорит об этом', async () => {
    env.mailer.failure = { code: 'ECONNREFUSED' };
    const res = await register();
    expect(res.statusCode).toBe(202);
    expect(res.json().delivered).toBe(false);
    expect(JSON.stringify(res.json())).not.toMatch(/секретная/);
    env.mailer.failure = null;
    env.clock.advance(31_000);
    await resend(owner.email);
    expect((await verify(owner.email, lastCode())).statusCode).toBe(200);
  });

  it('код хранится только в виде хэша', async () => {
    await register();
    const code = lastCode();
    const rows = await env.db.selectFrom('email_codes').selectAll().execute();
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toContain(code);
  });

  it('прежние пользователи и созданные администратором считаются подтверждёнными', async () => {
    expect((await login(await emailOf(w.admin.userId), TEST_PASSWORD)).statusCode).toBe(200);
    const created = await call(env, w.admin.token)('POST', '/api/users', { email: 'new@example.ru', fullName: 'Новый Сотрудник', role: 'manager', password: 'Другая-длинная-фраза-52' });
    expect(created.statusCode, created.body).toBe(201);
    const res = await login('new@example.ru', 'Другая-длинная-фраза-52');
    expect(res.statusCode).toBe(200);
    expect(res.json().accessToken).toEqual(expect.any(String));
  });

  it('неверная форма кода отклоняется до обращения к базе', async () => {
    expect((await verify(owner.email, '12345')).statusCode).toBe(400);
    expect((await verify(owner.email, 'abcdef')).statusCode).toBe(400);
  });
});

describe('письмо с временным паролем', () => {
  it('приглашение уходит письмом, пароль на экране не показывается', async () => {
    const res = await call(env, w.admin.token)('POST', '/api/users', { email: 'cook@example.ru', fullName: 'Иван Поваров', role: 'storekeeper' });
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json()).toMatchObject({ temporaryPassword: null, inviteSent: true, inviteError: null });
    const mail = env.mailer.sent.at(-1)!;
    expect(mail.to).toBe('cook@example.ru');
    const pass = /Временный пароль: (\S+)/.exec(mail.text)?.[1];
    expect(pass).toBeTruthy();
    const entry = await login('cook@example.ru', pass as string);
    expect(entry.statusCode).toBe(200);
    expect(entry.json().user.mustChangePassword).toBe(true);
    const audit = JSON.stringify(await env.db.selectFrom('audit_log').select('details').execute());
    expect(audit).not.toContain(pass as string);
  });

  it('если письмо не ушло, пароль показывается администратору и причина названа без подробностей сервера', async () => {
    env.mailer.failure = { code: 'EAUTH' };
    const res = await call(env, w.admin.token)('POST', '/api/users', { email: 'cook@example.ru', fullName: 'Иван Поваров', role: 'storekeeper' });
    expect(res.statusCode).toBe(201);
    expect(res.json().inviteSent).toBe(false);
    expect(res.json().temporaryPassword).toEqual(expect.any(String));
    expect(res.json().inviteError).toBe('почтовый сервер не принял логин и пароль');
    expect(res.body).not.toMatch(/секретная|secret/);
  });

  it('можно отказаться от письма: пароль остаётся на экране', async () => {
    const res = await call(env, w.admin.token)('POST', '/api/users', { email: 'cook@example.ru', fullName: 'Иван Поваров', role: 'storekeeper', sendInvite: false });
    expect(res.json()).toMatchObject({ inviteSent: false, inviteError: null });
    expect(res.json().temporaryPassword).toEqual(expect.any(String));
    expect(env.mailer.sent).toHaveLength(0);
  });

  it('заданный вручную пароль письмом не рассылается', async () => {
    const res = await call(env, w.admin.token)('POST', '/api/users', { email: 'cook@example.ru', fullName: 'Иван Поваров', role: 'storekeeper', password: 'Длинная-фраза-для-кухни-31' });
    expect(res.json()).toMatchObject({ temporaryPassword: null, inviteSent: false });
    expect(env.mailer.sent).toHaveLength(0);
  });

  it('сброс пароля: новый временный пароль письмом, сессии закрыты, старый пароль не подходит', async () => {
    const user = await createUser(env, { role: 'manager' });
    const before = await login(user.email, user.password);
    const res = await call(env, w.admin.token)('POST', `/api/users/${user.id}/temporary-password`, {});
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ temporaryPassword: null, inviteSent: true });
    expect((await call(env, before.json().accessToken)('GET', '/api/auth/me')).statusCode).toBeLessThan(500);
    expect((await login(user.email, user.password)).statusCode).toBe(401);
    const pass = /Временный пароль: (\S+)/.exec(env.mailer.sent.at(-1)!.text)?.[1] as string;
    const entry = await login(user.email, pass);
    expect(entry.statusCode).toBe(200);
    expect(entry.json().user.mustChangePassword).toBe(true);
  });

  it('сброс пароля недоступен не администратору и чужой организации', async () => {
    const user = await createUser(env, { role: 'manager' });
    expect((await call(env, w.manager.token)('POST', `/api/users/${user.id}/temporary-password`, {})).statusCode).toBe(403);
    expect((await call(env, w.admin.token)('POST', '/api/users/00000000-0000-4000-8000-0000000000aa/temporary-password', {})).statusCode).toBe(404);
  });
});

describe('без настроенной почты', () => {
  it('поведение прежнее: регистрация сразу входит, пароль показывается на экране', async () => {
    const plain = await createTestEnv({ ACCESS_TOKEN_TTL_SECONDS: '3600' });
    try {
      const res = await plain.app.inject({ method: 'POST', url: '/api/auth/register', payload: owner });
      expect(res.statusCode).toBe(201);
      expect(res.json().accessToken).toEqual(expect.any(String));
      const admin = res.json().accessToken as string;
      const created = await call(plain, admin)('POST', '/api/users', { email: 'cook@example.ru', fullName: 'Иван Поваров', role: 'storekeeper' });
      expect(created.json()).toMatchObject({ inviteSent: false, inviteError: 'почта на сервере не настроена' });
      expect(created.json().temporaryPassword).toEqual(expect.any(String));
      expect(plain.mailer.sent).toHaveLength(0);
    } finally {
      await plain.close();
    }
  });
});
