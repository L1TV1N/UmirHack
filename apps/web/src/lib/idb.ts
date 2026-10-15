/**
 * Маленькое хранилище «ключ → значение» поверх IndexedDB. Если браузер его не даёт (приватный режим, тесты),
 * данные живут в памяти до перезагрузки страницы: приложение от этого не ломается, только не работает офлайн.
 */
export type StoreName = 'catalog' | 'outbox' | 'waiter';

export interface Store {
  get<T>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
  values<T>(): Promise<T[]>;
  clear(): Promise<void>;
}

const DB_NAME = 'zapas';
const STORES: StoreName[] = ['catalog', 'outbox', 'waiter'];

let dbPromise: Promise<IDBDatabase | null> | null = null;

function openDb(): Promise<IDBDatabase | null> {
  dbPromise ??= new Promise((resolve) => {
    try {
      if (typeof indexedDB === 'undefined') return resolve(null);
      const request = indexedDB.open(DB_NAME, 2);
      request.onupgradeneeded = () => {
        for (const name of STORES) if (!request.result.objectStoreNames.contains(name)) request.result.createObjectStore(name);
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(null);
      request.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return dbPromise;
}

const memory = new Map<StoreName, Map<string, unknown>>();
const mem = (name: StoreName) => {
  let m = memory.get(name);
  if (!m) memory.set(name, (m = new Map()));
  return m;
};

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export function openStore(name: StoreName): Store {
  const run = async <T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest, fallback: () => T): Promise<T> => {
    const db = await openDb();
    if (!db) return fallback();
    try {
      return (await request(fn(db.transaction(name, mode).objectStore(name)))) as T;
    } catch {
      return fallback();
    }
  };
  return {
    get: <T,>(key: string) => run<T | undefined>('readonly', (s) => s.get(key), () => mem(name).get(key) as T | undefined),
    set: async (key, value) => {
      mem(name).set(key, value);
      await run<unknown>('readwrite', (s) => s.put(value, key), () => undefined);
    },
    delete: async (key) => {
      mem(name).delete(key);
      await run<unknown>('readwrite', (s) => s.delete(key), () => undefined);
    },
    values: <T,>() => run<T[]>('readonly', (s) => s.getAll(), () => [...mem(name).values()] as T[]),
    clear: async () => {
      mem(name).clear();
      await run<unknown>('readwrite', (s) => s.clear(), () => undefined);
    },
  };
}
