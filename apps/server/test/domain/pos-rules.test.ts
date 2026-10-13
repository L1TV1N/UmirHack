import { posRules } from '@zapas/shared';
import { describe, expect, it } from 'vitest';
import { POS_PRESETS } from '../../src/modules/pos/presets';
import { normalizeReceipts } from '../../src/modules/pos/rules';

const rules = (vendor: keyof typeof POS_PRESETS) => POS_PRESETS[vendor].rules;

describe('разбор чеков по правилам', () => {
  it('все пресеты проходят проверку схемы и читают свои образцы', () => {
    for (const v of Object.keys(POS_PRESETS) as (keyof typeof POS_PRESETS)[]) {
      expect(posRules.safeParse(rules(v)).success, v).toBe(true);
      const receipts = normalizeReceipts(rules(v), POS_PRESETS[v].sample);
      expect(receipts.length, v).toBeGreaterThan(0);
      expect(receipts[0]?.lines.length, v).toBeGreaterThan(0);
    }
  });

  it('десятичная запятая и пробелы в числах, знак количества в возврате отбрасывается', () => {
    const csv = 'Номер чека;Тип;Код товара;Количество;Цена\n1;Продажа;A;"1 000,5";"99,90"\n2;Возврат;A;-2;50\n';
    const [a, b] = normalizeReceipts(rules('frontol'), csv);
    expect(a?.lines[0]).toMatchObject({ code: 'A', quantity: 1000.5, price: 99.9 });
    expect(b).toMatchObject({ kind: 'return', lines: [{ quantity: 2 }] });
  });

  it('кавычки и переводы строк внутри ячейки CSV не ломают разбор', () => {
    const csv = 'Номер чека;Тип;Наименование;Количество\n1;Продажа;"Блюдо; ""дня""\nсо сметаной";1\n';
    const [r] = normalizeReceipts(rules('frontol'), csv);
    expect(r?.lines[0]?.name).toBe('Блюдо; "дня"\nсо сметаной');
  });

  it('XML с одним элементом вместо списка читается так же, как со списком', () => {
    const one = '<receipts><receipt id="1"><items><item><code>A</code><quantity>1</quantity></item></items></receipt></receipts>';
    const [r] = normalizeReceipts(rules('atol'), one);
    expect(r?.lines).toEqual([{ code: 'A', barcode: null, name: null, quantity: 1, price: null }]);
  });

  it('массив чеков в корне и значения типа в другом регистре', () => {
    const r = rules('evotor');
    const out = normalizeReceipts(r, [{ id: 'a', type: 'payback', body: { positions: [{ code: 'X', quantity: 1 }] } }, { id: 'b', type: 'SELL', body: { positions: [{ code: 'X', quantity: 1 }] } }]);
    expect(out.map((x) => x.kind)).toEqual(['return', 'sale']);
  });

  it('ошибки объясняют, чего не нашли', () => {
    const r = rules('evotor');
    expect(() => normalizeReceipts(r, { type: 'SELL' })).toThrow(/номер чека/);
    expect(() => normalizeReceipts(r, { id: '1', body: { positions: [{ code: 'A', quantity: 'мало' }] } })).toThrow(/количества/);
    expect(() => normalizeReceipts(r, 'не json')).toThrow(/JSON/);
    expect(() => normalizeReceipts(rules('frontol'), 'Номер чека;Количество\n;1\n')).toThrow(/номера чека/);
    expect(() => normalizeReceipts(rules('frontol'), { a: 1 })).toThrow(/CSV/);
  });
});
