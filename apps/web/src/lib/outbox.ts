import { useSyncExternalStore } from 'react';
import { api, ApiError } from '../api/client';
import { isTransient } from '../api/transient';
import { openStore } from './idb';

/**
 * Очередь документов, оформленных без связи. Каждый документ хранится вместе с ключом идемпотентности,
 * поэтому повторная отправка (в том числе после потерянного ответа) не создаст второй документ.
 * Документ принадлежит пользователю, который его оформил: чужой вход на том же устройстве его не отправит.
 */
export interface OutboxItem {
  id: string;
  userId: string;
  label: string;
  path: string;
  body: unknown;
  key: string;
  createdAt: number;
  attempts: number;
  /** Сервер отказал по существу (например, срок истёк): документ ждёт решения человека. */
  error: string | null;
}

const store = openStore('outbox');
let items: OutboxItem[] = [];
let ready: Promise<void> | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  items = [...items];
  for (const fn of listeners) fn();
}

export function loadOutbox(): Promise<void> {
  ready ??= store.values<OutboxItem>().then((list) => {
    items = list.sort((a, b) => a.createdAt - b.createdAt);
    emit();
  });
  return ready;
}

export async function enqueue(input: Pick<OutboxItem, 'userId' | 'label' | 'path' | 'body' | 'key'>): Promise<OutboxItem> {
  await loadOutbox();
  const existing = items.find((i) => i.key === input.key && i.userId === input.userId);
  if (existing) return existing;
  const item: OutboxItem = { id: crypto.randomUUID(), createdAt: Date.now(), attempts: 0, error: null, ...input };
  items.push(item);
  await store.set(item.id, item);
  emit();
  return item;
}

async function save(item: OutboxItem): Promise<void> {
  items = items.map((i) => (i.id === item.id ? item : i));
  await store.set(item.id, item);
  emit();
}

export async function removeItem(id: string): Promise<void> {
  items = items.filter((i) => i.id !== id);
  await store.delete(id);
  emit();
}

/** Дать документу ещё одну попытку после отказа. */
export async function retryItem(id: string): Promise<void> {
  const item = items.find((i) => i.id === id);
  if (!item) return;
  await save({ ...item, error: null });
}

export function outboxItems(userId: string | undefined): OutboxItem[] {
  return userId ? items.filter((i) => i.userId === userId) : [];
}

let cache: { source: OutboxItem[]; user: string | undefined; result: OutboxItem[] } | null = null;

/** Очередь текущего пользователя для интерфейса. */
export function useOutbox(userId: string | undefined): OutboxItem[] {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    () => {
      if (!cache || cache.source !== items || cache.user !== userId) cache = { source: items, user: userId, result: outboxItems(userId) };
      return cache.result;
    },
  );
}

export interface FlushResult {
  sent: number;
  rejected: number;
  /** Остановились на сбое связи, остальное осталось в очереди. */
  offline: boolean;
}

type Sender = (item: OutboxItem) => Promise<unknown>;

const defaultSend: Sender = (item) => api('POST', item.path, { body: item.body, headers: { 'idempotency-key': item.key } });

let flushing: Promise<FlushResult> | null = null;

/** Отправляет документы пользователя по порядку. На сбое связи останавливается, на отказе по существу идёт дальше. */
export function flushOutbox(userId: string, send: Sender = defaultSend): Promise<FlushResult> {
  flushing ??= (async () => {
    await loadOutbox();
    const result: FlushResult = { sent: 0, rejected: 0, offline: false };
    for (const item of outboxItems(userId)) {
      if (item.error) continue;
      try {
        await send(item);
        await removeItem(item.id);
        result.sent += 1;
      } catch (err) {
        if (isTransient(err) || (err instanceof ApiError && (err.status === 401 || err.status >= 500))) {
          item.attempts += 1;
          await save(item);
          result.offline = true;
          break;
        }
        const message = err instanceof ApiError ? err.message : 'Документ не принят';
        await save({ ...item, attempts: item.attempts + 1, error: message });
        result.rejected += 1;
      }
    }
    return result;
  })().finally(() => {
    flushing = null;
  });
  return flushing;
}

/** Для тестов: чистое состояние. */
export async function resetOutbox(): Promise<void> {
  items = [];
  ready = null;
  cache = null;
  await store.clear();
  emit();
}
