import { canonicalBarcode, type ProductDto, type ScanResult } from '@zapas/shared';
import { ApiError, get } from '../api/client';
import { isTransient } from '../api/transient';
import { openStore } from './idb';

/**
 * Каталог для сканера. Телефон хранит активные продукты со штрихкодом, поэтому код узнаётся без связи.
 * Каталог не содержит ничего, чего нет у пользователя в обычном списке продуктов, и стирается при выходе.
 */
const store = openStore('catalog');
const KEY = 'snapshot';
const MAX_AGE_MS = 60 * 60_000;

interface Snapshot {
  items: ProductDto[];
  savedAt: number;
}

let index = new Map<string, ProductDto>();
let savedAt = 0;
let loaded: Promise<void> | null = null;

function build(items: ProductDto[]): void {
  index = new Map();
  for (const p of items) {
    const key = p.barcode ? canonicalBarcode(p.barcode) : null;
    // при совпадении ключей выигрывает активный, но в каталог и так попадают только активные
    if (key && !index.has(key)) index.set(key, p);
  }
}

/** Поднимает сохранённый каталог в память. Вызывать можно сколько угодно раз. */
export function loadCatalog(): Promise<void> {
  loaded ??= store.get<Snapshot>(KEY).then((snap) => {
    if (snap) {
      build(snap.items);
      savedAt = snap.savedAt;
    }
  });
  return loaded;
}

export function catalogSize(): number {
  return index.size;
}

/** Обновляет каталог с сервера, если он старше часа или force. Без связи оставляет прежний. */
export async function refreshCatalog(force = false): Promise<'updated' | 'fresh' | 'offline'> {
  await loadCatalog();
  if (!force && Date.now() - savedAt < MAX_AGE_MS && index.size > 0) return 'fresh';
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return 'offline';
  try {
    const res = await get<{ items: ProductDto[] }>('/products/scan-index');
    build(res.items);
    savedAt = Date.now();
    await store.set(KEY, { items: res.items, savedAt } satisfies Snapshot);
    return 'updated';
  } catch (err) {
    if (isTransient(err)) return 'offline';
    throw err;
  }
}

export interface FindResult {
  product: ProductDto | null;
  /** Не удалось спросить сервер: продукт мог бы найтись при наличии связи. */
  offline: boolean;
}

/** Продукт по отсканированному коду: сначала из памяти телефона, затем у сервера. */
export async function findProduct(scan: ScanResult): Promise<FindResult> {
  await loadCatalog();
  if (!scan.key) return { product: null, offline: false };
  const local = index.get(scan.key);
  if (local) return { product: local, offline: false };

  try {
    const product = await get<ProductDto>(`/products/by-barcode/${scan.key}`);
    if (product.isActive) index.set(scan.key, product);
    return { product, offline: false };
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) return { product: null, offline: false };
    if (isTransient(err)) return { product: null, offline: true };
    throw err;
  }
}

/** Выход из системы: каталог с ценами не должен оставаться на устройстве. */
export async function clearCatalog(): Promise<void> {
  index = new Map();
  savedAt = 0;
  loaded = null;
  await store.clear();
}
