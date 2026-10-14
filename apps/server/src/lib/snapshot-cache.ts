import { recordCacheTrace } from './cache-trace';

interface Slot<T> {
  data?: T;
  /** Сколько сбросов было к началу загрузки, давшей data. */
  dataEpoch: number;
  /** Чьи это данные (организации): запись одной организации не сбрасывает срезы других. */
  tags?: readonly string[];
  /** Данные нужны не старше этой эпохи: так отмечается требование «свежих» данных для одного ключа. */
  required: number;
  loadedAt: number;
  /** Сколько длилась последняя загрузка. */
  duration: number;
  running?: { promise: Promise<T>; epoch: number };
  /** Загрузка, которая ещё не началась (ждёт предыдущую или паузу). Покрывает все сбросы до своего старта. */
  pending?: Promise<T>;
}

export interface SnapshotCacheOptions<T = unknown> {
  /** Через сколько срез считается устаревшим сам по себе. */
  ttlMs: number;
  /** Загрузки дольше этого считаются тяжёлыми: их не пересобирают на каждую запись. */
  heavyMs: number;
  maxEntries: number;
  /** Чьи данные в срезе. Без этого срез сбрасывается любой записью. */
  tagsOf?: (data: T) => Iterable<string>;
  now?: () => number;
}

/** Чем кончилось обращение к кешу: попадание, промах (загрузили сами), присоединились к чужой загрузке, отдали прежний срез. */
export type CacheOutcome = 'hit' | 'miss' | 'joined' | 'stale';

export interface CacheStats {
  hits: number;
  misses: number;
  joined: number;
  stale: number;
  failures: number;
  /** Сколько раз кеш сбрасывали (всего и только для одной организации). */
  invalidations: number;
  taggedInvalidations: number;
  loads: number;
  lastLoadMs: number;
  avgLoadMs: number;
  maxLoadMs: number;
  entries: number;
  maxEntries: number;
  ttlMs: number;
  heavyMs: number;
}

/** Тег данных без известного владельца: его сбрасывает запись любой организации. */
export const UNKNOWN_OWNER = '?';

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Кеш тяжёлых расчётов с четырьмя свойствами.
 * 1. Единый полёт: параллельные запросы делят одну загрузку, загрузок одного ключа не бывает две сразу.
 * 2. Запись сбрасывает кеш (invalidate), и лёгкие срезы пересобираются сразу, поэтому человек сразу видит
 *    результат своей операции. Сброс можно ограничить организацией: срезы других организаций остаются.
 * 3. Тяжёлые срезы (дольше heavyMs) пересобираются не чаще, чем раз в две длительности загрузки: пока идёт
 *    пересборка, читатели получают предыдущий срез. Так поток записей не превращается в поток пересборок.
 * 4. Счётчики попаданий и промахов, чтобы кеш можно было проверить, а не принять на веру.
 *
 * Сброс это увеличение счётчика (эпохи), а не обход ключей. Срез устарел, если после начала его загрузки был
 * сброс всего кеша или сброс организации, чьи данные в нём лежат.
 */
export class SnapshotCache<T> {
  private slots = new Map<string, Slot<T>>();
  /** Номер последнего сброса. Загрузка запоминает его на старте. */
  private epoch = 0;
  private globalBump = 0;
  private tagBump = new Map<string, number>();
  private readonly now: () => number;
  private counters = { hits: 0, misses: 0, joined: 0, stale: 0, failures: 0, invalidations: 0, taggedInvalidations: 0, loads: 0, lastLoadMs: 0, totalLoadMs: 0, maxLoadMs: 0 };

  constructor(private readonly options: SnapshotCacheOptions<T>) {
    this.now = options.now ?? Date.now;
  }

  /** Сбросить кеш. С тегом: только данные этой организации. */
  invalidate(tag?: string | null): void {
    this.epoch += 1;
    this.counters.invalidations += 1;
    if (tag) {
      this.tagBump.set(tag, this.epoch);
      this.tagBump.set(UNKNOWN_OWNER, this.epoch);
      this.counters.taggedInvalidations += 1;
    } else {
      this.globalBump = this.epoch;
    }
  }

  stats(): CacheStats {
    const c = this.counters;
    return {
      hits: c.hits,
      misses: c.misses,
      joined: c.joined,
      stale: c.stale,
      failures: c.failures,
      invalidations: c.invalidations,
      taggedInvalidations: c.taggedInvalidations,
      loads: c.loads,
      lastLoadMs: c.lastLoadMs,
      avgLoadMs: c.loads > 0 ? c.totalLoadMs / c.loads : 0,
      maxLoadMs: c.maxLoadMs,
      entries: this.slots.size,
      maxEntries: this.options.maxEntries,
      ttlMs: this.options.ttlMs,
      heavyMs: this.options.heavyMs,
    };
  }

  /** Данные, загруженные после номера since, могли не увидеть последнего сброса, затрагивающего слот. */
  private affected(tags: readonly string[] | undefined, since: number): boolean {
    if (this.globalBump > since) return true;
    // теги неизвестны (первая загрузка ещё идёт): считаем, что затронут любой сброс
    if (!tags) return this.epoch > since;
    for (const tag of tags) if ((this.tagBump.get(tag) ?? 0) > since) return true;
    return false;
  }

  async get(key: string, load: () => Promise<T>, fresh = false, tags?: readonly string[]): Promise<T> {
    return (await this.getTraced(key, load, fresh, tags)).data;
  }

  async getTraced(key: string, load: () => Promise<T>, fresh = false, tags?: readonly string[]): Promise<{ data: T; outcome: CacheOutcome }> {
    const startedAt = this.now();
    const result = await this.lookup(key, load, fresh, tags);
    this.counters[result.outcome === 'hit' ? 'hits' : result.outcome === 'miss' ? 'misses' : result.outcome === 'joined' ? 'joined' : 'stale'] += 1;
    recordCacheTrace(result.outcome, this.now() - startedAt);
    return result;
  }

  private async lookup(key: string, load: () => Promise<T>, fresh: boolean, tags?: readonly string[]): Promise<{ data: T; outcome: CacheOutcome }> {
    const slot = this.slot(key);
    if (tags) slot.tags = tags;
    // «Свежие» данные нужны только этому ключу: срезы других ключей и организаций не трогаем
    if (fresh) {
      this.epoch += 1;
      slot.required = this.epoch;
    }

    const current =
      slot.data !== undefined && slot.dataEpoch >= slot.required && !this.affected(slot.tags, slot.dataEpoch) && this.now() - slot.loadedAt < this.options.ttlMs;
    if (current) return { data: slot.data as T, outcome: 'hit' };

    const heavy = slot.duration > this.options.heavyMs;
    if (slot.data !== undefined && heavy && !fresh) {
      // отдаём предыдущий срез, обновление пойдёт в фоне
      this.refresh(slot, load).promise.catch(() => undefined);
      return { data: slot.data, outcome: 'stale' };
    }
    const started = this.refresh(slot, load);
    return { data: await started.promise, outcome: started.created ? 'miss' : 'joined' };
  }

  private slot(key: string): Slot<T> {
    let s = this.slots.get(key);
    if (!s) {
      s = { dataEpoch: -1, required: 0, loadedAt: 0, duration: 0 };
      this.slots.set(key, s);
      this.evict();
    }
    return s;
  }

  /** Держит число ключей в пределах maxEntries, не трогая те, что сейчас загружаются. */
  private evict(): void {
    for (const [key, victim] of this.slots) {
      if (this.slots.size <= this.options.maxEntries) return;
      if (!victim.running && !victim.pending) this.slots.delete(key);
    }
  }

  private refresh(slot: Slot<T>, load: () => Promise<T>): { promise: Promise<T>; created: boolean } {
    if (slot.running && slot.running.epoch >= slot.required && !this.affected(slot.tags, slot.running.epoch)) return { promise: slot.running.promise, created: false };
    if (slot.pending) return { promise: slot.pending, created: false };

    const previous = slot.running?.promise;
    // Promise.resolve().then, а не async-функция: тело не должно выполняться до того, как pending записан в слот
    const pending: Promise<T> = Promise.resolve().then(async () => {
      if (previous) await previous.catch(() => undefined);
      const gap = slot.duration > this.options.heavyMs ? 2 * slot.duration : 0;
      const wait = slot.loadedAt + gap - this.now();
      if (wait > 0) await sleep(wait);
      slot.pending = undefined;
      return this.start(slot, load);
    });
    slot.pending = pending;
    pending.catch(() => {
      if (slot.pending === pending) slot.pending = undefined;
    });
    return { promise: pending, created: true };
  }

  private start(slot: Slot<T>, load: () => Promise<T>): Promise<T> {
    const epoch = this.epoch;
    const startedAt = this.now();
    const promise = load();
    slot.running = { promise, epoch };
    promise.then(
      (data) => {
        slot.data = data;
        slot.dataEpoch = epoch;
        if (this.options.tagsOf) slot.tags = [...this.options.tagsOf(data)];
        slot.loadedAt = this.now();
        slot.duration = slot.loadedAt - startedAt;
        this.counters.loads += 1;
        this.counters.lastLoadMs = slot.duration;
        this.counters.totalLoadMs += slot.duration;
        this.counters.maxLoadMs = Math.max(this.counters.maxLoadMs, slot.duration);
        if (slot.running?.promise === promise) slot.running = undefined;
        this.evict();
      },
      () => {
        this.counters.failures += 1;
        if (slot.running?.promise === promise) slot.running = undefined;
      },
    );
    return promise;
  }
}
