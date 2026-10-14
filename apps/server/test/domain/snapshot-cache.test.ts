import { describe, expect, it } from 'vitest';
import { SnapshotCache } from '../../src/lib/snapshot-cache';

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Загрузчик с подсчётом вызовов, одновременных загрузок и заданной длительностью. */
function loader(durationMs: number) {
  const stats = { calls: 0, running: 0, maxRunning: 0, version: 0 };
  const load = async () => {
    stats.calls += 1;
    stats.running += 1;
    stats.maxRunning = Math.max(stats.maxRunning, stats.running);
    const value = stats.version;
    await pause(durationMs);
    stats.running -= 1;
    return value;
  };
  return { stats, load };
}

const make = (over: Partial<ConstructorParameters<typeof SnapshotCache>[0]> = {}) =>
  new SnapshotCache<number>({ ttlMs: 60_000, heavyMs: 50, maxEntries: 4, ...over });

describe('кеш срезов', () => {
  it('параллельные запросы делят одну загрузку', async () => {
    const { stats, load } = loader(15);
    const cache = make();
    const results = await Promise.all(Array.from({ length: 20 }, () => cache.get('k', load)));
    expect(stats.calls).toBe(1);
    expect(new Set(results).size).toBe(1);
    await cache.get('k', load);
    expect(stats.calls).toBe(1);
  });

  it('после записи лёгкий срез пересобирается сразу, и читатель видит свою запись', async () => {
    const { stats, load } = loader(5);
    const cache = make();
    expect(await cache.get('k', load)).toBe(0);
    stats.version = 1;
    cache.invalidate();
    expect(await cache.get('k', load)).toBe(1);
    expect(stats.calls).toBe(2);
  });

  it('запись во время загрузки не теряется: читатель после неё получает данные, начатые уже после записи', async () => {
    const { stats, load } = loader(30);
    const cache = make();
    const first = cache.get('k', load);
    await pause(5);
    stats.version = 1;
    cache.invalidate();
    const second = cache.get('k', load);
    expect(await first).toBe(0);
    expect(await second).toBe(1);
    expect(stats.maxRunning).toBe(1);
  });

  it('поток записей не создаёт лавину загрузок', async () => {
    const { stats, load } = loader(20);
    const cache = make();
    await cache.get('k', load);
    const reads: Promise<number>[] = [];
    for (let i = 0; i < 40; i += 1) {
      stats.version += 1;
      cache.invalidate();
      reads.push(cache.get('k', load));
    }
    const values = await Promise.all(reads);
    expect(stats.maxRunning).toBe(1);
    expect(stats.calls).toBeLessThanOrEqual(3);
    expect(Math.max(...values)).toBe(40);
  });

  it('тяжёлый срез отдаётся прежним, пока идёт пересборка, и не пересобирается чаще, чем раз в две длительности', async () => {
    const { stats, load } = loader(80);
    const cache = make({ heavyMs: 50 });
    expect(await cache.get('k', load)).toBe(0);

    stats.version = 1;
    cache.invalidate();
    const started = Date.now();
    expect(await cache.get('k', load)).toBe(0);
    expect(Date.now() - started).toBeLessThan(40);

    for (let i = 0; i < 10; i += 1) {
      cache.invalidate();
      await cache.get('k', load);
      await pause(5);
    }
    // за это время тяжёлый срез пересобрался не больше пары раз, а не десять
    expect(stats.calls).toBeLessThanOrEqual(3);

    await pause(400);
    expect(await cache.get('k', load)).toBe(1);
  });

  it('требование свежих данных всегда ждёт пересборку, даже для тяжёлого среза', async () => {
    const { stats, load } = loader(80);
    const cache = make({ heavyMs: 50 });
    await cache.get('k', load);
    stats.version = 7;
    expect(await cache.get('k', load, true)).toBe(7);
  });

  it('срок жизни: по истечении данные загружаются заново', async () => {
    const { stats, load } = loader(1);
    const cache = make({ ttlMs: 30 });
    await cache.get('k', load);
    await pause(45);
    stats.version = 3;
    expect(await cache.get('k', load)).toBe(3);
  });

  it('ошибка загрузки не отравляет кеш: следующий запрос пробует снова, прежние данные сохраняются', async () => {
    let fail = false;
    let n = 0;
    const load = async () => {
      n += 1;
      if (fail) throw new Error('база недоступна');
      return n;
    };
    const cache = make({ ttlMs: 1 });
    expect(await cache.get('k', load)).toBe(1);
    await pause(5);
    fail = true;
    await expect(cache.get('k', load)).rejects.toThrow('база недоступна');
    fail = false;
    expect(await cache.get('k', load)).toBeGreaterThan(1);
  });

  it('разные ключи не мешают друг другу, а число хранимых записей ограничено', async () => {
    const { stats, load } = loader(1);
    const cache = make({ maxEntries: 2 });
    const keys = ['a', 'b', 'c', 'd'];
    await Promise.all(keys.map((k) => cache.get(k, load)));
    expect(stats.calls).toBe(4);
    const before = stats.calls;
    await Promise.all(keys.map((k) => cache.get(k, load)));
    // в памяти осталось не больше двух ключей, значит минимум два пришлось загрузить заново
    expect(stats.calls - before).toBeGreaterThanOrEqual(2);
  });
});

describe('кеш срезов: организации и счётчики', () => {
  /** Срез, в котором лежат данные заданных организаций. */
  const tagged = (owners: string[]) => make({ tagsOf: () => owners } as never);

  it('запись одной организации не сбрасывает срез другой', async () => {
    const a = loader(3);
    const b = loader(3);
    const cache = new SnapshotCache<number>({ ttlMs: 60_000, heavyMs: 50, maxEntries: 4, tagsOf: () => [] });
    const forOrg = new Map<string, string[]>([['a', ['org-a']], ['b', ['org-b']]]);
    // теги среза берутся из данных, поэтому для проверки передаём их явно
    await cache.get('a', a.load, false, forOrg.get('a'));
    await cache.get('b', b.load, false, forOrg.get('b'));
    cache.invalidate('org-a');
    await cache.get('a', a.load, false, forOrg.get('a'));
    await cache.get('b', b.load, false, forOrg.get('b'));
    expect(a.stats.calls).toBe(2);
    expect(b.stats.calls).toBe(1);
  });

  it('сброс без организации затрагивает все срезы', async () => {
    const a = loader(3);
    const b = loader(3);
    const cache = make();
    await cache.get('a', a.load, false, ['org-a']);
    await cache.get('b', b.load, false, ['org-b']);
    cache.invalidate();
    await cache.get('a', a.load, false, ['org-a']);
    await cache.get('b', b.load, false, ['org-b']);
    expect(a.stats.calls).toBe(2);
    expect(b.stats.calls).toBe(2);
  });

  it('теги берутся из загруженных данных: срез с двумя организациями сбрасывается записью любой из них', async () => {
    const { stats, load } = loader(3);
    const cache = tagged(['org-a', 'org-b']);
    await cache.get('k', load);
    cache.invalidate('org-c');
    await cache.get('k', load);
    expect(stats.calls).toBe(1);
    cache.invalidate('org-b');
    await cache.get('k', load);
    expect(stats.calls).toBe(2);
  });

  it('срез без известного владельца сбрасывается записью любой организации', async () => {
    const { stats, load } = loader(3);
    const cache = tagged(['?']);
    await cache.get('k', load);
    cache.invalidate('org-x');
    await cache.get('k', load);
    expect(stats.calls).toBe(2);
  });

  it('запись своей организации во время первой загрузки не теряется, даже пока теги неизвестны', async () => {
    const { stats, load } = loader(30);
    const cache = tagged(['org-a']);
    const first = cache.get('k', load);
    await pause(5);
    stats.version = 1;
    cache.invalidate('org-a');
    const second = cache.get('k', load);
    expect(await first).toBe(0);
    expect(await second).toBe(1);
  });

  it('счётчики: промах, попадание, присоединение к чужой загрузке и сбросы', async () => {
    const { load } = loader(15);
    const cache = make();
    const outcomes = await Promise.all([cache.getTraced('k', load), cache.getTraced('k', load), cache.getTraced('k', load)]);
    expect(outcomes.map((o) => o.outcome).sort()).toEqual(['joined', 'joined', 'miss']);
    expect((await cache.getTraced('k', load)).outcome).toBe('hit');
    cache.invalidate('org-a');
    cache.invalidate();
    const s = cache.stats();
    expect(s).toMatchObject({ hits: 1, misses: 1, joined: 2, stale: 0, loads: 1, invalidations: 2, taggedInvalidations: 1, entries: 1 });
    expect(s.avgLoadMs).toBeGreaterThan(0);
  });

  it('тяжёлый срез помечается как отданный прежним, а ошибка загрузки попадает в счётчик', async () => {
    const { stats, load } = loader(80);
    const cache = make({ heavyMs: 20 });
    await cache.get('k', load);
    stats.version = 1;
    cache.invalidate();
    expect((await cache.getTraced('k', load)).outcome).toBe('stale');

    const broken = make();
    await expect(broken.get('x', async () => Promise.reject(new Error('сбой')))).rejects.toThrow('сбой');
    await pause(5);
    expect(broken.stats().failures).toBe(1);
  });
});
