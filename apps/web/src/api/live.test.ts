import { afterEach, describe, expect, it } from 'vitest';
import { session } from './client';
import { connectLive, parseEvents } from './live';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
  session.set(null);
});

/** Поток событий, которым управляет тест. */
function fakeStream() {
  const encoder = new TextEncoder();
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });
  return {
    response: new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
    push: (text: string) => controller.enqueue(encoder.encode(text)),
    close: () => controller.close(),
  };
}

describe('разбор потока событий', () => {
  it('отдаёт названия полных событий и оставляет недочитанный хвост', () => {
    const out = parseEvents('retry: 5000\n\nevent: ready\ndata: {}\n\nevent: changed\ndata: {"at":"x"}\n\nevent: chan');
    expect(out.events).toEqual(['ready', 'changed']);
    expect(out.rest).toBe('event: chan');
  });

  it('пропускает комментарии и пустые блоки', () => {
    expect(parseEvents(': ping\n\n\n\n').events).toEqual([]);
  });

  it('склеивает событие, пришедшее двумя кусками', () => {
    const first = parseEvents('event: chan');
    expect(first.events).toEqual([]);
    expect(parseEvents(first.rest + 'ged\ndata: {}\n\n').events).toEqual(['changed']);
  });
});

describe('подключение к потоку', () => {
  it('передаёт токен, сообщает о состоянии и вызывает обновление только по изменению', async () => {
    session.set('token-1');
    const stream = fakeStream();
    const calls: { url: string; auth: string | null }[] = [];
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      calls.push({ url, auth: new Headers(init.headers).get('authorization') });
      return stream.response;
    }) as typeof fetch;

    let changes = 0;
    const states: boolean[] = [];
    const stop = connectLive({ onChange: () => (changes += 1), onState: (s) => states.push(s) });

    stream.push('retry: 5000\n\nevent: ready\ndata: {}\n\n');
    await sleep(50);
    expect(calls[0]).toEqual({ url: '/api/events', auth: 'Bearer token-1' });
    expect(states).toEqual([true]);
    expect(changes).toBe(0);

    stream.push('event: changed\ndata: {}\n\n');
    await sleep(50);
    expect(changes).toBe(1);
    stop();
  });

  it('после обрыва переподключается и перечитывает данные, чтобы не пропустить изменения', async () => {
    session.set('token-1');
    const streams = [fakeStream(), fakeStream()];
    let n = 0;
    globalThis.fetch = (async () => streams[Math.min(n++, 1)]!.response) as typeof fetch;

    let changes = 0;
    const states: boolean[] = [];
    const stop = connectLive({ onChange: () => (changes += 1), onState: (s) => states.push(s) });
    streams[0]!.push('event: ready\ndata: {}\n\n');
    await sleep(50);
    expect(changes).toBe(0);

    streams[0]!.close();
    await sleep(1400);
    streams[1]!.push('event: ready\ndata: {}\n\n');
    await sleep(50);
    expect(n).toBe(2);
    expect(changes).toBe(1);
    expect(states).toEqual([true, false, true]);
    stop();
  });

  it('без токена не ходит на сервер', async () => {
    let called = 0;
    globalThis.fetch = (async () => {
      called += 1;
      return new Response('', { status: 401 });
    }) as typeof fetch;
    const stop = connectLive({ onChange: () => undefined });
    await sleep(80);
    stop();
    expect(called).toBe(0);
  });
});
