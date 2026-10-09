import type { SessionDto } from '@zapas/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError, refreshSession, session } from './client';

const user = { id: 'u1', email: 'a@b.ru', fullName: 'Тест', role: 'admin' as const, isActive: true, locationIds: [], lastLoginAt: null, lockedUntil: null, createdAt: '2026-10-08T00:00:00Z' };
const sessionBody = (token: string): SessionDto => ({ accessToken: token, expiresIn: 900, user });

const json = (status: number, body?: unknown) =>
  new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const failure = (status: number, code: string, message = 'Ошибка') => json(status, { error: { code, message }, requestId: 'r1' });

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  session.set('старый-токен');
});
afterEach(() => {
  vi.unstubAllGlobals();
  session.set(null);
});

const urls = () => fetchMock.mock.calls.map((c) => String(c[0]));

describe('api клиент', () => {
  it('передаёт токен и возвращает тело', async () => {
    fetchMock.mockResolvedValueOnce(json(200, { ok: 1 }));
    await expect(api('GET', '/stock/summary')).resolves.toEqual({ ok: 1 });
    const headers = (fetchMock.mock.calls[0]?.[1] as RequestInit).headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer старый-токен');
  });

  it('при 401 обновляет сессию и повторяет запрос с новым токеном', async () => {
    fetchMock
      .mockResolvedValueOnce(failure(401, 'token_expired'))
      .mockResolvedValueOnce(json(200, sessionBody('новый-токен')))
      .mockResolvedValueOnce(json(200, { data: 7 }));
    await expect(api('GET', '/analytics/dashboard')).resolves.toEqual({ data: 7 });
    expect(urls()).toEqual(['/api/analytics/dashboard', '/api/auth/refresh', '/api/analytics/dashboard']);
    expect(session.token()).toBe('новый-токен');
    const retryHeaders = (fetchMock.mock.calls[2]?.[1] as RequestInit).headers as Record<string, string>;
    expect(retryHeaders.authorization).toBe('Bearer новый-токен');
  });

  it('параллельные запросы делят одну попытку обновления', async () => {
    let refreshCalls = 0;
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === '/api/auth/refresh') {
        refreshCalls += 1;
        await new Promise((r) => setTimeout(r, 10));
        return json(200, sessionBody('новый'));
      }
      const auth = (init?.headers as Record<string, string>).authorization;
      return auth === 'Bearer новый' ? json(200, { ok: true }) : failure(401, 'token_expired');
    });
    await Promise.all([api('GET', '/a'), api('GET', '/b'), api('GET', '/c')]);
    expect(refreshCalls).toBe(1);
  });

  it('если обновить сессию нельзя, сообщает об этом и выбрасывает ошибку', async () => {
    const seen: (SessionDto | null)[] = [];
    const off = session.subscribe((s) => seen.push(s));
    fetchMock.mockResolvedValueOnce(failure(401, 'token_expired')).mockResolvedValueOnce(failure(401, 'invalid_session'));
    await expect(api('GET', '/stock/summary')).rejects.toMatchObject({ status: 401 });
    expect(seen).toContain(null);
    expect(session.token()).toBeNull();
    off();
  });

  it('при гонке вкладок повторяет обновление с новой cookie', async () => {
    fetchMock.mockResolvedValueOnce(failure(401, 'refresh_conflict')).mockResolvedValueOnce(json(200, sessionBody('после-гонки')));
    const result = await refreshSession();
    expect(result?.accessToken).toBe('после-гонки');
    expect(urls()).toEqual(['/api/auth/refresh', '/api/auth/refresh']);
  });

  it('вход не пытается обновлять сессию: 401 там значит неверный пароль', async () => {
    fetchMock.mockResolvedValueOnce(failure(401, 'invalid_credentials', 'Неверный email или пароль'));
    await expect(api('POST', '/auth/login', { body: { email: 'a', password: 'b' }, auth: false })).rejects.toMatchObject({ code: 'invalid_credentials' });
    expect(urls()).toEqual(['/api/auth/login']);
  });

  it('разбирает ошибки полей формы', async () => {
    fetchMock.mockResolvedValueOnce(
      json(400, { error: { code: 'validation_error', message: 'Проверьте введённые данные', details: [{ path: ['lines', 0, 'quantity'], message: 'Укажите количество' }] }, requestId: 'r' }),
    );
    const err = await api('POST', '/documents/sales', { body: {} }).catch((e) => e as ApiError);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).fieldErrors()).toEqual({ 'lines.0.quantity': 'Укажите количество' });
  });

  it('204 возвращает пустой результат', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    await expect(api('POST', '/auth/logout')).resolves.toBeUndefined();
  });
});
