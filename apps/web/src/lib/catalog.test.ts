import type { ProductDto, ScanResult } from '@zapas/shared';
import { parseScan } from '@zapas/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { catalogSize, clearCatalog, findProduct, refreshCatalog } from './catalog';

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const setOnline = (value: boolean) => Object.defineProperty(navigator, 'onLine', { value, configurable: true });

const product = (over: Partial<ProductDto>): ProductDto => ({
  id: 'p1',
  sku: 'MLK-1',
  barcode: '4006381333931',
  name: 'Молоко',
  categoryId: 'c',
  categoryName: 'Молочные',
  unit: 'l',
  minStock: 0,
  shelfLifeDays: 7,
  price: 90,
  cost: 60,
  sellable: true,
  requiresVsd: false,
  requiresMarking: false,
  defaultSupplierId: null,
  defaultSupplierName: null,
  packSize: 1,
  isActive: true,
  ...over,
});

const scan = (code: string): ScanResult => parseScan(code);

beforeEach(async () => {
  await clearCatalog();
  setOnline(true);
});
afterEach(() => {
  vi.unstubAllGlobals();
  setOnline(true);
});

describe('каталог сканера', () => {
  it('после загрузки узнаёт код без обращения к серверу, в том числе в записи GTIN-14', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json(200, { items: [product({})], limit: 10000 })));
    expect(await refreshCatalog(true)).toBe('updated');
    expect(catalogSize()).toBe(1);

    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    expect((await findProduct(scan('4006381333931'))).product?.id).toBe('p1');
    expect((await findProduct(scan('04006381333931'))).product?.id).toBe('p1');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('свежий каталог повторно не загружается', async () => {
    const fetchMock = vi.fn().mockResolvedValue(json(200, { items: [product({})], limit: 10000 }));
    vi.stubGlobal('fetch', fetchMock);
    await refreshCatalog(true);
    expect(await refreshCatalog()).toBe('fresh');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('без связи каталог не обновляется, а прежний остаётся', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json(200, { items: [product({})], limit: 10000 })));
    await refreshCatalog(true);
    setOnline(false);
    expect(await refreshCatalog(true)).toBe('offline');
    expect(catalogSize()).toBe(1);
  });

  it('сбой сети при обновлении это «без связи», а не ошибка', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    expect(await refreshCatalog(true)).toBe('offline');
  });

  it('неизвестного в памяти спрашивает у сервера и запоминает', async () => {
    const fetchMock = vi.fn().mockResolvedValue(json(200, product({ id: 'p9', barcode: '5901234123457', name: 'Новый' })));
    vi.stubGlobal('fetch', fetchMock);
    const first = await findProduct(scan('5901234123457'));
    expect(first.product?.name).toBe('Новый');
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe('/api/products/by-barcode/05901234123457');
    await findProduct(scan('5901234123457'));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('404 это «нет в номенклатуре», сбой сети это «нет связи»', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json(404, { error: { code: 'not_found', message: 'Продукт не найден' }, requestId: 'r' })));
    expect(await findProduct(scan('5901234123457'))).toEqual({ product: null, offline: false });
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    expect(await findProduct(scan('5901234123457'))).toEqual({ product: null, offline: true });
  });

  it('код без ключа (не штрихкод) даже не отправляется на сервер', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    expect(await findProduct(scan('https://example.ru'))).toEqual({ product: null, offline: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('выход из системы стирает каталог', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json(200, { items: [product({})], limit: 10000 })));
    await refreshCatalog(true);
    await clearCatalog();
    expect(catalogSize()).toBe(0);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json(404, { error: { code: 'not_found', message: 'нет' }, requestId: 'r' })));
    expect((await findProduct(scan('4006381333931'))).product).toBeNull();
  });
});
