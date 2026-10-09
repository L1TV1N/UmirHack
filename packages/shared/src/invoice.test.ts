import { describe, expect, it } from 'vitest';
import { completeInn, convertInvoiceUnit, isValidInn, itemMapBody, parseInvoiceBody, parseInvoicePhotoBody } from './invoice';
import { supplierBody } from './schemas';

describe('ИНН', () => {
  it('принимает настоящие ИНН организаций и предпринимателей', () => {
    expect(isValidInn('7707083893')).toBe(true); // Сбербанк
    expect(isValidInn('7736050003')).toBe(true); // Газпром
    expect(isValidInn('500100732259')).toBe(true); // физическое лицо
  });

  it('отвергает ошибку в цифре, неверную длину и не цифры', () => {
    expect(isValidInn('7707083894')).toBe(false);
    expect(isValidInn('770708389')).toBe(false);
    expect(isValidInn('500100732258')).toBe(false);
    expect(isValidInn('77070838A3')).toBe(false);
    expect(isValidInn('')).toBe(false);
  });

  it('достраивает до верного ИНН (для демо-данных)', () => {
    expect(isValidInn(completeInn('616301234'))).toBe(true);
    expect(isValidInn(completeInn('6163012345'))).toBe(true);
    expect(completeInn('616301234')).toHaveLength(10);
    expect(completeInn('6163012345')).toHaveLength(12);
    expect(() => completeInn('123')).toThrow();
  });

  it('поставщик принимает пустой ИНН и верный, но не неверный', () => {
    const base = { name: 'ООО «Тест»' };
    expect(supplierBody.safeParse({ ...base, inn: '' }).success).toBe(true);
    expect(supplierBody.safeParse({ ...base }).success).toBe(true);
    expect(supplierBody.safeParse({ ...base, inn: '7707083893' }).success).toBe(true);
    expect(supplierBody.safeParse({ ...base, inn: '7707083890' }).success).toBe(false);
  });
});

describe('пересчёт единиц накладной', () => {
  it('граммы в килограммы и цена за килограмм', () => {
    expect(convertInvoiceUnit(500, 0.12, 'g', 'kg')).toEqual({ quantity: 0.5, price: 120 });
  });

  it('миллилитры в литры, тонны в килограммы', () => {
    expect(convertInvoiceUnit(930, 0.06, 'ml', 'l')).toEqual({ quantity: 0.93, price: 60 });
    expect(convertInvoiceUnit(2, 50000, 't', 'kg')).toEqual({ quantity: 2000, price: 50 });
  });

  it('те же единицы и неизвестная единица не меняют числа', () => {
    expect(convertInvoiceUnit(10, 62, 'l', 'l')).toEqual({ quantity: 10, price: 62 });
    expect(convertInvoiceUnit(10, 62, null, 'kg')).toEqual({ quantity: 10, price: 62 });
    expect(convertInvoiceUnit(10, null, 'kg', 'kg')).toEqual({ quantity: 10, price: null });
  });

  it('несовместимые единицы (штуки и килограммы) не пересчитываются', () => {
    expect(convertInvoiceUnit(10, 62, 'pcs', 'kg')).toBeNull();
    expect(convertInvoiceUnit(10, 62, 'l', 'pcs')).toBeNull();
  });
});

describe('тела запросов', () => {
  it('накладная приходит base64, лишние поля и чужой формат отклоняются', () => {
    expect(parseInvoiceBody.safeParse({ format: 'upd', content: 'PD94bWwgdmVyc2lvbj0iMS4wIj8+' }).success).toBe(true);
    expect(parseInvoiceBody.safeParse({ format: 'csv', content: 'PD94bWwgdmVyc2lvbj0iMS4wIj8+' }).success).toBe(false);
    expect(parseInvoiceBody.safeParse({ format: 'upd', content: '<xml>не base64</xml>' }).success).toBe(false);
    expect(parseInvoiceBody.safeParse({ format: 'upd', content: 'PD94bWwgdmVyc2lvbj0iMS4wIj8+', extra: 1 }).success).toBe(false);
  });

  it('фото: только картинки', () => {
    expect(parseInvoicePhotoBody.safeParse({ mediaType: 'image/jpeg', image: 'AAAAAAAAAAAAAAAAAAAA' }).success).toBe(true);
    expect(parseInvoicePhotoBody.safeParse({ mediaType: 'application/pdf', image: 'AAAAAAAAAAAAAAAAAAAA' }).success).toBe(false);
  });

  it('соответствия: не пусто, не больше 200, продукт это uuid', () => {
    const id = '0bb8f1c8-1b33-41e2-8ec8-0563e33396ed';
    expect(itemMapBody.safeParse({ items: [{ key: 'name:молоко', productId: id }] }).success).toBe(true);
    expect(itemMapBody.safeParse({ items: [] }).success).toBe(false);
    expect(itemMapBody.safeParse({ items: [{ key: 'k', productId: 'не-uuid' }] }).success).toBe(false);
    expect(itemMapBody.safeParse({ items: Array.from({ length: 201 }, (_, i) => ({ key: `k${i}`, productId: id })) }).success).toBe(false);
  });
});
