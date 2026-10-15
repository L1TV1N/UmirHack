import { cleanup, render, screen } from '@testing-library/react';
import type { HotDishDto } from '@zapas/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { HotDishItem } from './HotDishItem';

const base: HotDishDto = {
  dishId: 'd1',
  dishName: 'Сырники',
  price: 320,
  locationId: 'k',
  locationName: 'Кухня',
  priority: 64,
  portions: 12,
  portionsToPush: 8,
  daysLeft: 1,
  atRiskValue: 400,
  reasons: [],
  headline: 'Сырники',
  details: 'Творог заканчивается.',
  margin: { perPortion: 210, rate: 0.66, cost: 110 },
  timeFit: 0.35,
  factors: { margin: 1.06, time: 0.9 },
};

afterEach(cleanup);

describe('карточка горячего блюда', () => {
  it('показывает маржу и долю продаж дня впереди', () => {
    render(<ul><HotDishItem dish={base} /></ul>);
    expect(screen.getByText('Маржа 66%')).toBeTruthy();
    expect(screen.getByText('Впереди 35% продаж дня')).toBeTruthy();
  });

  it('без данных о марже и часах чипов нет', () => {
    render(<ul><HotDishItem dish={{ ...base, margin: null, timeFit: null, factors: { margin: 1, time: 1 } }} /></ul>);
    expect(screen.queryByText(/Маржа/)).toBeNull();
    expect(screen.queryByText(/Впереди/)).toBeNull();
  });

  it('в компактном виде (на главной) чипов нет', () => {
    render(<ul><HotDishItem dish={base} compact /></ul>);
    expect(screen.queryByText(/Маржа/)).toBeNull();
  });
});
