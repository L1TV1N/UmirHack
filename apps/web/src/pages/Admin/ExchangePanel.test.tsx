import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { ExchangePresetDto, ExternalSystemDto } from '@zapas/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const post = vi.fn();
const toast = { success: vi.fn(), error: vi.fn(), info: vi.fn() };
let systems: ExternalSystemDto[] = [];

const profile = {
  preset: 'bp3',
  odataPath: '/odata/standard.odata',
  post: true,
  catalogs: { product: { entity: 'Catalog_Номенклатура', codeField: 'Артикул', nameField: 'Description' } },
  documents: {},
} as unknown as ExternalSystemDto['profile'];

vi.mock('../../api/client', () => ({
  ApiError: class extends Error {},
  post: (...a: unknown[]) => post(...a),
  put: vi.fn(),
  patch: vi.fn(),
  del: vi.fn(),
  get: vi.fn(),
}));
vi.mock('../../api/hooks', () => ({
  useGet: (path: string) => {
    if (path === '/exchange/systems') return { data: systems, isLoading: false, isError: false };
    if (path === '/exchange/presets') return { data: [{ preset: 'bp3', label: '1С:Бухгалтерия предприятия 3.0', profile }, { preset: 'retail3', label: '1С:Розница 3', profile }] as ExchangePresetDto[], isLoading: false, isError: false };
    if (path === '/locations') return { data: [{ id: 'l1', name: 'Магазин «Центр»', isActive: true }], isLoading: false, isError: false };
    if (path.endsWith('/unlinked')) return { data: [{ entity: 'product', localId: 'p1', name: 'Молоко 3,2%', code: 'MLK-001' }], isLoading: false, isError: false, isSuccess: true, refetch: vi.fn() };
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

import { ExchangePanel } from './ExchangePanel';

const system = (over: Partial<ExternalSystemDto> = {}): ExternalSystemDto => ({
  id: 's1',
  kind: 'onec',
  name: 'Бухгалтерия',
  baseUrl: 'https://1c.example.ru/base',
  username: 'zapas',
  hasPassword: true,
  profile,
  docKinds: ['receipt', 'writeoff'],
  locationId: null,
  locationName: null,
  enabled: true,
  lastOkAt: '2026-10-12T09:00:00.000Z',
  lastError: null,
  createdAt: '2026-10-12T08:00:00.000Z',
  counts: { pending: 1, blocked: 2, failed: 0, done: 14 },
  ...over,
});

beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
    this.removeAttribute('open');
  };
  for (const f of [post, ...Object.values(toast)]) f.mockReset();
  systems = [];
});
afterEach(cleanup);

describe('панель учётных систем', () => {
  it('показывает состояние, виды документов и очередь', () => {
    systems = [system()];
    render(<ExchangePanel />);
    const row = screen.getByText('Бухгалтерия').closest('tr') as HTMLElement;
    expect(within(row).getByText('Работает')).toBeTruthy();
    expect(within(row).getByText(/Приход, Списание/)).toBeTruthy();
    expect(within(row).getByText(/ждут связей: 2/)).toBeTruthy();
    expect(within(row).getByRole('button', { name: /Что связать \(2\)/ })).toBeTruthy();
  });

  it('ошибку последней выгрузки видно рядом с системой', () => {
    systems = [system({ lastError: '1С отклонила логин или пароль' })];
    render(<ExchangePanel />);
    expect(screen.getByText('Есть ошибка')).toBeTruthy();
    expect(screen.getByText('1С отклонила логин или пароль')).toBeTruthy();
  });

  it('«Что связать» показывает то, чего не хватает 1С', () => {
    systems = [system()];
    render(<ExchangePanel />);
    fireEvent.click(screen.getByRole('button', { name: /Что связать/ }));
    expect(screen.getByText('Молоко 3,2%')).toBeTruthy();
    expect(screen.getByText(/артикул MLK-001/)).toBeTruthy();
    expect(screen.getByRole('button', { name: /Связать по артикулу автоматически/ })).toBeTruthy();
  });

  it('форма подключения проверяет поля до отправки', () => {
    render(<ExchangePanel />);
    fireEvent.click(screen.getByRole('button', { name: /Подключить 1С/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Подключить' }));
    expect(screen.getByText(/Назовите подключение/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText(/Название/), { target: { value: 'Бухгалтерия' } });
    fireEvent.click(screen.getByRole('button', { name: 'Подключить' }));
    expect(screen.getByText(/Укажите адрес сервера 1С/)).toBeTruthy();
    expect(post).not.toHaveBeenCalled();
  });

  it('испорченное сопоставление не уходит на сервер', () => {
    render(<ExchangePanel />);
    fireEvent.click(screen.getByRole('button', { name: /Подключить 1С/ }));
    fireEvent.change(screen.getByLabelText(/Название/), { target: { value: 'Бухгалтерия' } });
    fireEvent.change(screen.getByLabelText(/Адрес сервера 1С/), { target: { value: 'https://1c.example.ru' } });
    fireEvent.change(screen.getByLabelText('Сопоставление в формате JSON'), { target: { value: '{ не json' } });
    fireEvent.click(screen.getByRole('button', { name: 'Подключить' }));
    expect(screen.getByText(/не в формате JSON/)).toBeTruthy();
    expect(post).not.toHaveBeenCalled();
  });

  it('при верных данных отправляет подключение с выбранными документами', async () => {
    post.mockResolvedValue(system());
    render(<ExchangePanel />);
    fireEvent.click(screen.getByRole('button', { name: /Подключить 1С/ }));
    fireEvent.change(screen.getByLabelText(/Название/), { target: { value: 'Бухгалтерия' } });
    fireEvent.change(screen.getByLabelText(/Адрес сервера 1С/), { target: { value: 'https://1c.example.ru' } });
    fireEvent.change(screen.getByLabelText(/Пользователь 1С/), { target: { value: 'zapas' } });
    fireEvent.click(screen.getByRole('button', { name: 'Подключить' }));
    await vi.waitFor(() => expect(post).toHaveBeenCalled());
    const [url, body] = post.mock.calls[0] as [string, Record<string, unknown>];
    expect(url).toBe('/exchange/systems');
    expect(body).toMatchObject({ kind: 'onec', name: 'Бухгалтерия', baseUrl: 'https://1c.example.ru', username: 'zapas', docKinds: ['receipt', 'writeoff', 'transfer'], locationId: null });
  });
});
