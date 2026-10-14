import { describe, expect, it } from 'vitest';
import { createGuestOrderBody, createUserBody, guestOrderStatusBody, hasRole, registerBody, reportIncidentBody, resolveIncidentBody, ROLES, ruDate, servesDishes, supplierStatusPush } from './index';

const id = '11111111-1111-4111-8111-111111111111';

describe('роли и типы заведений', () => {
  it('официант ниже наблюдателя: учёт ему закрыт, а общий минимум открыт', () => {
    expect(ROLES).toContain('waiter');
    expect(hasRole('waiter', 'viewer')).toBe(false);
    expect(hasRole('viewer', 'waiter')).toBe(true);
    expect(hasRole('admin', 'waiter')).toBe(true);
  });

  it('блюда готовят на кухнях, в кафе и барах', () => {
    expect(servesDishes('kitchen')).toBe(true);
    expect(servesDishes('cafe')).toBe(true);
    expect(servesDishes('bar')).toBe(true);
    expect(servesDishes('shop')).toBe(false);
    expect(servesDishes('warehouse')).toBe(false);
  });
});

describe('регистрация и пользователи', () => {
  it('регистрация требует название, имя, почту и надёжный пароль', () => {
    const ok = registerBody.safeParse({ organizationName: ' ООО «Вкус» ', fullName: 'Орлова Наталья', email: 'Owner@Vkus.EXAMPLE', password: 'Хорошая-длинная-фраза-91' });
    expect(ok.success).toBe(true);
    if (ok.success) expect(ok.data).toMatchObject({ organizationName: 'ООО «Вкус»', email: 'owner@vkus.example' });
    expect(registerBody.safeParse({ organizationName: '', fullName: 'Н', email: 'a@b.ru', password: 'Хорошая-длинная-фраза-91' }).success).toBe(false);
    expect(registerBody.safeParse({ organizationName: 'А', fullName: 'Н', email: 'a@b.ru', password: 'qwertyuiop' }).success).toBe(false);
    expect(registerBody.safeParse({ organizationName: 'А', fullName: 'Н', email: 'a@b.ru', password: 'Хорошая-длинная-фраза-91', role: 'admin' }).success).toBe(false);
  });

  it('пароль нового сотрудника можно не указывать, но если указан, проверяется', () => {
    expect(createUserBody.safeParse({ email: 'a@b.ru', fullName: 'Иванова Ольга', role: 'waiter' }).success).toBe(true);
    expect(createUserBody.safeParse({ email: 'a@b.ru', fullName: 'Иванова Ольга', role: 'waiter', password: 'короткий' }).success).toBe(false);
  });
});

describe('заказы гостей', () => {
  it('заказ принимает от одной до сорока строк с целым количеством', () => {
    expect(createGuestOrderBody.safeParse({ locationId: id, tableLabel: '7', lines: [{ dishId: id, quantity: 2 }] }).success).toBe(true);
    expect(createGuestOrderBody.safeParse({ locationId: id, tableLabel: '7', lines: [] }).success).toBe(false);
    expect(createGuestOrderBody.safeParse({ locationId: id, tableLabel: '7', lines: [{ dishId: id, quantity: 1.5 }] }).success).toBe(false);
    expect(createGuestOrderBody.safeParse({ locationId: id, tableLabel: ' ', lines: [{ dishId: id, quantity: 1 }] }).success).toBe(false);
    expect(createGuestOrderBody.safeParse({ locationId: id, tableLabel: '7', lines: Array.from({ length: 41 }, () => ({ dishId: id, quantity: 1 })) }).success).toBe(false);
  });

  it('отмена требует причину', () => {
    expect(guestOrderStatusBody.safeParse({ status: 'cancelled' }).success).toBe(false);
    expect(guestOrderStatusBody.safeParse({ status: 'cancelled', comment: 'Гость передумал' }).success).toBe(true);
    expect(guestOrderStatusBody.safeParse({ status: 'served' }).success).toBe(true);
    expect(guestOrderStatusBody.safeParse({ status: 'new' }).success).toBe(false);
  });

  it('обращение и решение по нему', () => {
    expect(reportIncidentBody.safeParse({ kind: 'dropped', blame: 'waiter', comment: 'Тарелка разбилась' }).success).toBe(true);
    expect(reportIncidentBody.safeParse({ kind: 'dropped', blame: 'someone', comment: 'x' }).success).toBe(false);
    expect(reportIncidentBody.safeParse({ kind: 'dropped', blame: 'waiter', comment: '' }).success).toBe(false);
    expect(resolveIncidentBody.safeParse({ action: 'remake', lineId: id }).success).toBe(true);
    expect(resolveIncidentBody.safeParse({ action: 'delete' }).success).toBe(false);
  });
});

describe('обмен с кабинетом поставщика', () => {
  it('статус поставщика только из трёх допустимых', () => {
    for (const status of ['confirmed', 'declined', 'shipped']) expect(supplierStatusPush.safeParse({ externalId: id, status }).success).toBe(true);
    expect(supplierStatusPush.safeParse({ externalId: id, status: 'received' }).success).toBe(false);
    expect(supplierStatusPush.safeParse({ externalId: id, status: 'shipped', deliveryOn: '16.10.2026' }).success).toBe(false);
  });

  it('дата для людей', () => {
    expect(ruDate('2026-10-16')).toBe('16.10.2026');
    expect(ruDate('2026-10-16T09:00:00Z')).toBe('16.10.2026');
  });
});
