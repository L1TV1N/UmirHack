import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ImportPreviewDto } from '@zapas/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../api/client';

const post = vi.fn();
const toast = { success: vi.fn(), error: vi.fn(), info: vi.fn() };

vi.mock('../../api/client', () => ({ post: (...a: unknown[]) => post(...a), ApiError: class extends Error {} }));
vi.mock('../../api/hooks', () => ({
  useAction: (fn: (v: object) => Promise<unknown>) => ({
    isPending: false,
    mutate: (vars: object, opts?: { onSuccess?: (r: unknown) => void; onError?: (e: unknown) => void }) => {
      fn(vars).then((r) => opts?.onSuccess?.(r), (e) => opts?.onError?.(e));
    },
  }),
}));
vi.mock('../../components/Toast/Toast', () => ({ useToast: () => toast }));

import { ImportDialog } from './ImportDialog';

const preview = (over: Partial<ImportPreviewDto> = {}): ImportPreviewDto => ({
  encoding: 'utf-8',
  delimiter: ';',
  columns: [
    { header: 'Код', field: 'sku' },
    { header: 'Наименование', field: 'name' },
    { header: 'Комментарий', field: null },
  ],
  total: 3,
  create: 1,
  update: 1,
  skip: 0,
  errors: 1,
  newCategories: ['Выпечка'],
  rows: [
    { line: 4, action: 'error', sku: 'X-3', name: 'Плохая', changes: [], messages: ['Единица «пачка» не распознана: нужны кг, л или шт'] },
    { line: 2, action: 'create', sku: 'N-1', name: 'Булочка', changes: ['новый продукт'], messages: ['Категория «Выпечка» будет создана'] },
    { line: 3, action: 'update', sku: 'K-1', name: 'Кефир', changes: ['цена: 90 → 99'], messages: [] },
  ],
  ...over,
});

const BODY = 'Код;Наименование\nN-1;Булочка';
const b64 = (text: string) => Buffer.from(text).toString('base64');
const csv = (name = 'goods.csv', body = 'Код;Наименование\nN-1;Булочка') => new File([body], name, { type: 'text/csv' });
const pick = async (file: File) => {
  const input = document.querySelector('input[type="file"]') as HTMLInputElement;
  Object.defineProperty(input, 'files', { value: [file], configurable: true });
  fireEvent.change(input);
};

beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
    this.removeAttribute('open');
  };
  post.mockReset();
  Object.values(toast).forEach((f) => f.mockReset());
  // jsdom не умеет читать файл через arrayBuffer
  File.prototype.arrayBuffer = function arrayBuffer(this: File) {
    return new Promise<ArrayBuffer>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as ArrayBuffer);
      reader.onerror = () => reject(reader.error);
      reader.readAsArrayBuffer(this);
    });
  };
});
afterEach(cleanup);

describe('импорт номенклатуры', () => {
  it('отправляет файл в base64 на просмотр, показывает итоги, ошибки и распознанные колонки', async () => {
    post.mockResolvedValueOnce(preview());
    render(<ImportDialog open onClose={() => undefined} />);
    await pick(csv());
    expect(await screen.findByText('новых: 1')).toBeTruthy();
    expect(post).toHaveBeenCalledWith('/products/import/preview', { content: b64(BODY), createCategories: true });
    expect(screen.getByText('изменится: 1')).toBeTruthy();
    expect(screen.getByText(/с ошибками: 1, они пропустятся/)).toBeTruthy();
    expect(screen.getByText(/новые категории: Выпечка/)).toBeTruthy();
    expect(screen.getByText(/«Код» как артикул/)).toBeTruthy();
    expect(screen.getByText(/Не используются: «Комментарий»/)).toBeTruthy();
    expect(screen.getByText(/Единица «пачка» не распознана/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Применить: новых 1, изменится 1' })).toBeTruthy();
  });

  it('смена галочки про категории пересчитывает просмотр с теми же данными', async () => {
    post.mockResolvedValue(preview());
    render(<ImportDialog open onClose={() => undefined} />);
    await pick(csv());
    await screen.findByText('новых: 1');
    fireEvent.click(screen.getByLabelText('Создавать новые категории'));
    await waitFor(() => expect(post).toHaveBeenCalledTimes(2));
    expect(post).toHaveBeenLastCalledWith('/products/import/preview', { content: b64(BODY), createCategories: false });
  });

  it('применение отправляет тот же файл, закрывает окно и сообщает итог', async () => {
    post.mockResolvedValueOnce(preview()).mockResolvedValueOnce({ created: 1, updated: 1, skipped: 1, categoriesCreated: 1 });
    const onClose = vi.fn();
    render(<ImportDialog open onClose={onClose} />);
    await pick(csv());
    fireEvent.click(await screen.findByRole('button', { name: /Применить: новых 1/ }));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Создано 1, изменено 1, пропущено 1'));
    expect(post).toHaveBeenLastCalledWith('/products/import', { content: b64(BODY), createCategories: true });
    expect(onClose).toHaveBeenCalled();
  });

  it('когда применять нечего, кнопка выключена', async () => {
    post.mockResolvedValueOnce(preview({ create: 0, update: 0, skip: 2, errors: 0, newCategories: [], rows: [] }));
    render(<ImportDialog open onClose={() => undefined} />);
    await pick(csv());
    await screen.findByText('без изменений: 2');
    expect((screen.getByRole('button', { name: /Применить/ }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('ошибка сервера показывается человеку, предпросмотра нет', async () => {
    post.mockRejectedValueOnce(new (ApiError as unknown as new (message: string) => Error)('Не нашли колонку с артикулом'));
    render(<ImportDialog open onClose={() => undefined} />);
    await pick(csv());
    expect(await screen.findByText(/Не нашли колонку с артикулом/)).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Применить' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('слишком большой файл не уходит на сервер', async () => {
    render(<ImportDialog open onClose={() => undefined} />);
    const big = csv('big.csv', 'x');
    Object.defineProperty(big, 'size', { value: 2_000_001 });
    await pick(big);
    expect(await screen.findByText(/Файл больше 2 МБ/)).toBeTruthy();
    expect(post).not.toHaveBeenCalled();
  });
});
