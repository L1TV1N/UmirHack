import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let portal: string | null = null;

vi.mock('../../auth/AuthProvider', () => ({ useAuth: () => ({ status: 'anonymous', login: vi.fn(), sessionEnded: false }) }));
vi.mock('../../auth/ScopeProvider', () => ({ useScope: () => ({ selected: null }) }));
vi.mock('../../lib/usePortalLink', () => ({ usePortalLink: () => portal }));

import LoginPage from './LoginPage';

const show = () =>
  render(
    <MemoryRouter>
      <LoginPage />
    </MemoryRouter>,
  );

beforeEach(() => {
  portal = null;
});
afterEach(cleanup);

describe('экран входа', () => {
  it('кнопка «Отгрузка» ведёт в кабинет поставщика в этой же вкладке', () => {
    portal = 'https://litvinskiy-dev.ru/supplier';
    show();
    const link = screen.getByRole('link', { name: /Перейти в «Отгрузку»/ });
    expect(link.getAttribute('href')).toBe('https://litvinskiy-dev.ru/supplier');
    expect(link.getAttribute('target')).toBe('_self');
  });

  it('если кабинет не подключён, кнопки нет, а вход и регистрация на месте', () => {
    show();
    expect(screen.queryByRole('link', { name: /Отгрузк/ })).toBeNull();
    expect(screen.getByRole('button', { name: 'Войти' })).toBeTruthy();
    expect(screen.getByRole('link', { name: /Создать аккаунт организации/ })).toBeTruthy();
  });
});
