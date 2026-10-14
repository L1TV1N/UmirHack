import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { LocationDto } from '@zapas/shared';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const choose = vi.fn();
const logout = vi.fn();
let role = 'admin';
let locations: LocationDto[] = [];

vi.mock('../../auth/AuthProvider', () => ({
  useAuth: () => ({
    user: { id: 'u1', fullName: 'Орлов Дмитрий', role, organizationName: 'Группа «Набережная»' },
    can: (min: string) => role === 'admin' || min !== 'admin',
    logout,
  }),
}));
vi.mock('../../auth/ScopeProvider', () => ({
  useScope: () => ({ loading: false, activeLocations: locations, selected: null, choose, clear: vi.fn() }),
}));
vi.mock('../../components/LocationDialog/NewLocationDialog', () => ({ NewLocationDialog: ({ open }: { open: boolean }) => (open ? <div role="dialog">Новое заведение</div> : null) }));

import SelectLocationPage from './SelectLocationPage';

const loc = (id: string, name: string, kind: LocationDto['kind']): LocationDto => ({ id, code: id, name, kind, address: null, latitude: null, longitude: null, isActive: true });

const show = () =>
  render(
    <MemoryRouter initialEntries={['/select']}>
      <Routes>
        <Route path="/select" element={<SelectLocationPage />} />
        <Route path="/" element={<div>Обзор</div>} />
        <Route path="/waiter" element={<div>Экран официанта</div>} />
      </Routes>
    </MemoryRouter>,
  );

beforeEach(() => {
  role = 'admin';
  locations = [loc('k', 'Кухня «Набережная»', 'kitchen'), loc('w', 'Склад Ростов', 'warehouse')];
  choose.mockReset();
});
afterEach(cleanup);

describe('выбор заведения', () => {
  it('показывает заведения организации с их типом', () => {
    show();
    expect(screen.getByRole('heading', { name: 'Выберите заведение' })).toBeTruthy();
    expect(screen.getByText('Кухня «Набережная»')).toBeTruthy();
    expect(screen.getByText('Ресторан')).toBeTruthy();
    expect(screen.getByText('Склад')).toBeTruthy();
    expect(screen.getByText(/Группа «Набережная»/)).toBeTruthy();
  });

  it('открытие заведения запоминает выбор и ведёт в приложение', () => {
    show();
    fireEvent.click(screen.getByText('Склад Ростов'));
    expect(choose).toHaveBeenCalledWith('w');
    expect(screen.getByText('Обзор')).toBeTruthy();
  });

  it('официанта после выбора ведут на его экран', () => {
    role = 'waiter';
    show();
    fireEvent.click(screen.getByText('Кухня «Набережная»'));
    expect(screen.getByText('Экран официанта')).toBeTruthy();
  });

  it('администратор может добавить заведение, остальные нет', () => {
    show();
    fireEvent.click(screen.getByText('Добавить заведение'));
    expect(screen.getByRole('dialog')).toBeTruthy();
    cleanup();
    role = 'manager';
    show();
    expect(screen.queryByText('Добавить заведение')).toBeNull();
  });

  it('если заведений нет, объясняет, что делать', () => {
    locations = [];
    show();
    expect(screen.getByText(/пока нет заведений/)).toBeTruthy();
    cleanup();
    role = 'storekeeper';
    show();
    expect(screen.getByText(/не назначено ни одного заведения/)).toBeTruthy();
  });
});
