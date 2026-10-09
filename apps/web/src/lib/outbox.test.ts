import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api/client';
import { submitDocument } from '../api/documents';
import { enqueue, flushOutbox, outboxItems, removeItem, resetOutbox, retryItem } from './outbox';

const setOnline = (value: boolean) => Object.defineProperty(navigator, 'onLine', { value, configurable: true });
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const failure = (status: number, code: string, message: string) => json(status, { error: { code, message }, requestId: 'r' });

beforeEach(async () => {
  await resetOutbox();
  setOnline(true);
});
afterEach(() => {
  vi.unstubAllGlobals();
  setOnline(true);
});

const doc = (over: Partial<Parameters<typeof enqueue>[0]> = {}) => ({ userId: 'u1', label: 'Приход, 2 поз.', path: '/documents/receipts', body: { lines: [] }, key: `k-${Math.random()}`, ...over });

describe('очередь документов', () => {
  it('сохраняет документ вместе с ключом идемпотентности', async () => {
    const item = await enqueue(doc({ key: 'web-1' }));
    expect(outboxItems('u1')).toHaveLength(1);
    expect(item).toMatchObject({ key: 'web-1', attempts: 0, error: null });
  });

  it('один и тот же ключ второй раз в очередь не попадает', async () => {
    await enqueue(doc({ key: 'same' }));
    await enqueue(doc({ key: 'same' }));
    expect(outboxItems('u1')).toHaveLength(1);
  });

  it('очередь одного пользователя не видна и не отправляется другим', async () => {
    await enqueue(doc({ userId: 'u1', key: 'a' }));
    await enqueue(doc({ userId: 'u2', key: 'b' }));
    const sent: string[] = [];
    await flushOutbox('u2', async (i) => void sent.push(i.key));
    expect(sent).toEqual(['b']);
    expect(outboxItems('u1')).toHaveLength(1);
    expect(outboxItems('u2')).toHaveLength(0);
    expect(outboxItems(undefined)).toEqual([]);
  });

  it('отправляет по порядку и убирает принятое', async () => {
    await enqueue(doc({ key: 'first' }));
    await enqueue(doc({ key: 'second' }));
    const sent: string[] = [];
    const res = await flushOutbox('u1', async (i) => void sent.push(i.key));
    expect(sent).toEqual(['first', 'second']);
    expect(res).toEqual({ sent: 2, rejected: 0, offline: false });
    expect(outboxItems('u1')).toHaveLength(0);
  });

  it('на сбое связи останавливается, остальное остаётся в очереди', async () => {
    await enqueue(doc({ key: 'a' }));
    await enqueue(doc({ key: 'b' }));
    await enqueue(doc({ key: 'c' }));
    let n = 0;
    const res = await flushOutbox('u1', async () => {
      n += 1;
      if (n === 2) throw new TypeError('Failed to fetch');
    });
    expect(res).toMatchObject({ sent: 1, offline: true });
    expect(outboxItems('u1').map((i) => i.key)).toEqual(['b', 'c']);
    expect(outboxItems('u1')[0]?.attempts).toBe(1);
  });

  it('отказ сервера по существу помечает документ и не мешает следующим', async () => {
    await enqueue(doc({ key: 'bad' }));
    await enqueue(doc({ key: 'good' }));
    const res = await flushOutbox('u1', async (i) => {
      if (i.key === 'bad') throw new ApiError(422, 'already_expired', 'Срок годности уже истёк');
    });
    expect(res).toMatchObject({ sent: 1, rejected: 1, offline: false });
    const left = outboxItems('u1');
    expect(left).toHaveLength(1);
    expect(left[0]).toMatchObject({ key: 'bad', error: 'Срок годности уже истёк' });
  });

  it('отклонённый документ повторно не уходит, пока человек не нажмёт «Повторить»', async () => {
    await enqueue(doc({ key: 'bad' }));
    let calls = 0;
    const send = async () => {
      calls += 1;
      if (calls === 1) throw new ApiError(409, 'conflict', 'Конфликт');
    };
    await flushOutbox('u1', send);
    await flushOutbox('u1', send);
    expect(calls).toBe(1);
    const id = outboxItems('u1')[0]?.id as string;
    await retryItem(id);
    const res = await flushOutbox('u1', send);
    expect(res.sent).toBe(1);
    expect(outboxItems('u1')).toHaveLength(0);
  });

  it('ошибка сервера и потеря входа считаются временными', async () => {
    await enqueue(doc({ key: 'a' }));
    const res = await flushOutbox('u1', async () => {
      throw new ApiError(503, 'unavailable', 'Перегружено');
    });
    expect(res.offline).toBe(true);
    expect(outboxItems('u1')[0]?.error).toBeNull();
  });

  it('параллельные запуски не отправляют документ дважды', async () => {
    await enqueue(doc({ key: 'a' }));
    let calls = 0;
    const send = async () => {
      calls += 1;
      await new Promise((r) => setTimeout(r, 10));
    };
    await Promise.all([flushOutbox('u1', send), flushOutbox('u1', send), flushOutbox('u1', send)]);
    expect(calls).toBe(1);
  });

  it('документ можно удалить вручную', async () => {
    const item = await enqueue(doc());
    await removeItem(item.id);
    expect(outboxItems('u1')).toHaveLength(0);
  });
});

describe('оформление документа', () => {
  const input = { path: '/documents/sales', body: { locationId: 'l', lines: [] }, key: 'web-key', label: 'Продажа, 1 поз.' };

  it('при связи отправляет сразу с ключом идемпотентности', async () => {
    const fetchMock = vi.fn().mockResolvedValue(json(201, { number: 'ПД-1' }));
    vi.stubGlobal('fetch', fetchMock);
    const res = await submitDocument<{ number: string }>('u1', input);
    expect(res).toEqual({ queued: false, result: { number: 'ПД-1' } });
    const headers = (fetchMock.mock.calls[0]?.[1] as RequestInit).headers as Record<string, string>;
    expect(headers['idempotency-key']).toBe('web-key');
    expect(outboxItems('u1')).toHaveLength(0);
  });

  it('без связи по данным браузера сразу уходит в очередь, сеть не трогается', async () => {
    setOnline(false);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    expect(await submitDocument('u1', input)).toEqual({ queued: true });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(outboxItems('u1')[0]).toMatchObject({ key: 'web-key', path: '/documents/sales' });
  });

  it('обрыв связи во время отправки тоже кладёт в очередь с тем же ключом', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    expect(await submitDocument('u1', input)).toEqual({ queued: true });
    expect(outboxItems('u1')[0]?.key).toBe('web-key');
  });

  it('сервер недоступен (503) это очередь, а отказ по существу это ошибка', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(failure(503, 'unavailable', 'Занят')));
    expect(await submitDocument('u1', input)).toEqual({ queued: true });

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(failure(422, 'insufficient_stock', 'Недостаточно остатка')));
    await expect(submitDocument('u1', { ...input, key: 'other' })).rejects.toMatchObject({ status: 422, code: 'insufficient_stock' });
    expect(outboxItems('u1')).toHaveLength(1);
  });

  it('очередь, отправленная после возвращения связи, использует тот же ключ', async () => {
    setOnline(false);
    await submitDocument('u1', input);
    setOnline(true);
    const fetchMock = vi.fn().mockResolvedValue(json(200, { number: 'ПД-1', duplicate: false }));
    vi.stubGlobal('fetch', fetchMock);
    const res = await flushOutbox('u1');
    expect(res.sent).toBe(1);
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect((init.headers as Record<string, string>)['idempotency-key']).toBe('web-key');
    expect(JSON.parse(String(init.body))).toEqual(input.body);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe('/api/documents/sales');
  });
});
