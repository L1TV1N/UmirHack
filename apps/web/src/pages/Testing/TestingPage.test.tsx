import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const toast = { success: vi.fn(), error: vi.fn(), info: vi.fn() };
const product = (id: string, name: string, barcode: string | null) => ({ id, sku: `S-${id}`, name, barcode, categoryName: 'Молочные', isActive: true });

vi.mock('../../api/hooks', () => ({
  useGet: (path: string) => {
    if (path === '/products') {
      return { data: { items: [product('1', 'Кефир 2,5%', '4006381333931'), product('2', 'Без кода', null), product('3', 'Битый код', '4006381333932'), product('4', 'Сок', '96385074')], total: 4 }, isLoading: false, isError: false };
    }
    if (path === '/selfcheck') {
      return { data: { checkedAt: '2026-10-12T10:00:00.000Z', items: [{ id: 'db', group: 'Основа', title: 'База данных', status: 'ok', detail: 'Отвечает' }, { id: 'tg', group: 'Настройки', title: 'Telegram', status: 'warn', detail: 'Не подключён' }] }, isLoading: false, isError: false, isFetching: false, refetch: vi.fn() };
    }
    return { data: undefined, isLoading: false, isError: false };
  },
}));
vi.mock('../../components/Toast/Toast', () => ({ useToast: () => toast }));

import TestingPage from './TestingPage';

const at = (url: string) => (
  <MemoryRouter initialEntries={[url]}>
    <TestingPage />
  </MemoryRouter>
);

beforeEach(() => localStorage.clear());
afterEach(cleanup);

describe('страница тестирования', () => {
  it('рисует только верные штрихкоды EAN и копирует номер по нажатию', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    render(at('/testing?tab=barcodes'));
    expect(screen.getByLabelText('Штрихкод 4006381333931')).toBeTruthy();
    expect(screen.getByLabelText('Штрихкод 96385074')).toBeTruthy();
    expect(screen.queryByText('Без кода')).toBeNull();
    expect(screen.queryByText('Битый код')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Кефир 2,5%, штрихкод 4006381333931/ }));
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith('4006381333931'));
    expect(await screen.findByText('Номер скопирован')).toBeTruthy();
  });

  it('поиск сужает список', () => {
    render(at('/testing?tab=barcodes'));
    fireEvent.change(screen.getByLabelText('Поиск штрихкода'), { target: { value: 'сок' } });
    expect(screen.queryByText('Кефир 2,5%')).toBeNull();
    expect(screen.getByText('Сок')).toBeTruthy();
  });

  it('проверка системы показывает статусы по группам', () => {
    render(at('/testing?tab=checks'));
    expect(screen.getByText('База данных')).toBeTruthy();
    expect(screen.getByText('Не подключён')).toBeTruthy();
    expect(screen.getByText('внимание: 1')).toBeTruthy();
  });

  it('чек-лист запоминает отметки', () => {
    const first = render(at('/testing?tab=scenarios'));
    const boxes = screen.getAllByRole('checkbox');
    fireEvent.click(boxes[0] as HTMLElement);
    expect(screen.getByText(/Пройдено 1 из/)).toBeTruthy();
    first.unmount();
    render(at('/testing?tab=scenarios'));
    expect(screen.getByText(/Пройдено 1 из/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Сбросить отметки' }));
    expect(screen.getByText(/Пройдено 0 из/)).toBeTruthy();
  });
});
