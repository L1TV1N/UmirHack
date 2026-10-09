import type { LocationDto } from '@zapas/shared';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useGet } from '../api/hooks';
import { useAuth } from './AuthProvider';

const STORAGE_KEY = 'zapas.location';

interface ScopeValue {
  locations: LocationDto[];
  activeLocations: LocationDto[];
  /** 'all' или идентификатор точки. */
  activeId: string;
  /** Для запросов: undefined означает «все доступные». */
  locationId: string | undefined;
  canSeeAll: boolean;
  setActive(id: string): void;
  nameOf(id: string): string;
  loading: boolean;
}

const Ctx = createContext<ScopeValue | null>(null);

function readStored(): string {
  try {
    return localStorage.getItem(STORAGE_KEY) ?? 'all';
  } catch {
    return 'all';
  }
}

export function ScopeProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const query = useGet<LocationDto[]>('/locations', undefined, { enabled: Boolean(user), staleTime: 60_000 });
  const [stored, setStored] = useState(readStored);

  const locations = useMemo(() => query.data ?? [], [query.data]);
  const activeLocations = useMemo(() => locations.filter((l) => l.isActive), [locations]);
  const canSeeAll = activeLocations.length > 1;

  const activeId = useMemo(() => {
    if (activeLocations.length === 1) return (activeLocations[0] as LocationDto).id;
    if (stored !== 'all' && activeLocations.some((l) => l.id === stored)) return stored;
    return 'all';
  }, [activeLocations, stored]);

  const loaded = query.data !== undefined;
  useEffect(() => {
    if (!loaded) return;
    try {
      localStorage.setItem(STORAGE_KEY, activeId);
    } catch {
      // хранилище недоступно, выбор просто не запомнится
    }
  }, [activeId, loaded]);

  const setActive = useCallback((id: string) => setStored(id), []);
  const nameOf = useCallback((id: string) => locations.find((l) => l.id === id)?.name ?? '—', [locations]);

  const value = useMemo<ScopeValue>(
    () => ({
      locations,
      activeLocations,
      activeId,
      locationId: activeId === 'all' ? undefined : activeId,
      canSeeAll,
      setActive,
      nameOf,
      loading: query.isLoading,
    }),
    [locations, activeLocations, activeId, canSeeAll, setActive, nameOf, query.isLoading],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useScope(): ScopeValue {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('ScopeProvider не подключён');
  return ctx;
}
