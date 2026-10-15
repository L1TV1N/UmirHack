import { cleanup, render, screen } from '@testing-library/react';
import type { IncomingInfoDto, StopForecastCoveredDto, StopForecastDto } from '@zapas/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { describeIncoming } from '../../lib/incoming';

vi.mock('../../api/client', () => ({ del: vi.fn(), post: vi.fn() }));
vi.mock('../../api/hooks', () => ({ useGet: vi.fn(), useAction: vi.fn() }));
vi.mock('../../auth/AuthProvider', () => ({ useAuth: () => ({ can: () => true }) }));
vi.mock('../../auth/ScopeProvider', () => ({ useScope: () => ({ locationId: 'k1', activeLocations: [] }) }));

import { CoveredPanel, ForecastPanel } from './StopListPage';

const info = (over: Partial<IncomingInfoDto> = {}): IncomingInfoDto => ({ orderId: 'o1', orderNumber: 'ЗК-000771', productId: 'p1', productName: 'Молоко', unit: 'l', quantity: 40, arrivesOn: '2026-10-16', ...over });
const forecast = (over: Partial<StopForecastDto> = {}): StopForecastDto => ({
  dishId: 'd1',
  dishName: 'Каша манная',
  locationId: 'k1',
  locationName: 'Кухня',
  expectedAt: '2026-10-14T20:00:00.000Z',
  hoursLeft: 15,
  cause: 'depletion',
  portionsNow: 6,
  limiting: { productId: 'p1', productName: 'Молоко', unit: 'l', availableNow: 3, perPortion: 0.5, perDay: 4 },
  incoming: null,
  ...over,
});

afterEach(cleanup);

describe('поставки в пути на странице стоп-листа', () => {
  it('одна строка: что, сколько, какой заказ и когда', () => {
    expect(describeIncoming(info()).replace(/\s/g, ' ')).toBe('Молоко 40 л, заказ ЗК-000771, привезут 16.10.2026');
  });

  it('прогноз без поставки выглядит как прежде', () => {
    render(<ForecastPanel items={[forecast()]} />);
    expect(screen.getByText('Каша манная')).toBeTruthy();
    expect(screen.queryByText(/поставка/i)).toBeNull();
  });

  it('поставка, которая сдвинула остановку, названа заказом', () => {
    render(<ForecastPanel items={[forecast({ incoming: info() })]} />);
    expect(screen.getByText(/Едет поставка: Молоко 40 л, заказ ЗК-000771/)).toBeTruthy();
  });

  it('поставка, которая не успевает, подсвечена как опаздывающая', () => {
    render(<ForecastPanel items={[forecast({ incoming: info({ afterStop: true }) })]} />);
    expect(screen.getByText(/Поставка не успевает: Молоко 40 л/)).toBeTruthy();
  });

  it('«выручит поставка»: блюдо, срок до остановки без неё и заказ', () => {
    const items: StopForecastCoveredDto[] = [{ dishId: 'd1', dishName: 'Каша манная', locationId: 'k1', locationName: 'Кухня', hoursWithoutDelivery: 15, incoming: info() }];
    render(<CoveredPanel items={items} />);
    expect(screen.getByText('Выручит поставка')).toBeTruthy();
    expect(screen.getByText('Каша манная')).toBeTruthy();
    expect(screen.getByText(/без неё через 15 ч/)).toBeTruthy();
    expect(screen.getByText(/заказ ЗК-000771/)).toBeTruthy();
  });

  it('длинный список обрезается с подсказкой «и ещё»', () => {
    const items: StopForecastCoveredDto[] = Array.from({ length: 11 }, (_, i) => ({ dishId: `d${i}`, dishName: `Блюдо ${i}`, locationId: 'k1', locationName: 'Кухня', hoursWithoutDelivery: 10 + i, incoming: info() }));
    render(<CoveredPanel items={items} />);
    expect(screen.getByText('и ещё 3')).toBeTruthy();
  });
});
