import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { TwoFactorChallengeDto } from '@zapas/shared';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { FakeApiError, auth } = vi.hoisted(() => {
  class FakeApiError extends Error {
    constructor(
      public status: number,
      public code: string,
      message: string,
    ) {
      super(message);
    }
  }
  return {
    FakeApiError,
    auth: {
      status: 'anonymous',
      sessionEnded: false,
      login: vi.fn(),
      verifyTwoFactor: vi.fn(),
      resendTwoFactor: vi.fn(),
    },
  };
});

vi.mock('../../api/client', () => ({ ApiError: FakeApiError }));
vi.mock('../../auth/AuthProvider', () => ({ useAuth: () => auth }));
vi.mock('../../auth/ScopeProvider', () => ({ useScope: () => ({ selected: null }) }));
vi.mock('../../lib/usePortalLink', () => ({ usePortalLink: () => null }));

import LoginPage from './LoginPage';

const challenge = (over: Partial<TwoFactorChallengeDto> = {}): TwoFactorChallengeDto => ({
  twoFactorRequired: true,
  challengeId: '11111111-1111-4111-8111-111111111111',
  delivered: true,
  expiresIn: 300,
  resendAfter: 30,
  ...over,
});

async function toCodeStep(over: Partial<TwoFactorChallengeDto> = {}) {
  auth.login.mockResolvedValueOnce(challenge(over));
  render(
    <MemoryRouter>
      <LoginPage />
    </MemoryRouter>,
  );
  fireEvent.change(screen.getByLabelText('Почта'), { target: { value: 'admin@zapas.local' } });
  fireEvent.change(screen.getByLabelText('Пароль'), { target: { value: 'какой-то-пароль' } });
  fireEvent.click(screen.getByRole('button', { name: 'Войти' }));
  await screen.findByText('Подтвердите вход');
}

beforeEach(() => {
  Object.values(auth).forEach((v) => typeof v === 'function' && 'mockReset' in v && (v as ReturnType<typeof vi.fn>).mockReset());
});
afterEach(cleanup);

describe('второй шаг входа администратора', () => {
  it('после пароля просит код, а пароль не остаётся в форме', async () => {
    await toCodeStep();
    expect(screen.getByText(/отправили код в ваш Telegram/)).toBeTruthy();
    expect(screen.queryByLabelText('Пароль')).toBeNull();
    expect(auth.verifyTwoFactor).not.toHaveBeenCalled();
  });

  it('отправляет введённый код вместе с идентификатором запроса', async () => {
    auth.verifyTwoFactor.mockResolvedValueOnce(undefined);
    await toCodeStep();
    fireEvent.change(screen.getByLabelText(/Код из Telegram/), { target: { value: ' 123456 ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Подтвердить' }));
    await waitFor(() => expect(auth.verifyTwoFactor).toHaveBeenCalledWith('11111111-1111-4111-8111-111111111111', '123456'));
  });

  it('неверный код: сообщение на месте, поле очищено, можно ввести снова', async () => {
    auth.verifyTwoFactor.mockRejectedValueOnce(new FakeApiError(401, 'invalid_code', 'Неверный код. Осталось попыток: 4'));
    await toCodeStep();
    const input = screen.getByLabelText(/Код из Telegram/) as HTMLInputElement;
    fireEvent.change(input, { target: { value: '000000' } });
    fireEvent.click(screen.getByRole('button', { name: 'Подтвердить' }));
    expect((await screen.findByRole('alert')).textContent).toContain('Осталось попыток: 4');
    expect(input.value).toBe('');
  });

  it('запрос закрыт: возвращает к вводу пароля с объяснением', async () => {
    auth.verifyTwoFactor.mockRejectedValueOnce(new FakeApiError(401, 'challenge_exhausted', 'Слишком много неверных кодов. Войдите заново.'));
    await toCodeStep();
    fireEvent.change(screen.getByLabelText(/Код из Telegram/), { target: { value: '000000' } });
    fireEvent.click(screen.getByRole('button', { name: 'Подтвердить' }));
    expect((await screen.findByRole('alert')).textContent).toContain('Войдите заново');
    expect(screen.getByLabelText('Пароль')).toBeTruthy();
  });

  it('если код в Telegram не ушёл, предлагает резервный код', async () => {
    await toCodeStep({ delivered: false });
    expect(screen.getByText(/Не удалось отправить код в Telegram/)).toBeTruthy();
  });

  it('повторная отправка недоступна, пока не прошло время ожидания', async () => {
    await toCodeStep();
    const resend = screen.getByRole('button', { name: /Отправить ещё раз через/ }) as HTMLButtonElement;
    expect(resend.disabled).toBe(true);
  });

  it('«Назад» возвращает к паролю без ошибки', async () => {
    await toCodeStep();
    fireEvent.click(screen.getByRole('button', { name: 'Назад' }));
    expect(await screen.findByLabelText('Пароль')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
