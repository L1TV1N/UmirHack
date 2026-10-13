import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { PosConnectionDto, PosPresetDto, PosUnmatchedDto } from '@zapas/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const post = vi.fn();
const put = vi.fn();
const toast = { success: vi.fn(), error: vi.fn(), info: vi.fn() };
let conns: PosConnectionDto[] = [];
let unmatched: PosUnmatchedDto[] = [];

const preset = (vendor: PosPresetDto['vendor'], label: string, hint: string): PosPresetDto => ({
  vendor,
  label,
  hint,
  sampleType: 'application/json',
  sample: '{"id":"1"}',
  rules: { format: 'json', id: ['id'], lines: 'lines', quantity: ['q'], returnValues: ['PAYBACK'], delimiter: ';' },
});

vi.mock('../../api/client', () => ({
  ApiError: class extends Error {},
  post: (...a: unknown[]) => post(...a),
  put: (...a: unknown[]) => put(...a),
  patch: vi.fn(),
  del: vi.fn(),
  get: vi.fn(),
}));
vi.mock('../../api/hooks', () => ({
  STOCK_PREFIXES: [],
  useGet: (path: string) => {
    if (path === '/pos/connections') return { data: conns, isLoading: false, isError: false };
    if (path === '/pos/unmatched') return { data: unmatched, isLoading: false, isError: false };
    if (path === '/pos/presets') return { data: [preset('evotor', 'Эвотор', 'Подключите приложение Эвотор'), preset('frontol', 'Фронтол', 'Фронтол выгружает файлом')], isLoading: false, isError: false };
    if (path === '/locations') return { data: [{ id: 'l1', name: 'Магазин «Центр»', isActive: true }], isLoading: false, isError: false };
    if (path === '/dishes') return { data: [{ id: 'd1', name: 'Борщ', isActive: true }], isLoading: false, isError: false };
    return { data: [], isLoading: false, isError: false };
  },
  useAction: (fn: (v: never) => Promise<unknown>) => ({
    isPending: false,
    mutate: (vars: never, opts?: { onSuccess?: (r: unknown) => void; onError?: (e: unknown) => void }) => {
      fn(vars).then((r) => opts?.onSuccess?.(r), (e) => opts?.onError?.(e));
    },
  }),
}));
vi.mock('../../components/Toast/Toast', () => ({ useToast: () => toast }));
vi.mock('../../components/Toast/Confirm', () => ({ useConfirm: () => vi.fn() }));
vi.mock('../../components/ProductPicker/ProductPicker', () => ({ ProductPicker: () => <input aria-label="Продукт" /> }));

import { PosPanel } from './PosPanel';

const conn = (over: Partial<PosConnectionDto> = {}): PosConnectionDto => ({
  id: 'k1',
  name: 'Касса 1',
  keyPrefix: 'zk_abcdefgh',
  locationId: 'l1',
  locationName: 'Магазин «Центр»',
  vendor: 'evotor',
  rules: preset('evotor', '', '').rules,
  createdAt: '2026-10-12T09:00:00.000Z',
  lastUsedAt: null,
  revokedAt: null,
  counts: { done: 12, pending: 2, rejected: 1, returns: 3 },
  ...over,
});

beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
    this.removeAttribute('open');
  };
  for (const f of [post, put, ...Object.values(toast)]) f.mockReset();
  conns = [];
  unmatched = [];
});
afterEach(cleanup);

describe('панель касс', () => {
  it('показывает кассу с типом, точкой и счётчиками чеков', () => {
    conns = [conn()];
    render(<PosPanel />);
    const row = screen.getByText('Касса 1').closest('tr') as HTMLElement;
    expect(within(row).getByText('Эвотор')).toBeTruthy();
    expect(within(row).getByText('Магазин «Центр»')).toBeTruthy();
    expect(within(row).getByText(/ждут сопоставления: 2/)).toBeTruthy();
    expect(within(row).getByText(/отклонено: 1/)).toBeTruthy();
    expect(within(row).getByText('не было')).toBeTruthy();
  });

  it('мастер подключения подсказывает, что делать для выбранной кассы, и создаёт подключение', async () => {
    post.mockResolvedValue({ ...conn(), key: 'zk_abcdefgh_секрет' });
    render(<PosPanel />);
    fireEvent.click(screen.getByRole('button', { name: /Подключить кассу/ }));
    expect(screen.getByText('Подключите приложение Эвотор')).toBeTruthy();
    fireEvent.change(screen.getByLabelText(/Касса или кассовая программа/), { target: { value: 'frontol' } });
    expect(screen.getByText('Фронтол выгружает файлом')).toBeTruthy();
    fireEvent.change(screen.getByLabelText(/Название/), { target: { value: 'Касса 2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Далее' }));
    await vi.waitFor(() => expect(post).toHaveBeenCalledWith('/pos/connections', { name: 'Касса 2', locationId: 'l1', vendor: 'frontol' }));
    expect(await screen.findByText('Касса подключена')).toBeTruthy();
    expect((screen.getByLabelText('Ключ') as HTMLInputElement).value).toBe('zk_abcdefgh_секрет');
  });

  it('без названия мастер не отправляет запрос', () => {
    render(<PosPanel />);
    fireEvent.click(screen.getByRole('button', { name: /Подключить кассу/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Далее' }));
    expect(screen.getByText(/Назовите кассу/)).toBeTruthy();
    expect(post).not.toHaveBeenCalled();
  });

  it('неопознанную позицию можно сопоставить с блюдом, чеки доигрываются', async () => {
    unmatched = [{ ref: 'BORSCH', keyId: 'k1', connectionName: 'Касса 1', name: 'Борщ', receipts: 3, quantity: 5 }];
    put.mockResolvedValue({ replayed: 3 });
    render(<PosPanel />);
    fireEvent.click(screen.getByRole('button', { name: 'Сопоставить' }));
    fireEvent.change(screen.getByLabelText('Что это в «Запасе»'), { target: { value: 'dish' } });
    fireEvent.change(screen.getByLabelText(/Блюдо/), { target: { value: 'd1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }));
    await vi.waitFor(() => expect(put).toHaveBeenCalledWith('/pos/map', { keyId: 'k1', ref: 'BORSCH', entity: 'dish', entityId: 'd1' }));
    await vi.waitFor(() => expect(toast.success).toHaveBeenCalledWith('Сопоставлено, обработано чеков: 3'));
  });

  it('позицию можно пометить «не считать» без выбора продукта', async () => {
    unmatched = [{ ref: 'BAG', keyId: 'k1', connectionName: 'Касса 1', name: 'Пакет', receipts: 1, quantity: 1 }];
    put.mockResolvedValue({ replayed: 1 });
    render(<PosPanel />);
    fireEvent.click(screen.getByRole('button', { name: 'Сопоставить' }));
    fireEvent.change(screen.getByLabelText('Что это в «Запасе»'), { target: { value: 'ignore' } });
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }));
    await vi.waitFor(() => expect(put).toHaveBeenCalledWith('/pos/map', { keyId: 'k1', ref: 'BAG', entity: 'ignore' }));
  });
});
