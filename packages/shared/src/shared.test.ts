import { describe, expect, it } from 'vitest';
import {
  addDays,
  checkPassword,
  createProductBody,
  daysBetween,
  expiryStatus,
  isValidIsoDate,
  loginBody,
  manualStopBody,
  receiptBody,
  todayIn,
  toMilli,
  transferBody,
  useRussianErrors,
} from './index';

const uuid = '3f0c6a52-5d6e-4f55-9d0b-1f7f8f0f7a11';
const uuid2 = '8a2d1a3c-4c1e-4b61-8f4c-3a0b6c1d9e22';

describe('даты', () => {
  it('проверяет календарную корректность', () => {
    expect(isValidIsoDate('2026-02-28')).toBe(true);
    expect(isValidIsoDate('2026-02-30')).toBe(false);
    expect(isValidIsoDate('2024-02-29')).toBe(true);
    expect(isValidIsoDate('2026-2-3')).toBe(false);
  });

  it('считает разницу в сутках через границы месяца и года', () => {
    expect(daysBetween('2026-10-08', '2026-10-09')).toBe(1);
    expect(daysBetween('2026-12-31', '2027-01-02')).toBe(2);
    expect(daysBetween('2026-10-08', '2026-10-01')).toBe(-7);
  });

  it('прибавляет сутки', () => {
    expect(addDays('2026-02-27', 2)).toBe('2026-03-01');
    expect(addDays('2026-01-01', -1)).toBe('2025-12-31');
  });

  it('берёт дату в часовом поясе бизнеса, а не UTC', () => {
    const moment = new Date('2026-10-08T22:30:00Z');
    expect(todayIn('Europe/Moscow', moment)).toBe('2026-10-09');
    expect(todayIn('UTC', moment)).toBe('2026-10-08');
  });

  it('классифицирует срок по границам', () => {
    const t = { criticalDays: 1, expiringSoonDays: 3 };
    expect(expiryStatus(-1, t)).toBe('expired');
    expect(expiryStatus(0, t)).toBe('critical');
    expect(expiryStatus(1, t)).toBe('critical');
    expect(expiryStatus(2, t)).toBe('soon');
    expect(expiryStatus(3, t)).toBe('soon');
    expect(expiryStatus(4, t)).toBe('ok');
  });
});

describe('количества', () => {
  it('переводит в тысячные без накопления ошибки', () => {
    expect(toMilli(0.1 + 0.2)).toBe(300);
    expect(toMilli(1.005)).toBe(1005);
  });
});

describe('пароли', () => {
  it('отклоняет короткие, простые и очевидные', () => {
    expect(checkPassword('Short1')).toMatch(/не короче/);
    expect(checkPassword('aaaaaaaaaaaa')).toMatch(/простой/);
    expect(checkPassword('abcdefghijkl')).toMatch(/простой/);
    expect(checkPassword('Qwertyuiop')).toMatch(/распространён/);
    expect(checkPassword('password2024')).toMatch(/распространён/);
    expect(checkPassword('anna.petrova2026', { email: 'anna.petrova@example.ru' })).toMatch(/почты/);
    expect(checkPassword('Sidorov-2026-ok', { fullName: 'Иван Sidorov' })).toMatch(/имя или фамилию/);
  });

  it('принимает длинную фразу', () => {
    expect(checkPassword('медведь-кофе-рельсы-47')).toBeNull();
  });
});

describe('схемы', () => {
  useRussianErrors();

  it('не пропускает лишние поля в теле', () => {
    const r = loginBody.safeParse({ email: 'a@b.ru', password: 'x', isAdmin: true });
    expect(r.success).toBe(false);
  });

  it('приводит email к нижнему регистру', () => {
    const r = loginBody.parse({ email: ' Ivan@Example.RU ', password: 'x' });
    expect(r.email).toBe('ivan@example.ru');
  });

  it('ограничивает точность количества и срок', () => {
    const base = { locationId: uuid, lines: [{ productId: uuid, quantity: 1, unitCost: 10, expiresOn: '2026-10-20' }] };
    expect(receiptBody.safeParse(base).success).toBe(true);
    const bad = { ...base, lines: [{ productId: uuid, quantity: 1.0005, unitCost: 10, expiresOn: '2026-10-20' }] };
    expect(receiptBody.safeParse(bad).success).toBe(false);
    const badDate = { ...base, lines: [{ productId: uuid, quantity: 1, unitCost: 10, expiresOn: '2026-13-01' }] };
    expect(receiptBody.safeParse(badDate).success).toBe(false);
  });

  it('принимает срок хранения в днях вместо даты, но не оба способа сразу', () => {
    const line = { productId: uuid, quantity: 1, unitCost: 10 };
    expect(receiptBody.safeParse({ locationId: uuid, lines: [{ ...line, shelfLifeDays: 5 }] }).success).toBe(true);
    expect(receiptBody.safeParse({ locationId: uuid, lines: [line] }).success).toBe(true);
    expect(receiptBody.safeParse({ locationId: uuid, lines: [{ ...line, expiresOn: '2026-10-20', shelfLifeDays: 5 }] }).success).toBe(false);
    expect(receiptBody.safeParse({ locationId: uuid, lines: [{ ...line, shelfLifeDays: 0 }] }).success).toBe(false);
    expect(receiptBody.safeParse({ locationId: uuid, lines: [{ ...line, shelfLifeDays: 4000 }] }).success).toBe(false);
  });

  it('требует ровно одну сущность для ручного стопа', () => {
    expect(manualStopBody.safeParse({ locationId: uuid, reason: 'нет', productId: uuid }).success).toBe(true);
    expect(manualStopBody.safeParse({ locationId: uuid, reason: 'нет' }).success).toBe(false);
    expect(manualStopBody.safeParse({ locationId: uuid, reason: 'нет', productId: uuid, dishId: uuid2 }).success).toBe(false);
  });

  it('запрещает перемещение в ту же точку', () => {
    const line = { productId: uuid, quantity: 1 };
    expect(transferBody.safeParse({ fromLocationId: uuid, toLocationId: uuid, lines: [line] }).success).toBe(false);
    expect(transferBody.safeParse({ fromLocationId: uuid, toLocationId: uuid2, lines: [line] }).success).toBe(true);
  });

  it('подставляет значения по умолчанию для продукта', () => {
    const r = createProductBody.parse({ sku: 'MLK-01', name: 'Молоко 3,2%', categoryId: uuid, unit: 'l', price: 89.9, cost: 61 });
    expect(r.minStock).toBe(0);
    expect(r.sellable).toBe(true);
  });
});
