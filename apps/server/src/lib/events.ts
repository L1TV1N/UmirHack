export interface LiveEvent {
  type: 'changed';
  at: string;
}

export type LiveListener = (event: LiveEvent) => void;

const COALESCE_MS = 300;

/** Организация, которой интересно событие. null: всем (источник неизвестен или изменение общее). */
export type OrgScope = string | null;

/** Передача сигнала другим экземплярам приложения. Вызывается на каждое локальное изменение. */
/** cache: изменение сбрасывает кеш расчётов, а не только будит клиентов. */
export type Broadcaster = (org: OrgScope, cache: boolean) => void;

interface Subscriber {
  listener: LiveListener;
  org: OrgScope;
}

/**
 * Подписчики на изменения данных. Событие ничего не несёт, кроме факта «что-то изменилось»: интерфейс сам
 * перечитывает то, что показывает, с проверкой прав, как при обычном запросе. Организация нужна только для
 * того, чтобы не будить чужие вкладки: в сам сигнал она не попадает.
 */
export class EventHub {
  private readonly subscribers = new Set<Subscriber>();
  private timer: NodeJS.Timeout | null = null;
  /** Организации, о которых накопились изменения. all: изменилось что-то общее. */
  private pending = new Set<string>();
  private pendingAll = false;
  private broadcaster: Broadcaster | null = null;

  constructor(private readonly delayMs = COALESCE_MS) {}

  get size(): number {
    return this.subscribers.size;
  }

  /** Подписка. org: только изменения этой организации (и общие). Без org: все изменения. */
  subscribe(listener: LiveListener, org: OrgScope = null): () => void {
    const sub: Subscriber = { listener, org };
    this.subscribers.add(sub);
    return () => {
      this.subscribers.delete(sub);
    };
  }

  /** Подключает передачу сигналов другим экземплярам (LISTEN/NOTIFY). */
  setBroadcaster(fn: Broadcaster | null): void {
    this.broadcaster = fn;
  }

  /** Частые изменения склеиваются: клиенту нужен один сигнал, а не по сигналу на каждую строку продажи. */
  publish(org: OrgScope = null, options: { cache?: boolean } = {}): void {
    this.broadcaster?.(org, options.cache === true);
    this.schedule(org);
  }

  /** Сигнал, пришедший от другого экземпляра: своим клиентам передаём, дальше не рассылаем. */
  publishRemote(org: OrgScope = null): void {
    this.schedule(org);
  }

  private schedule(org: OrgScope): void {
    if (this.subscribers.size === 0) return;
    if (org === null) this.pendingAll = true;
    else this.pending.add(org);
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      const all = this.pendingAll;
      const orgs = this.pending;
      this.pendingAll = false;
      this.pending = new Set();
      const event: LiveEvent = { type: 'changed', at: new Date().toISOString() };
      for (const sub of [...this.subscribers]) {
        if (!all && sub.org !== null && !orgs.has(sub.org)) continue;
        try {
          sub.listener(event);
        } catch {
          // сломанный подписчик (оборвалось соединение) не должен мешать остальным и валить процесс
          this.subscribers.delete(sub);
        }
      }
    }, this.delayMs);
    this.timer.unref();
  }

  /** Отменяет сигнал, который ещё не ушёл. Нужно при остановке сервера. */
  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.pending = new Set();
    this.pendingAll = false;
    this.subscribers.clear();
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
