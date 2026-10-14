import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import pg from 'pg';
import type { Db } from '../../db/client';
import type { Logger } from '../../lib/context';
import { hubFor, type OrgScope } from '../../lib/events';
import { invalidateLocal } from '../analytics/snapshot';

export const CLUSTER_CHANNEL = 'zapas_changes';
const COALESCE_MS = 20;
/** Предел длины сообщения NOTIFY в PostgreSQL 8000 байт: пачка длиннее заменяется общим сбросом. */
const MAX_ITEMS = 40;
const RECONNECT_MIN_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;

export interface ClusterStatus {
  enabled: boolean;
  connected: boolean;
  instanceId: string | null;
  sent: number;
  received: number;
  sendErrors: number;
  reconnects: number;
  lastError: string | null;
}

interface Message {
  /** Экземпляр-отправитель: свои сообщения игнорируются. */
  i: string;
  /** Пары [организация или null, сбрасывать ли кеш]. */
  m: [string | null, 0 | 1][];
}

const syncs = new WeakMap<Db, ClusterSync>();

/** Синхронизация нескольких экземпляров приложения через LISTEN/NOTIFY, если она включена. */
export function clusterFor(db: Db): ClusterSync | null {
  return syncs.get(db) ?? null;
}

/**
 * Передаёт соседним экземплярам, что данные изменились. Кеш расчётов и поток событий живут в памяти процесса,
 * поэтому без этого второй экземпляр узнал бы об изменении только по истечении срока жизни среза (20 секунд),
 * а его клиенты вообще не получили бы сигнала. Сообщение ничего не несёт, кроме организации и признака сброса кеша.
 */
export class ClusterSync {
  readonly instanceId = randomUUID();
  private client: pg.Client | null = null;
  private connected = false;
  private everConnected = false;
  private stopped = true;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private delay = RECONNECT_MIN_MS;
  private queueTimer: NodeJS.Timeout | null = null;
  private queued = new Map<string | null, 0 | 1>();
  private counters = { sent: 0, received: 0, sendErrors: 0, reconnects: 0 };
  private lastError: string | null = null;

  constructor(
    private readonly db: Db,
    private readonly connectionString: string,
    private readonly log: Logger,
  ) {}

  async start(): Promise<void> {
    this.stopped = false;
    syncs.set(this.db, this);
    hubFor(this.db).setBroadcaster((org, cache) => this.queue(org, cache));
    await this.connect();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.queueTimer) clearTimeout(this.queueTimer);
    this.reconnectTimer = null;
    this.queueTimer = null;
    hubFor(this.db).setBroadcaster(null);
    syncs.delete(this.db);
    const client = this.client;
    this.client = null;
    this.connected = false;
    if (client) await client.end().catch(() => undefined);
  }

  status(): ClusterStatus {
    return { enabled: !this.stopped, connected: this.connected, instanceId: this.instanceId, ...this.counters, lastError: this.lastError };
  }

  private queue(org: OrgScope, cache: boolean): void {
    if (this.stopped) return;
    const flag = this.queued.get(org) === 1 || cache ? 1 : 0;
    this.queued.set(org, flag);
    if (this.queueTimer) return;
    this.queueTimer = setTimeout(() => {
      this.queueTimer = null;
      void this.flush();
    }, COALESCE_MS);
    this.queueTimer.unref();
  }

  private async flush(): Promise<void> {
    const items = [...this.queued.entries()];
    this.queued.clear();
    if (items.length === 0) return;
    const message: Message = {
      i: this.instanceId,
      m: items.length > MAX_ITEMS ? [[null, items.some(([, c]) => c === 1) ? 1 : 0]] : items,
    };
    try {
      await sql`SELECT pg_notify(${CLUSTER_CHANNEL}, ${JSON.stringify(message)})`.execute(this.db);
      this.counters.sent += 1;
    } catch (err) {
      this.counters.sendErrors += 1;
      this.lastError = err instanceof Error ? err.message : String(err);
      this.log.warn({ err: this.lastError }, 'не удалось передать изменение другим экземплярам');
    }
  }

  private receive(payload: string | undefined): void {
    if (!payload) return;
    let message: Message;
    try {
      message = JSON.parse(payload) as Message;
    } catch {
      return;
    }
    if (message.i === this.instanceId || !Array.isArray(message.m)) return;
    this.counters.received += 1;
    const hub = hubFor(this.db);
    for (const [org, cache] of message.m) {
      if (cache === 1) invalidateLocal(this.db, org);
      hub.publishRemote(org);
    }
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    const client = new pg.Client({ connectionString: this.connectionString, application_name: 'zapas-cluster' });
    client.on('notification', (msg) => this.receive(msg.payload));
    client.on('error', (err) => this.lost(client, err));
    client.on('end', () => this.lost(client, null));
    try {
      await client.connect();
      await client.query(`LISTEN ${CLUSTER_CHANNEL}`);
    } catch (err) {
      await client.end().catch(() => undefined);
      this.lost(client, err);
      return;
    }
    if (this.stopped) {
      await client.end().catch(() => undefined);
      return;
    }
    this.client = client;
    this.connected = true;
    this.delay = RECONNECT_MIN_MS;
    // за время обрыва могли пропуститься сообщения: сбрасываем кеш целиком и будим клиентов
    if (this.everConnected) {
      this.counters.reconnects += 1;
      invalidateLocal(this.db, null);
      hubFor(this.db).publishRemote(null);
    }
    this.everConnected = true;
  }

  private lost(client: pg.Client, err: unknown): void {
    if (this.client !== null && this.client !== client) return;
    if (err) this.lastError = err instanceof Error ? err.message : String(err);
    this.client = null;
    this.connected = false;
    if (this.stopped || this.reconnectTimer) return;
    this.log.warn({ err: this.lastError }, 'соединение синхронизации потеряно, переподключаемся');
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect();
    }, this.delay);
    this.reconnectTimer.unref();
    this.delay = Math.min(this.delay * 2, RECONNECT_MAX_MS);
  }
}
