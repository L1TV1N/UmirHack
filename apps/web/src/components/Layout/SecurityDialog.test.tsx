import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { TwoFactorStatusDto } from '@zapas/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const post = vi.fn();
const toast = { success: vi.fn(), error: vi.fn(), info: vi.fn() };
let status: TwoFactorStatusDto;

vi.mock('../../api/client', () => ({ post: (...a: unknown[]) => post(...a) }));
vi.mock('../../api/hooks', () => ({
  useGet: () => ({ data: status, isLoading: false, isError: false, refetch: vi.fn() }),
  useAction: (fn: (v: never) => Promise<unknown>) => ({
    isPending: false,
    mutate: (vars: never, opts?: { onSuccess?: (r: unknown) => void; onError?: (e: unknown) => void }) => {
      fn(vars).then((r) => opts?.onSuccess?.(r), (e) => opts?.onError?.(e));
    },
  }),
}));
vi.mock('../Toast/Toast', () => ({ useToast: () => toast }));

import { SecurityDialog } from './SecurityDialog';

const base: TwoFactorStatusDto = { eligible: true, botConfigured: true, telegramLinked: true, enabled: false, enabledAt: null, recoveryCodesLeft: 0 };

beforeEach(() => {
  post.mockReset();
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
    this.removeAttribute('open');
  };
});
afterEach(cleanup);

const show = () => render(<SecurityDialog open onClose={() => undefined} />);

describe('окно «Безопасность»', () => {
  it('без привязанного Telegram предлагает сначала его привязать', () => {
    status = { ...base, telegramLinked: false };
    show();
    expect(screen.getByText(/Сначала привяжите Telegram/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Включить' })).toBeNull();
  });

  it('без бота на сервере объясняет, что включить нельзя', () => {
    status = { ...base, botConfigured: false };
    show();
    expect(screen.getByText(/Бот Telegram не подключён к серверу/)).toBeTruthy();
  });

  it('включение: код из Telegram, затем резервные коды, закрыть окно кодов можно только после отметки', async () => {
    status = base;
    post.mockResolvedValueOnce({ challengeId: 'c1', delivered: true, expiresIn: 300, resendAfter: 30 });
    post.mockResolvedValueOnce({ enabled: true, recoveryCodes: ['ABCDEFGHJK', 'LMNPQRSTUV'] });
    show();
    fireEvent.click(screen.getByRole('button', { name: 'Включить' }));
    await screen.findByText(/Код отправлен в Telegram/);
    expect(post).toHaveBeenCalledWith('/auth/2fa/start', { purpose: 'enable' });

    fireEvent.change(screen.getByLabelText(/Код/), { target: { value: '123456' } });
    fireEvent.click(screen.getByRole('button', { name: 'Подтвердить' }));
    await waitFor(() => expect(post).toHaveBeenCalledWith('/auth/2fa/confirm', { challengeId: 'c1', code: '123456' }));

    await screen.findByText('ABCDE-FGHJK');
    expect(screen.getByText('LMNPQ-RSTUV')).toBeTruthy();
    const done = screen.getByRole('button', { name: 'Готово' }) as HTMLButtonElement;
    expect(done.disabled).toBe(true);
    fireEvent.click(screen.getByLabelText(/Я сохранил коды/));
    expect(done.disabled).toBe(false);
  });

  it('включённая защита: показывает остаток резервных кодов, отключение требует пароль', async () => {
    status = { ...base, enabled: true, enabledAt: '2026-10-14T10:00:00.000Z', recoveryCodesLeft: 1 };
    post.mockResolvedValueOnce({ challengeId: 'c2', delivered: true, expiresIn: 300, resendAfter: 30 });
    show();
    expect(screen.getByText(/Подтверждение входа включено/)).toBeTruthy();
    expect(screen.getByText(/Выпустите новые/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Отключить' }));
    fireEvent.change(await screen.findByLabelText(/Пароль/), { target: { value: 'мой-пароль-1234' } });
    fireEvent.click(screen.getByRole('button', { name: 'Получить код' }));
    await waitFor(() => expect(post).toHaveBeenCalledWith('/auth/2fa/start', { purpose: 'disable', password: 'мой-пароль-1234' }));
  });
});
