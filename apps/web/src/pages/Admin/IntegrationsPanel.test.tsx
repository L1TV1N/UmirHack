import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { WebhookDto } from '@zapas/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const post = vi.fn();
const del = vi.fn();
const patch = vi.fn();
const toast = { success: vi.fn(), error: vi.fn(), info: vi.fn() };
const confirm = vi.fn();
let hooks: WebhookDto[] = [];

vi.mock('../../api/client', () => ({
  ApiError: class extends Error {
    fieldErrors() {
      return {};
    }
  },
  post: (...a: unknown[]) => post(...a),
  del: (...a: unknown[]) => del(...a),
  patch: (...a: unknown[]) => patch(...a),
}));
vi.mock('../../api/hooks', () => ({
  useGet: (path: string) => {
    if (path === '/integrations/webhooks') return { data: hooks, isLoading: false, isError: false };
    if (path === '/locations') return { data: [{ id: 'l1', name: 'Магазин «Центр»', isActive: true }], isLoading: false, isError: false };
    return { data: [], isLoading: false, isError: false };
  },
  useAction: (fn: (v: never) => Promise<unknown>) => ({
    isPending: false,
    mutate: (vars: never, opts?: { onSuccess?: (r: unknown) => void; onError?: (e: unknown) => void; onSettled?: () => void }) => {
      fn(vars).then((r) => opts?.onSuccess?.(r), (e) => opts?.onError?.(e)).finally(() => opts?.onSettled?.());
    },
  }),
}));
vi.mock('../../components/Toast/Toast', () => ({ useToast: () => toast }));
vi.mock('../../components/Toast/Confirm', () => ({ useConfirm: () => confirm }));

import { IntegrationsPanel } from './IntegrationsPanel';

const hook = (over: Partial<WebhookDto> = {}): WebhookDto => ({
  id: 'h1',
  name: 'Доставка',
  url: 'https://hooks.example.com/zapas?token=abc',
  events: ['stoplist.changed'],
  locationId: null,
  locationName: null,
  enabled: true,
  failureStreak: 0,
  disabledReason: null,
  lastSuccessAt: null,
  lastFailureAt: null,
  createdAt: '2026-10-09T09:00:00.000Z',
  ...over,
});

beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
    this.removeAttribute('open');
  };
  for (const f of [post, del, patch, confirm, ...Object.values(toast)]) f.mockReset();
  hooks = [];
});
afterEach(cleanup);

describe('адреса для событий', () => {
  it('показывает адреса, но не раскрывает строку запроса с токеном', () => {
    hooks = [hook(), hook({ id: 'h2', name: 'Касса', enabled: false, disabledReason: 'Отправка выключена: 5 доставок подряд не удались' })];
    render(<IntegrationsPanel />);
    expect(screen.getByText('Доставка')).toBeTruthy();
    expect(screen.getAllByText('hooks.example.com').length).toBe(2);
    expect(screen.queryByText(/token=abc/)).toBeNull();
    expect(screen.getByText('Работает')).toBeTruthy();
    expect(screen.getByText('Выключен')).toBeTruthy();
    expect(screen.getByText(/5 доставок подряд не удались/)).toBeTruthy();
  });

  it('создание: секрет показывается один раз и пропадает после закрытия', async () => {
    post.mockResolvedValueOnce({ ...hook(), secret: 'whsec_TESTSECRET' });
    render(<IntegrationsPanel />);
    fireEvent.click(screen.getByRole('button', { name: /Добавить адрес/ }));
    fireEvent.change(screen.getByLabelText(/Название/), { target: { value: 'Яндекс Еда' } });
    fireEvent.change(screen.getByLabelText(/Адрес приёмника/), { target: { value: 'https://example.ru/hook' } });
    fireEvent.click(screen.getByRole('button', { name: 'Создать' }));
    await waitFor(() => expect(post).toHaveBeenCalledWith('/integrations/webhooks', { name: 'Яндекс Еда', url: 'https://example.ru/hook', events: ['stoplist.changed', 'order.sent'], locationId: null }));
    const secret = (await screen.findByLabelText('Секрет')) as HTMLInputElement;
    expect(secret.value).toBe('whsec_TESTSECRET');
    fireEvent.click(screen.getByRole('button', { name: 'Я сохранил секрет' }));
    await waitFor(() => expect(screen.queryByLabelText('Секрет')).toBeNull());
  });

  it('пустая форма не уходит на сервер и подсказывает, что заполнить', async () => {
    render(<IntegrationsPanel />);
    fireEvent.click(screen.getByRole('button', { name: /Добавить адрес/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Создать' }));
    expect(await screen.findByText(/Назовите адрес/)).toBeTruthy();
    expect(screen.getByText('Укажите адрес приёмника')).toBeTruthy();
    expect(post).not.toHaveBeenCalled();
  });

  it('нельзя снять все события', async () => {
    render(<IntegrationsPanel />);
    fireEvent.click(screen.getByRole('button', { name: /Добавить адрес/ }));
    fireEvent.change(screen.getByLabelText(/Название/), { target: { value: 'X' } });
    fireEvent.change(screen.getByLabelText(/Адрес приёмника/), { target: { value: 'https://example.ru/hook' } });
    fireEvent.click(screen.getByLabelText('Стоп-лист изменился'));
    fireEvent.click(screen.getByLabelText('Заказ поставщику отправлен'));
    fireEvent.click(screen.getByRole('button', { name: 'Создать' }));
    expect(await screen.findByText('Выберите хотя бы одно событие')).toBeTruthy();
    expect(post).not.toHaveBeenCalled();
  });

  it('проверка связи сообщает, дошло ли событие и почему нет', async () => {
    hooks = [hook()];
    post.mockResolvedValueOnce({ id: 'd1', event: 'ping', status: 'delivered', attempts: 1, lastStatus: 200, lastError: null, createdAt: '', deliveredAt: '', nextAttemptAt: null });
    render(<IntegrationsPanel />);
    fireEvent.click(screen.getByRole('button', { name: /Проверить/ }));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Приёмник ответил: код 200'));
    expect(post).toHaveBeenCalledWith('/integrations/webhooks/h1/test');

    post.mockResolvedValueOnce({ id: 'd2', event: 'ping', status: 'failed', attempts: 1, lastStatus: null, lastError: 'соединение отклонено', createdAt: '', deliveredAt: null, nextAttemptAt: null });
    fireEvent.click(screen.getByRole('button', { name: /Проверить/ }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Не дошло: соединение отклонено'));
  });

  it('удаление и смена секрета требуют подтверждения', async () => {
    hooks = [hook()];
    confirm.mockResolvedValueOnce(false);
    render(<IntegrationsPanel />);
    fireEvent.click(screen.getByRole('button', { name: 'Удалить: Доставка' }));
    await waitFor(() => expect(confirm).toHaveBeenCalled());
    expect(del).not.toHaveBeenCalled();

    confirm.mockResolvedValueOnce(true);
    del.mockResolvedValueOnce(undefined);
    fireEvent.click(screen.getByRole('button', { name: 'Удалить: Доставка' }));
    await waitFor(() => expect(del).toHaveBeenCalledWith('/integrations/webhooks/h1'));

    confirm.mockResolvedValueOnce(true);
    post.mockResolvedValueOnce({ secret: 'whsec_NEW' });
    fireEvent.click(screen.getByRole('button', { name: 'Сменить секрет: Доставка' }));
    const field = (await screen.findByLabelText('Секрет')) as HTMLInputElement;
    expect(field.value).toBe('whsec_NEW');
    expect(within(document.body).getByText(/Сохраните его сейчас/)).toBeTruthy();
  });
});
