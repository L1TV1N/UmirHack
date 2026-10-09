import { describe, expect, it } from 'vitest';
import { closeOrderBody, createOrderBody, createProductBody, orderFromSuggestionBody, ordersQuery, receiptBody, supplierBody, updateOrderBody } from './schemas';

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const line = (n: number, over: object = {}) => ({ productId: uuid(n), quantity: 5, unitCost: 60, ...over });

describe('почта поставщика', () => {
  const ok = (email: string) => supplierBody.safeParse({ name: 'Донской', email });
  it('принимает один обычный адрес и пустую строку', () => {
    expect(ok('orders@donskoy.ru').success).toBe(true);
    expect(ok('').success).toBe(true);
    expect(ok('  zakaz@milk-don.ru ').success).toBe(true);
  });
  it('отклоняет несколько адресов, пробелы, переводы строк и скобки', () => {
    for (const v of ['a@b.ru, c@d.ru', 'a@b.ru;c@d.ru', 'a b@c.ru', 'a@b.ru\nBcc: x@y.ru', '<a@b.ru>', 'a@b', '@b.ru', 'a@b.ru‮', '"x"@b.ru']) {
      expect(ok(v).success, JSON.stringify(v)).toBe(false);
    }
  });
  it('срок поставки и минимальная сумма в разумных пределах', () => {
    expect(supplierBody.safeParse({ name: 'A', leadTimeDays: 31 }).success).toBe(false);
    expect(supplierBody.safeParse({ name: 'A', leadTimeDays: -1 }).success).toBe(false);
    expect(supplierBody.safeParse({ name: 'A', leadTimeDays: 1.5 }).success).toBe(false);
    expect(supplierBody.safeParse({ name: 'A', minOrderSum: -5 }).success).toBe(false);
    expect(supplierBody.safeParse({ name: 'A', minOrderSum: 5000.555 }).success).toBe(false);
    expect(supplierBody.safeParse({ name: 'A', leadTimeDays: 3, minOrderSum: 5000, autoOrder: true }).success).toBe(true);
  });
});

describe('заказ', () => {
  const base = { supplierId: uuid(1), locationId: uuid(2), lines: [line(10)] };
  it('нужна хотя бы одна строка, не больше двухсот, без повторов продукта', () => {
    expect(createOrderBody.safeParse(base).success).toBe(true);
    expect(createOrderBody.safeParse({ ...base, lines: [] }).success).toBe(false);
    expect(createOrderBody.safeParse({ ...base, lines: Array.from({ length: 201 }, (_, i) => line(i + 1)) }).success).toBe(false);
    expect(createOrderBody.safeParse({ ...base, lines: [line(10), line(10, { quantity: 1 })] }).success).toBe(false);
  });
  it('количество положительное, цена не отрицательная, лишних полей нет', () => {
    expect(createOrderBody.safeParse({ ...base, lines: [line(10, { quantity: 0 })] }).success).toBe(false);
    expect(createOrderBody.safeParse({ ...base, lines: [line(10, { unitCost: -1 })] }).success).toBe(false);
    expect(createOrderBody.safeParse({ ...base, status: 'sent' }).success).toBe(false);
    expect(createOrderBody.safeParse({ ...base, lines: [line(10, { receivedQty: 5 })] }).success).toBe(false);
  });
  it('в изменении всё необязательно, дату и комментарий можно очистить', () => {
    expect(updateOrderBody.safeParse({}).success).toBe(true);
    expect(updateOrderBody.safeParse({ expectedOn: null, comment: null }).success).toBe(true);
    expect(updateOrderBody.safeParse({ expectedOn: '2026-02-30' }).success).toBe(false);
  });
  it('запрос списка и закрытие заказа', () => {
    expect(ordersQuery.parse({}).status).toBe('all');
    expect(ordersQuery.safeParse({ status: 'open' }).success).toBe(true);
    expect(ordersQuery.safeParse({ status: 'weird' }).success).toBe(false);
    expect(orderFromSuggestionBody.safeParse({ supplierId: uuid(1), locationId: uuid(2) }).success).toBe(true);
    expect(closeOrderBody.safeParse({ comment: 'Поставщик довёз меньше' }).success).toBe(true);
  });
});

describe('продукт: поставщик и фасовка', () => {
  const base = { sku: 'A-1', name: 'Молоко', categoryId: uuid(3), unit: 'l', price: 10, cost: 5 };
  it('фасовка по умолчанию 1, поставщик необязателен', () => {
    const parsed = createProductBody.parse(base);
    expect(parsed.packSize).toBe(1);
    expect(parsed.defaultSupplierId).toBeUndefined();
  });
  it('фасовка должна быть положительной и не слишком большой', () => {
    for (const bad of [0, -1, 1001, 0.0001]) expect(createProductBody.safeParse({ ...base, packSize: bad }).success, String(bad)).toBe(false);
    expect(createProductBody.safeParse({ ...base, packSize: 12, defaultSupplierId: uuid(1) }).success).toBe(true);
  });
});

describe('приход по заказу', () => {
  it('принимает идентификатор заказа', () => {
    const body = { locationId: uuid(2), lines: [{ productId: uuid(5), quantity: 1, unitCost: 1, expiresOn: '2026-12-01' }] };
    expect(receiptBody.safeParse({ ...body, orderId: uuid(9) }).success).toBe(true);
    expect(receiptBody.safeParse({ ...body, orderId: 'не uuid' }).success).toBe(false);
  });
});
