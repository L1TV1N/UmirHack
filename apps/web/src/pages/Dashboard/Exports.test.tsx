import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { RescuedStatsDto, ShortageStatsDto } from '@zapas/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const downloadFile = vi.fn();
const toast = { success: vi.fn(), error: vi.fn(), info: vi.fn() };
let role: 'manager' | 'keeper' = 'manager';
let rescued: RescuedStatsDto;
let shortages: ShortageStatsDto;

vi.mock('../../api/client', () => ({
  downloadFile: (...a: unknown[]) => downloadFile(...a),
  ApiError: class ApiError extends Error {},
}));
vi.mock('../../api/hooks', () => ({
  useGet: (path: string) => ({ data: path.includes('rescued') ? rescued : shortages, isLoading: false, isError: false, refetch: vi.fn() }),
}));
vi.mock('../../auth/AuthProvider', () => ({ useAuth: () => ({ can: (r: string) => (r === 'manager' ? role === 'manager' : true) }) }));
vi.mock('../../components/Toast/Toast', () => ({ useToast: () => toast }));

import { RescuedPanel } from './RescuedPanel';
import { ShortagePanel } from './ShortagePanel';

beforeEach(() => {
  role = 'manager';
  downloadFile.mockReset();
  downloadFile.mockResolvedValue(undefined);
  rescued = { days: 30, revenue: 350, cost: 300, discountGiven: 150, batches: 1, products: [{ productId: 'p1', productName: 'Молоко', unit: 'l', quantity: 5, revenue: 350, cost: 300 }] };
  shortages = {
    days: 30,
    ingredients: [{ productId: 'p1', productName: 'Молоко', unit: 'l', episodes: 1, hours: 5, dishesBlocked: 1, refusedOrders: 1, lostRevenue: 800, ongoing: false }],
    totals: { episodes: 1, hours: 5, refusedOrders: 1, lostRevenue: 800 },
  };
});
afterEach(cleanup);

describe('выгрузка в CSV с главной', () => {
  it('«Спасено»: менеджер скачивает файл за тот же период и по той же точке', async () => {
    render(<RescuedPanel locationId="loc1" />);
    fireEvent.click(screen.getByRole('button', { name: /Скачать CSV/ }));
    await waitFor(() => expect(downloadFile).toHaveBeenCalledWith('/reports/rescued.csv', { locationId: 'loc1', days: 30 }, 'rescued.csv'));
  });

  it('«Дефицит»: менеджер скачивает файл', async () => {
    render(<ShortagePanel locationId={undefined} />);
    fireEvent.click(screen.getByRole('button', { name: /Скачать CSV/ }));
    await waitFor(() => expect(downloadFile).toHaveBeenCalledWith('/reports/shortages.csv', { locationId: undefined, days: 30 }, 'shortages.csv'));
  });

  it('кнопки нет у тех, кому отчёты закрыты, и там, где выгружать нечего', () => {
    role = 'keeper';
    const { unmount } = render(
      <>
        <RescuedPanel locationId={undefined} />
        <ShortagePanel locationId={undefined} />
      </>,
    );
    expect(screen.queryByRole('button', { name: /Скачать CSV/ })).toBeNull();
    unmount();

    role = 'manager';
    rescued = { ...rescued, batches: 0, products: [] };
    shortages = { ...shortages, ingredients: [] };
    render(
      <>
        <RescuedPanel locationId={undefined} />
        <ShortagePanel locationId={undefined} />
      </>,
    );
    expect(screen.queryByRole('button', { name: /Скачать CSV/ })).toBeNull();
  });

  it('ошибка скачивания показывается сообщением, кнопка снова доступна', async () => {
    downloadFile.mockRejectedValueOnce(new Error('Нет связи'));
    render(<RescuedPanel locationId={undefined} />);
    fireEvent.click(screen.getByRole('button', { name: /Скачать CSV/ }));
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect((screen.getByRole('button', { name: /Скачать CSV/ }) as HTMLButtonElement).disabled).toBe(false);
  });
});
