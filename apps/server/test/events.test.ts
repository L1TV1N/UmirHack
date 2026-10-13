import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { hubFor } from '../src/lib/events';
import { addProduct, createWorld, receive, type World } from './fixtures';
import { createTestEnv, type TestEnv } from './helpers';

let env: TestEnv;
let w: World;
let base: string;
const opened: AbortController[] = [];

beforeAll(async () => {
  env = await createTestEnv({ ACCESS_TOKEN_TTL_SECONDS: '3600' });
  await env.app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(env.app.server.address() as AddressInfo).port}`;
});
afterAll(() => env.close());
beforeEach(async () => {
  await env.reset();
  w = await createWorld(env);
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Открытый поток событий: накапливает принятый текст и позволяет дождаться нужной строки. */
class Stream {
  text = '';
  private done = false;
  constructor(
    readonly status: number,
    private readonly reader: ReadableStreamDefaultReader<Uint8Array> | null,
  ) {
    void this.pump();
  }
  private async pump() {
    if (!this.reader) return;
    const decoder = new TextDecoder();
    try {
      for (;;) {
        const chunk = await this.reader.read();
        if (chunk.done) break;
        this.text += decoder.decode(chunk.value);
      }
    } catch {
      // поток закрыт клиентом
    }
    this.done = true;
  }
  async until(needle: string, ms = 4000): Promise<boolean> {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (this.text.includes(needle)) return true;
      if (this.done) return false;
      await sleep(25);
    }
    return this.text.includes(needle);
  }
}

async function openStream(token: string): Promise<Stream> {
  const controller = new AbortController();
  opened.push(controller);
  const res = await fetch(`${base}/api/events`, { headers: { authorization: `Bearer ${token}` }, signal: controller.signal });
  return new Stream(res.status, res.body ? res.body.getReader() : null);
}

function closeAll() {
  for (const c of opened.splice(0)) c.abort();
}

describe('поток событий', () => {
  it('без входа не открывается', async () => {
    expect((await fetch(`${base}/api/events`)).status).toBe(401);
  });

  it('открывается любому вошедшему и отвечает как поток событий', async () => {
    const res = await fetch(`${base}/api/events`, { headers: { authorization: `Bearer ${w.viewerA.token}` } });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    expect(res.headers.get('x-accel-buffering')).toBe('no');
    await res.body?.cancel();
  });

  it('сообщает, что данные изменились, после операции другого пользователя', async () => {
    const stream = await openStream(w.viewerA.token);
    expect(stream.status).toBe(200);
    expect(await stream.until('event: ready')).toBe(true);

    const milk = await addProduct(env, w.categoryId, { name: 'Молоко', unit: 'l' });
    await receive(env, w.manager.token, w.locA.id, [{ productId: milk, quantity: 5, expiresOn: w.day(3) }]);
    expect(await stream.until('event: changed')).toBe(true);
    closeAll();
  });

  it('частые изменения склеиваются в одно событие', async () => {
    const stream = await openStream(w.viewerA.token);
    await stream.until('event: ready');
    const milk = await addProduct(env, w.categoryId, { name: 'Молоко', unit: 'l' });
    for (let i = 0; i < 5; i += 1) await receive(env, w.manager.token, w.locA.id, [{ productId: milk, quantity: 1, expiresOn: w.day(3) }]);
    await stream.until('event: changed');
    await sleep(500);
    expect(stream.text.match(/event: changed/g)?.length ?? 0).toBeLessThan(3);
    closeAll();
  });

  it('не больше пяти потоков на пользователя, закрытый поток освобождает место и подписку', async () => {
    const streams: Stream[] = [];
    for (let i = 0; i < 5; i += 1) streams.push(await openStream(w.viewerA.token));
    expect(streams.map((s) => s.status)).toEqual([200, 200, 200, 200, 200]);
    const sixth = await fetch(`${base}/api/events`, { headers: { authorization: `Bearer ${w.viewerA.token}` } });
    expect(sixth.status).toBe(429);

    closeAll();
    for (let i = 0; i < 40 && hubFor(env.db).size > 0; i += 1) await sleep(25);
    expect(hubFor(env.db).size).toBe(0);
    const again = await openStream(w.viewerA.token);
    expect(again.status).toBe(200);
    closeAll();
  });
});
