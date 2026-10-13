export interface LiveEvent {
  type: 'changed';
  at: string;
}

export type LiveListener = (event: LiveEvent) => void;

const COALESCE_MS = 300;

/**
 * Подписчики на изменения данных. Событие ничего не несёт, кроме факта «что-то изменилось»: интерфейс сам
 * перечитывает то, что показывает, с проверкой прав, как при обычном запросе.
 */
export class EventHub {
  private readonly listeners = new Set<LiveListener>();
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly delayMs = COALESCE_MS) {}

  get size(): number {
    return this.listeners.size;
  }

  subscribe(listener: LiveListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Частые изменения склеиваются: клиенту нужен один сигнал, а не по сигналу на каждую строку продажи. */
  publish(): void {
    if (this.timer || this.listeners.size === 0) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      const event: LiveEvent = { type: 'changed', at: new Date().toISOString() };
      for (const listener of [...this.listeners]) {
        try {
          listener(event);
        } catch {
          // сломанный подписчик (оборвалось соединение) не должен мешать остальным и валить процесс
          this.listeners.delete(listener);
        }
      }
    }, this.delayMs);
    this.timer.unref();
  }

  /** Отменяет сигнал, который ещё не ушёл. Нужно при остановке сервера. */
  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.listeners.clear();
  }
}

const hubs = new WeakMap<object, EventHub>();

/** Один хаб на подключение к базе: у приложения и у тестов они не пересекаются. */
export function hubFor(key: object): EventHub {
  let hub = hubs.get(key);
  if (!hub) {
    hub = new EventHub();
    hubs.set(key, hub);
  }
  return hub;
}
