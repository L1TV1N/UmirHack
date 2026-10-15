import { openStore } from './idb';

/**
 * Последние ответы сервера для экрана официанта: меню, горячее, стоп-лист, мои заказы. Без связи официант видит их
 * и может принять заказ. Данные привязаны к пользователю и стираются при выходе.
 */
const store = openStore('waiter');

export interface Saved<T> {
  data: T;
  savedAt: number;
}

const keyOf = (userId: string, key: string): string => `${userId}|${key}`;

export async function saveWaiterData<T>(userId: string, key: string, data: T): Promise<void> {
  await store.set(keyOf(userId, key), { data, savedAt: Date.now() } satisfies Saved<T>);
}

export async function loadWaiterData<T>(userId: string, key: string): Promise<Saved<T> | null> {
  return (await store.get<Saved<T>>(keyOf(userId, key))) ?? null;
}

export async function clearWaiterCache(): Promise<void> {
  await store.clear();
}
