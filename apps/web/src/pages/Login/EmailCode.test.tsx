import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { EmailVerificationPendingDto } from '@zapas/shared';
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
      register: vi.fn(),
      verifyEmail: vi.fn(),
      resendEmail: vi.fn(),
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
import RegisterPage from './RegisterPage';

const pending = (over: Partial<EmailVerificationPendingDto> = {}): EmailVerificationPendingDto => ({
  emailVerificationRequired: true,
  email: 'owner@vkus.example',
  delivered: true,
  expiresIn: 900,
  resendAfter: 30,
  ...over,
});

async function registerToCodeStep(over: Partial<EmailVerificationPendingDto> = {}) {
  auth.register.mockResolvedValueOnce(pending(over));
  render(
    <MemoryRouter>
      <RegisterPage />
    </MemoryRouter>,
  );
  fireEvent.change(screen.getByLabelText(/Название организации/), { target: { value: 'ООО «Вкус»' } });
  fireEvent.change(screen.getByLabelText(/Ваше имя/), { target: { value: 'Орлова Наталья' } });
  fireEvent.change(screen.getByLabelText(/^Почта/), { target: { value: 'owner@vkus.example' } });
  fireEvent.change(screen.getByLabelText(/^Пароль/), { target: { value: 'Хорошая-длинная-фраза-91' } });
  fireEvent.change(screen.getByLabelText(/Повторите пароль/), { target: { value: 'Хорошая-длинная-фраза-91' } });
  fireEvent.click(screen.getByRole('button', { name: 'Создать аккаунт' }));
  await screen.findByText('Подтвердите почту');
}

beforeEach(() => {
  Object.values(auth).forEach((v) => typeof v === 'function' && 'mockReset' in v && (v as ReturnType<typeof vi.fn>).mockReset());
});
afterEach(cleanup);

describe('подтверждение почты', () => {
  it('после регистрации вместо входа открывается ввод кода, адрес назван', async () => {
    await registerToCodeStep();
    expect(screen.getByText(/код на owner@vkus.example/)).toBeTruthy();
    expect(screen.getByText(/15 минут/)).toBeTruthy();
  });

  it('код отправляется вместе с адресом, а цифры отделяются от остальных знаков', async () => {
    await registerToCodeStep();
    auth.verifyEmail.mockResolvedValueOnce(undefined);
    fireEvent.change(screen.getByLabelText(/Код из письма/), { target: { value: '12a3b45 6' } });
    fireEvent.click(screen.getByRole('button', { name: 'Подтвердить' }));
    await waitFor(() => expect(auth.verifyEmail).toHaveBeenCalledWith('owner@vkus.example', '123456'));
  });

  it('короткий код не уходит на сервер', async () => {
    await registerToCodeStep();
    fireEvent.change(screen.getByLabelText(/Код из письма/), { target: { value: '123' } });
    fireEvent.click(screen.getByRole('button', { name: 'Подтвердить' }));
    expect(await screen.findByText('Код состоит из 6 цифр')).toBeTruthy();
    expect(auth.verifyEmail).not.toHaveBeenCalled();
  });

  it('неверный код показывает ответ сервера и очищает поле', async () => {
    await registerToCodeStep();
    auth.verifyEmail.mockRejectedValueOnce(new FakeApiError(401, 'invalid_code', 'Неверный код. Осталось попыток: 4'));
    const field = screen.getByLabelText(/Код из письма/) as HTMLInputElement;
    fireEvent.change(field, { target: { value: '111111' } });
    fireEvent.click(screen.getByRole('button', { name: 'Подтвердить' }));
    expect(await screen.findByText('Неверный код. Осталось попыток: 4')).toBeTruthy();
    expect(field.value).toBe('');
  });

  it('повторная отправка доступна после паузы, до неё кнопка заблокирована', async () => {
    await registerToCodeStep();
    const again = screen.getByRole('button', { name: /Отправить ещё раз через/ });
    expect((again as HTMLButtonElement).disabled).toBe(true);
  });

  it('если письмо не ушло, об этом сказано сразу', async () => {
    await registerToCodeStep({ delivered: false });
    expect(screen.getByText(/Письмо не удалось отправить/)).toBeTruthy();
  });

  it('вход с неподтверждённой почтой тоже ведёт к вводу кода, а «Назад» возвращает к паролю', async () => {
    auth.login.mockResolvedValueOnce(pending());
    render(
      <MemoryRouter>
        <LoginPage />
      </MemoryRouter>,
    );
    fireEvent.change(screen.getByLabelText('Почта'), { target: { value: 'owner@vkus.example' } });
    fireEvent.change(screen.getByLabelText('Пароль'), { target: { value: 'Хорошая-длинная-фраза-91' } });
    fireEvent.click(screen.getByRole('button', { name: 'Войти' }));
    await screen.findByText('Подтвердите почту');
    fireEvent.click(screen.getByRole('button', { name: 'Назад' }));
    expect(await screen.findByText('Вход в систему')).toBeTruthy();
  });
});
