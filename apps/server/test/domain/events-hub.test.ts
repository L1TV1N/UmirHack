import { describe, expect, it } from 'vitest';
import { EventHub, hubFor, type LiveEvent } from '../../src/lib/events';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('хаб событий', () => {
  it('склеивает частые публикации в одно событие', async () => {
    const hub = new EventHub(30);
    const got: LiveEvent[] = [];
    hub.subscribe((e) => got.push(e));
    hub.publish();
    hub.publish();
    hub.publish();
    await sleep(80);
    expect(got).toHaveLength(1);
    expect(got[0]?.type).toBe('changed');
    hub.publish();
    await sleep(80);
    expect(got).toHaveLength(2);
  });

  it('доставляет всем подписчикам, отписавшийся больше не получает', async () => {
    const hub = new EventHub(10);
    let a = 0;
    let b = 0;
    hub.subscribe(() => (a += 1));
    const off = hub.subscribe(() => (b += 1));
    hub.publish();
    await sleep(40);
    off();
    hub.publish();
    await sleep(40);
    expect(a).toBe(2);
    expect(b).toBe(1);
    expect(hub.size).toBe(1);
  });

  it('без подписчиков ничего не планирует, а stop отменяет ожидающий сигнал', async () => {
    const hub = new EventHub(10);
    hub.publish();
    let hits = 0;
    hub.subscribe(() => (hits += 1));
    hub.publish();
    hub.stop();
    await sleep(40);
    expect(hits).toBe(0);
    expect(hub.size).toBe(0);
  });

  it('ошибка одного подписчика не мешает остальным', async () => {
    const hub = new EventHub(10);
    let ok = 0;
    hub.subscribe(() => {
      throw new Error('обрыв');
    });
    hub.subscribe(() => (ok += 1));
    hub.publish();
    await sleep(40);
    expect(ok).toBe(1);
  });

  it('у каждого ключа свой хаб', () => {
    const a = {};
    const b = {};
    expect(hubFor(a)).toBe(hubFor(a));
    expect(hubFor(a)).not.toBe(hubFor(b));
  });
});
