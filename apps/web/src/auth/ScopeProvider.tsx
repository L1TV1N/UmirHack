import type { LocationDto } from '@zapas/shared';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useGet } from '../api/hooks';
import { useAuth } from './AuthProvider';

const STORAGE_PREFIX = 'zapas.location.';

interface ScopeValue {
  locations: LocationDto[];
  activeLocations: LocationDto[];
  /** Выбранная точка: все экраны показывают данные только по ней. Пусто, пока человек не выбрал заведение. */
  selected: LocationDto | null;
  /** Идентификатор выбранной точки или пустая строка. */
  activeId: string;
  /** Для запросов: идентификатор выбранной точки. */
  locationId: string | undefined;
  choose(id: string): void;
  /** Вернуться к выбору заведения. */
  clear(): void;
  /** Прежнее имя выбора точки, чтобы не менять все вызовы. */
  setActive(id: string): void;
  nameOf(id: string): string;
  loading: boolean;
}

const Ctx = createContext<ScopeValue | null>(null);

// Выбор живёт в рамках вкладки: после нового входа заведение выбирают заново
function readStored(userId: string | undefined): string {
  if (!userId) return '';
  try {
    return sessionStorage.getItem(STORAGE_PREFIX + userId) ?? '';
  } catch {
    return '';
  }
}

export function ScopeProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const userId = user?.id;
  const query = useGet<LocationDto[]>('/locations', undefined, { enabled: Boolean(user), staleTime: 60_000 });
  const [stored, setStored] = useState(() => readStored(userId));

  useEffect(() => setStored(readStored(userId)), [userId]);

  const locations = useMemo(() => query.data ?? [], [query.data]);
  const activeLocations = useMemo(() => locations.filter((l) => l.isActive), [locations]);
  const selected = useMemo(() => activeLocations.find((l) => l.id === stored) ?? null, [activeLocations, stored]);
  // выбрали только что созданное заведение: список ещё обновляется, и пока он не пришёл, экран ждёт, а не возвращает к выбору
  const resolving = stored !== '' && selected === null && query.isFetching;

  const write = useCallback(
    (id: string) => {
      setStored(id);
      if (!userId) return;
      try {
        if (id) sessionStorage.setItem(STORAGE_PREFIX + userId, id);
        else sessionStorage.removeItem(STORAGE_PREFIX + userId);
      } catch {
        // хранилище недоступно: выбор просто не переживёт перезагрузку страницы
      }
    },
    [userId],
  );
  const choose = useCallback((id: string) => write(id), [write]);
  const clear = useCallback(() => write(''), [write]);
  const nameOf = useCallback((id: string) => locations.find((l) => l.id === id)?.name ?? '-', [locations]);

  const value = useMemo<ScopeValue>(
    () => ({
      locations,
      activeLocations,
      selected,
      activeId: selected?.id ?? '',
      locationId: selected?.id,
      choose,
      clear,
      setActive: choose,
      nameOf,
      loading: query.isLoading || resolving,
    }),
    [locations, activeLocations, selected, choose, clear, nameOf, query.isLoading, resolving],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useScope(): ScopeValue {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('ScopeProvider не подключён');
  return ctx;
}
