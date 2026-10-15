import { act, cleanup, render, renderHook, screen, fireEvent } from '@testing-library/react';
import type { WaiterDishDto } from '@zapas/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StopAlerts } from '../pages/Waiter/StopAlerts';
import { ALERT_LIFETIME_MS, diffStops, useStopAlerts } from './useStopAlerts';

const dish = (over: Partial<WaiterDishDto>): WaiterDishDto => ({ id: 'd1', name: 'Борщ', price: 290, stopped: false, stopNote: null, ingredients: [], hot: false, ...over });

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('что изменилось в стоп-листе', () => {
  it('находит блюдо, ушедшее в стоп, и блюдо, которое вернулось', () => {
    const before = new Map([
      ['a', false],
      ['b', true],
      ['c', false],
    ]);
    const menu = [dish({ id: 'a', name: 'Борщ', stopped: true, stopNote: 'Не хватает: Сметана' }), dish({ id: 'b', name: 'Омлет', stopped: false }), dish({ id: 'c', name: 'Каша' })];
    const out = diffStops(before, menu);
    expect(out.map((a) => [a.kind, a.dishId])).toEqual([
      ['stop', 'a'],
      ['back', 'b'],
    ]);
    expect(out[0]?.text).toBe('«Борщ» ушло в стоп-лист: Не хватает: Сметана');
    expect(out[1]?.text).toBe('«Омлет» снова можно заказывать');
  });

  it('новое блюдо в меню изменением не считается', () => {
    expect(diffStops(new Map([['a', false]]), [dish({ id: 'a' }), dish({ id: 'new', stopped: true })])).toEqual([]);
  });
});

describe('сообщения для официанта', () => {
  it('первая загрузка молчит, дальше сообщение появляется и само исчезает', () => {
    const { result, rerender } = renderHook(({ menu }) => useStopAlerts(menu), { initialProps: { menu: [dish({ id: 'a' })] } });
    expect(result.current.alerts).toEqual([]);
    rerender({ menu: [dish({ id: 'a', stopped: true, stopNote: 'нет в наличии' })] });
    expect(result.current.alerts).toHaveLength(1);
    act(() => void vi.advanceTimersByTime(ALERT_LIFETIME_MS + 10));
    expect(result.current.alerts).toHaveLength(0);
  });

  it('то же меню повторно ничего не добавляет, закрытие убирает сообщение', () => {
    const stopped = [dish({ id: 'a', stopped: true })];
    const { result, rerender } = renderHook(({ menu }) => useStopAlerts(menu), { initialProps: { menu: [dish({ id: 'a' })] } });
    rerender({ menu: stopped });
    rerender({ menu: [...stopped] });
    expect(result.current.alerts).toHaveLength(1);
    const id = result.current.alerts[0]?.id as string;
    act(() => result.current.dismiss(id));
    expect(result.current.alerts).toHaveLength(0);
  });

  it('хранит не больше четырёх сообщений', () => {
    const { result, rerender } = renderHook(({ menu }) => useStopAlerts(menu), { initialProps: { menu: Array.from({ length: 6 }, (_, i) => dish({ id: `d${i}`, name: `Б${i}` })) } });
    rerender({ menu: Array.from({ length: 6 }, (_, i) => dish({ id: `d${i}`, name: `Б${i}`, stopped: true })) });
    expect(result.current.alerts).toHaveLength(4);
  });

  it('баннер показывает текст и закрывается по кнопке', () => {
    const onDismiss = vi.fn();
    render(<StopAlerts alerts={[{ id: 'x', kind: 'stop', dishId: 'a', text: '«Борщ» ушло в стоп-лист' }]} onDismiss={onDismiss} />);
    expect(screen.getByRole('alert').textContent).toContain('«Борщ» ушло в стоп-лист');
    fireEvent.click(screen.getByLabelText('Закрыть сообщение'));
    expect(onDismiss).toHaveBeenCalledWith('x');
  });

  it('без сообщений ничего не рисует', () => {
    const { container } = render(<StopAlerts alerts={[]} onDismiss={() => undefined} />);
    expect(container.firstChild).toBeNull();
  });
});
