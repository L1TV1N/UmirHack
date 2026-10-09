import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { call, createTestEnv, createUser, loginAs, TEST_PASSWORD, type TestEnv } from './helpers';

let env: TestEnv;

beforeAll(async () => {
  env = await createTestEnv();
});
afterAll(() => env.close());
beforeEach(() => env.reset());

describe('вход', () => {
  it('выдаёт токен и ставит httpOnly cookie с ограниченным путём', async () => {
    const user = await createUser(env, { role: 'manager' });
    const res = await env.app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: user.email, password: user.password } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.accessToken).toMatch(/^eyJ/);
    expect(body.user).toMatchObject({ email: user.email, role: 'manager' });
    expect(body.user).not.toHaveProperty('passwordHash');
    const cookie = res.cookies.find((c) => c.name === 'zapas_rt');
    expect(cookie).toMatchObject({ httpOnly: true, sameSite: 'Strict', path: '/api/auth' });
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('одинаково отвечает на неверный пароль и неизвестный адрес', async () => {
    const user = await createUser(env);
    const bad = await env.app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: user.email, password: 'Неверный-пароль-1' } });
    const unknown = await env.app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'nobody@example.ru', password: 'Неверный-пароль-1' } });
    expect(bad.statusCode).toBe(401);
    expect(unknown.statusCode).toBe(401);
    expect(bad.json().error).toEqual(unknown.json().error);
  });

  it('не принимает лишних полей и разбирает адрес без учёта регистра', async () => {
    const user = await createUser(env, { email: 'mixed@example.ru' });
    const extra = await env.app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: user.email, password: user.password, role: 'admin' } });
    expect(extra.statusCode).toBe(400);
    expect(extra.json().error.code).toBe('validation_error');
    const upper = await env.app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: ' MIXED@Example.RU ', password: user.password } });
    expect(upper.statusCode).toBe(200);
  });

  it('блокирует учётную запись после серии неудач и снимает блокировку по времени', async () => {
    const user = await createUser(env);
    for (let i = 0; i < 5; i += 1) {
      const r = await env.app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: user.email, password: 'Неверный-пароль-1' } });
      expect(r.statusCode).toBe(401);
    }
    const locked = await env.app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: user.email, password: user.password } });
    expect(locked.statusCode).toBe(401);

    env.clock.advance(61_000);
    const ok = await env.app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: user.email, password: user.password } });
    expect(ok.statusCode).toBe(200);
  });

  it('не пускает отключённого пользователя', async () => {
    const user = await createUser(env, { isActive: false });
    const res = await env.app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: user.email, password: user.password } });
    expect(res.statusCode).toBe(401);
  });

  it('пишет в аудит и успех, и неудачу', async () => {
    const user = await createUser(env);
    await env.app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: user.email, password: 'Неверный-пароль-1' } });
    await loginAs(env, user);
    const rows = await env.owner.selectFrom('audit_log').select(['action', 'user_email']).orderBy('id').execute();
    expect(rows.map((r) => r.action)).toEqual(['auth.login_failed', 'auth.login']);
  });
});

describe('доступ к защищённым маршрутам', () => {
  it('требует токен и отвергает мусор', async () => {
    expect((await call(env, null)('GET', '/api/auth/me')).statusCode).toBe(401);
    expect((await call(env, 'не.токен.вовсе')('GET', '/api/auth/me')).statusCode).toBe(401);
    expect((await env.app.inject({ method: 'GET', url: '/api/auth/me', headers: { authorization: 'Basic abc' } })).statusCode).toBe(401);
  });

  it('отвергает истёкший токен', async () => {
    const session = await loginAs(env, await createUser(env));
    env.clock.advance((env.config.accessTokenTtl + 5) * 1000);
    const res = await call(env, session.token)('GET', '/api/auth/me');
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('token_expired');
  });

  it('сразу перестаёт пускать отключённого пользователя', async () => {
    const user = await createUser(env);
    const session = await loginAs(env, user);
    expect((await call(env, session.token)('GET', '/api/auth/me')).statusCode).toBe(200);
    await env.db.updateTable('users').set({ is_active: false }).where('id', '=', user.id).execute();
    expect((await call(env, session.token)('GET', '/api/auth/me')).statusCode).toBe(401);
  });

  it('не принимает токен, подписанный другим ключом', async () => {
    const { SignJWT } = await import('jose');
    const forged = await new SignJWT({ role: 'admin' })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject('00000000-0000-4000-8000-000000000000')
      .setIssuer('zapas')
      .setAudience('zapas-web')
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(new TextEncoder().encode('совсем-другой-секрет-совсем-другой-секрет'));
    expect((await call(env, forged)('GET', '/api/auth/me')).statusCode).toBe(401);
  });

  it('не принимает токен с алгоритмом none', async () => {
    const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const token = `${b64({ alg: 'none', typ: 'JWT' })}.${b64({ sub: 'x', iss: 'zapas', aud: 'zapas-web', exp: 9_999_999_999, iat: 1 })}.`;
    expect((await call(env, token)('GET', '/api/auth/me')).statusCode).toBe(401);
  });
});

describe('обновление сессии', () => {
  const refreshWith = (cookie: string, headers: Record<string, string> = {}) =>
    env.app.inject({ method: 'POST', url: '/api/auth/refresh', cookies: { zapas_rt: cookie }, headers });

  it('выдаёт новый токен и заменяет refresh-cookie', async () => {
    const session = await loginAs(env, await createUser(env));
    env.clock.advance(5_000);
    const res = await refreshWith(session.cookie);
    expect(res.statusCode).toBe(200);
    const next = res.cookies.find((c) => c.name === 'zapas_rt')?.value;
    expect(next).toBeTruthy();
    expect(next).not.toBe(session.cookie);
    expect((await call(env, res.json().accessToken)('GET', '/api/auth/me')).statusCode).toBe(200);
  });

  it('при повторном предъявлении старого токена отзывает всю цепочку', async () => {
    const session = await loginAs(env, await createUser(env));
    env.clock.advance(1_000);
    const first = await refreshWith(session.cookie);
    const rotated = first.cookies.find((c) => c.name === 'zapas_rt')!.value;

    env.clock.advance(60_000);
    const replay = await refreshWith(session.cookie);
    expect(replay.statusCode).toBe(401);
    expect(replay.json().error.code).toBe('invalid_session');

    const afterTheft = await refreshWith(rotated);
    expect(afterTheft.statusCode).toBe(401);
    const audit = await env.owner.selectFrom('audit_log').select('action').where('action', '=', 'auth.refresh_reuse').execute();
    expect(audit).toHaveLength(1);
  });

  it('повтор в пределах секунд считает гонкой вкладок и не отзывает цепочку', async () => {
    const session = await loginAs(env, await createUser(env));
    env.clock.advance(1_000);
    const first = await refreshWith(session.cookie);
    const rotated = first.cookies.find((c) => c.name === 'zapas_rt')!.value;

    env.clock.advance(2_000);
    const race = await refreshWith(session.cookie);
    expect(race.statusCode).toBe(401);
    expect(race.json().error.code).toBe('refresh_conflict');
    expect((await refreshWith(rotated)).statusCode).toBe(200);
  });

  it('требует cookie и отклоняет чужой Origin', async () => {
    const session = await loginAs(env, await createUser(env));
    expect((await env.app.inject({ method: 'POST', url: '/api/auth/refresh' })).statusCode).toBe(401);
    const evil = await refreshWith(session.cookie, { origin: 'https://evil.example' });
    expect(evil.statusCode).toBe(403);
    expect(evil.json().error.code).toBe('bad_origin');
    const own = await refreshWith(session.cookie, { origin: 'http://localhost:3000', host: 'localhost:3000' });
    expect(own.statusCode).toBe(200);
  });

  it('не обновляет сессию отключённого пользователя', async () => {
    const user = await createUser(env);
    const session = await loginAs(env, user);
    await env.db.updateTable('users').set({ is_active: false }).where('id', '=', user.id).execute();
    expect((await refreshWith(session.cookie)).statusCode).toBe(401);
  });

  it('после выхода refresh-токен недействителен', async () => {
    const session = await loginAs(env, await createUser(env));
    const out = await env.app.inject({ method: 'POST', url: '/api/auth/logout', cookies: { zapas_rt: session.cookie } });
    expect(out.statusCode).toBe(204);
    env.clock.advance(60_000);
    expect((await refreshWith(session.cookie)).statusCode).toBe(401);
  });
});

describe('отзыв сессии действует сразу', () => {
  it('после выхода токен доступа перестаёт работать немедленно, а не через 15 минут', async () => {
    const session = await loginAs(env, await createUser(env));
    expect((await call(env, session.token)('GET', '/api/auth/me')).statusCode).toBe(200);
    await env.app.inject({ method: 'POST', url: '/api/auth/logout', cookies: { zapas_rt: session.cookie } });
    const res = await call(env, session.token)('GET', '/api/auth/me');
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('invalid_session');
  });

  it('при краже refresh-токена закрывается и сессия настоящего владельца, вместе с токеном доступа', async () => {
    const session = await loginAs(env, await createUser(env));
    env.clock.advance(1_000);
    const rotated = await env.app.inject({ method: 'POST', url: '/api/auth/refresh', cookies: { zapas_rt: session.cookie } });
    const ownerToken = rotated.json().accessToken as string;
    expect((await call(env, ownerToken)('GET', '/api/auth/me')).statusCode).toBe(200);

    env.clock.advance(60_000);
    const thief = await env.app.inject({ method: 'POST', url: '/api/auth/refresh', cookies: { zapas_rt: session.cookie } });
    expect(thief.statusCode).toBe(401);
    expect((await call(env, ownerToken)('GET', '/api/auth/me')).statusCode).toBe(401);
  });

  it('обновление сессии не создаёт окна, в котором параллельные запросы получают 401', async () => {
    const session = await loginAs(env, await createUser(env));
    env.clock.advance(1_000);
    const requests = Array.from({ length: 25 }, (_, i) =>
      i % 5 === 0
        ? env.app.inject({ method: 'POST', url: '/api/auth/refresh', cookies: { zapas_rt: session.cookie } })
        : call(env, session.token)('GET', '/api/auth/me'),
    );
    const results = await Promise.all(requests);
    const me = results.filter((_, i) => i % 5 !== 0);
    expect(me.every((r) => r.statusCode === 200)).toBe(true);
  });

  it('токен без привязки к сессии отвергается', async () => {
    const { SignJWT } = await import('jose');
    const user = await createUser(env);
    const bare = await new SignJWT({ role: 'admin' })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(user.id)
      .setIssuer('zapas')
      .setAudience('zapas-web')
      .setIssuedAt(Math.floor(env.clock.now.getTime() / 1000))
      .setExpirationTime(Math.floor(env.clock.now.getTime() / 1000) + 600)
      .sign(new TextEncoder().encode(env.config.jwtSecret));
    expect((await call(env, bare)('GET', '/api/auth/me')).statusCode).toBe(401);
  });
});

describe('смена пароля', () => {
  it('проверяет текущий пароль и политику, затем отзывает все сессии', async () => {
    const user = await createUser(env);
    const session = await loginAs(env, user);
    const api = call(env, session.token);

    const wrong = await api('POST', '/api/auth/change-password', { currentPassword: 'Не-тот-пароль-12', newPassword: 'Новый-пароль-из-слов-9' });
    expect(wrong.statusCode).toBe(400);
    expect(wrong.json().error.code).toBe('wrong_password');

    const weak = await api('POST', '/api/auth/change-password', { currentPassword: TEST_PASSWORD, newPassword: 'qwertyuiop' });
    expect(weak.statusCode).toBe(400);

    const same = await api('POST', '/api/auth/change-password', { currentPassword: TEST_PASSWORD, newPassword: TEST_PASSWORD });
    expect(same.statusCode).toBe(400);

    env.clock.advance(2_000);
    const ok = await api('POST', '/api/auth/change-password', { currentPassword: TEST_PASSWORD, newPassword: 'Новый-пароль-из-слов-9' });
    expect(ok.statusCode).toBe(204);

    expect((await call(env, session.token)('GET', '/api/auth/me')).statusCode).toBe(401);
    const stale = await env.app.inject({ method: 'POST', url: '/api/auth/refresh', cookies: { zapas_rt: session.cookie } });
    expect(stale.statusCode).toBe(401);
    expect((await env.app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: user.email, password: TEST_PASSWORD } })).statusCode).toBe(401);
    expect((await env.app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: user.email, password: 'Новый-пароль-из-слов-9' } })).statusCode).toBe(200);
  });
});

describe('ограничение частоты', () => {
  it('режет перебор пароля по IP', async () => {
    const limited = await createTestEnv({ LOGIN_RATE_LIMIT_MAX: '3' });
    try {
      const codes: number[] = [];
      for (let i = 0; i < 5; i += 1) {
        const r = await limited.app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'a@example.ru', password: 'Неверный-пароль-1' } });
        codes.push(r.statusCode);
      }
      expect(codes).toEqual([401, 401, 401, 429, 429]);
    } finally {
      await limited.close();
    }
  });
});
