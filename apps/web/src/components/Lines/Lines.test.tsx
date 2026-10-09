import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { useLines } from './Lines';

interface Line {
  key: number;
  product: string | null;
  quantity: number;
}

const setup = () => renderHook(() => useLines<Line>(() => ({ product: null, quantity: 0 })));
const find = (id: string) => (l: Line) => l.product === id;
const plusOne = (l: Line) => ({ quantity: l.quantity + 1 });
const blank = (l: Line) => l.product === null;

describe('строки документа и сканер', () => {
  it('первый скан заполняет пустую строку, а не добавляет новую', () => {
    const { result } = setup();
    act(() => void result.current.upsert(find('milk'), plusOne, { product: 'milk', quantity: 1 }, blank));
    expect(result.current.lines).toHaveLength(1);
    expect(result.current.lines[0]).toMatchObject({ product: 'milk', quantity: 1 });
  });

  it('повторный скан того же товара прибавляет единицу', () => {
    const { result } = setup();
    act(() => {
      result.current.upsert(find('milk'), plusOne, { product: 'milk', quantity: 1 }, blank);
      result.current.upsert(find('milk'), plusOne, { product: 'milk', quantity: 1 }, blank);
    });
    expect(result.current.lines).toHaveLength(1);
    expect(result.current.lines[0]?.quantity).toBe(2);
  });

  it('другой товар добавляется новой строкой, когда пустых нет', () => {
    const { result } = setup();
    act(() => {
      result.current.upsert(find('milk'), plusOne, { product: 'milk', quantity: 1 }, blank);
      result.current.upsert(find('bread'), plusOne, { product: 'bread', quantity: 1 }, blank);
    });
    expect(result.current.lines.map((l) => l.product)).toEqual(['milk', 'bread']);
  });

  it('три скана подряд до перерисовки считаются верно', () => {
    const { result } = setup();
    let last = 0;
    act(() => {
      for (let i = 0; i < 3; i += 1) last = result.current.upsert(find('milk'), plusOne, { product: 'milk', quantity: 1 }, blank).line.quantity;
    });
    expect(last).toBe(3);
    expect(result.current.lines).toHaveLength(1);
  });

  it('пустая строка посередине занимается раньше, чем добавится новая', () => {
    const { result } = setup();
    act(() => {
      result.current.add();
      result.current.update(result.current.lines[0]?.key as number, { product: 'milk', quantity: 5 });
    });
    const res = result.current.upsert(find('bread'), plusOne, { product: 'bread', quantity: 1 }, blank);
    expect(res.created).toBe(true);
    expect(result.current.lines).toHaveLength(2);
  });

  it('обычные операции со строками работают как прежде', () => {
    const { result } = setup();
    act(() => result.current.add());
    expect(result.current.lines).toHaveLength(2);
    const key = result.current.lines[0]?.key as number;
    act(() => result.current.update(key, { quantity: 7 }));
    expect(result.current.lines[0]?.quantity).toBe(7);
    act(() => result.current.remove(key));
    expect(result.current.lines).toHaveLength(1);
    act(() => result.current.remove(result.current.lines[0]?.key as number));
    expect(result.current.lines).toHaveLength(1);
    act(() => result.current.reset());
    expect(result.current.lines).toHaveLength(1);
    expect(result.current.lines[0]?.quantity).toBe(0);
  });
});
