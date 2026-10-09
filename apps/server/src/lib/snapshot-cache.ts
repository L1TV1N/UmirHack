interface Slot<T> {
  data?: T;
  /** Сколько записей было к началу загрузки, давшей data. */
  dataEpoch: number;
  loadedAt: number;
  /** Сколько длилась последняя загрузка. */
  duration: number;
  running?: { promise: Promise<T>; epoch: number };
  /** Загрузка, которая ещё не началась (ждёт предыдущую или паузу). Покрывает все записи до своего старта. */
  pending?: Promise<T>;
}

export interface SnapshotCacheOptions {
  /** Через сколько срез считается устаревшим сам по себе. */
  ttlMs: number;
  /** Загрузки дольше этого считаются тяжёлыми: их не пересобирают на каждую запись. */
  heavyMs: number;
  maxEntries: number;
  now?: () => number;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Кеш тяжёлых расчётов с тремя свойствами.
 * 1. Единый полёт: параллельные запросы делят одну загрузку, загрузок одного ключа не бывает две сразу.
 * 2. Запись сбрасывает кеш (invalidate), и лёгкие срезы пересобираются сразу, поэтому человек сразу видит
 *    результат своей операции.
 * 3. Тяжёлые срезы (дольше heavyMs) пересобираются не чаще, чем раз в две длительности загрузки: пока идёт
 *    пересборка, читатели получают предыдущий срез. Так поток записей не превращается в поток пересборок.
 */
export class SnapshotCache<T> {
  private slots = new Map<string, Slot<T>>();
  private epoch = 0;
  private readonly now: () => number;

  constructor(private readonly options: SnapshotCacheOptions) {
    this.now = options.now ?? Date.now;
  }

  invalidate(): void {
    this.epoch += 1;
  }

  async get(key: string, load: () => Promise<T>, fresh = false): Promise<T> {
    if (fresh) this.epoch += 1;
    const slot = this.slot(key);
    const need = this.epoch;

    const current = slot.data !== undefined && slot.dataEpoch >= need && this.now() - slot.loadedAt < this.options.ttlMs;
    if (current) return slot.data as T;

    const heavy = slot.duration > this.options.heavyMs;
    if (slot.data !== undefined && heavy && !fresh) {
      // отдаём предыдущий срез, обновление пойдёт в фоне
      this.refresh(slot, load, need).catch(() => undefined);
      return slot.data;
    }
    return this.refresh(slot, load, need);
  }

  private slot(key: string): Slot<T> {
    let s = this.slots.get(key);
    if (!s) {
      s = { dataEpoch: -1, loadedAt: 0, duration: 0 };
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

  private refresh(slot: Slot<T>, load: () => Promise<T>, need: number): Promise<T> {
    if (slot.running && slot.running.epoch >= need) return slot.running.promise;
    if (slot.pending) return slot.pending;

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
    return pending;
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
        slot.loadedAt = this.now();
        slot.duration = slot.loadedAt - startedAt;
        if (slot.running?.promise === promise) slot.running = undefined;
        this.evict();
      },
      () => {
        if (slot.running?.promise === promise) slot.running = undefined;
      },
    );
    return promise;
  }
}
